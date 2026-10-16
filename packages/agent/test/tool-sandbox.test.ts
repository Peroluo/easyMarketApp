/**
 * M3 ToolExecutor 沙箱接入测试（SANDBOX_PLAN §10-M3）：
 * - 未声明 sandbox 的工具零变化（直跑，不触达 provider）
 * - 声明 sandbox 的工具经 provider 执行（spec 解析/合并/回填、工厂形声明、
 *   beforeToolCall 改写 args 后路由、provider 事件透传 onSandboxEvent 遥测）
 * - 降级链：未配置 sandbox → inprocess 直跑 + degraded 告警；
 *   enforced 严格模式 → 能力不足直接 blocked（不降级）
 * - defaults 收紧：工具声明 inprocess 不可降级运行时基线 subprocess
 * - 权限裁决先于沙箱（deny 工具不触达 provider）
 * - provider.run 异常 → error 结果，run 不失败
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, createDenyAllPolicy, createTextContent, createToolHookExtension } from '../index.ts';
import type {
  StreamFn,
  StreamEvent,
  AssistantMessage,
  Tool,
  SandboxProvider,
  SandboxRunRequest,
  SandboxSpec,
  SandboxTelemetryInfo,
} from '../index.ts';

// ─── 测试脚手架 ──────────────────────────────────────────────────────

function mockToolStreamFn(
  toolCalls: Array<{ id: string; name: string; args: unknown }>,
): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    if (toolCalls.length > 0) {
      const tc = toolCalls.shift()!;
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.args as Record<string, unknown> },
        ],
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: assistant };
    } else {
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: assistant };
    }
  };
}

/** 直跑探针（记录执行次数） */
function makeProbeTool(name: string, extra?: Partial<Tool>): Tool & { calls: () => number } {
  let count = 0;
  return {
    name,
    description: name,
    parameters: {},
    async execute() {
      count++;
      return { content: [{ type: 'text', text: 'direct-ok' }], details: {} };
    },
    ...extra,
    calls: () => count,
  };
}

/** fake provider：记录 run 请求，返回固定结果；可选 supports 覆盖 */
function fakeProvider(overrides?: {
  supports?: (strategy: SandboxSpec['strategy']) => boolean;
  result?: () => Promise<{ content: { type: 'text'; text: string }[]; details: Record<string, unknown> }>;
}) {
  const calls: SandboxRunRequest[] = [];
  const provider: SandboxProvider = {
    async supports(strategy) {
      return overrides?.supports ? overrides.supports(strategy) : true;
    },
    async run(req) {
      calls.push(req);
      req.onEvent?.({
        type: 'spawn',
        toolName: req.toolName,
        toolCallId: req.toolCallId,
        strategy: req.spec.strategy,
      });
      return overrides?.result
        ? overrides.result()
        : { content: [{ type: 'text', text: 'sandboxed-ok' }], details: {} };
    },
  };
  return { provider, calls };
}

// ─── 路由行为 ────────────────────────────────────────────────────────

describe('ToolExecutor 沙箱路由', () => {
  it('未声明 sandbox 的工具直跑（provider 不触达）', async () => {
    const probe = makeProbeTool('plain_tool');
    const { provider, calls } = fakeProvider();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'plain_tool', args: {} }]),
      tools: [probe],
      permissionFailOpen: true,
      sandbox: { provider },
    });
    const result = await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(result.success, true);
    assert.equal(probe.calls(), 1, '未声明 sandbox 的工具应直跑');
    assert.equal(calls.length, 0, 'provider 不应被调用');
    await runtime.close();
  });

  it('声明 sandbox 的工具经 provider 执行：spec 回填 + 结果进消息链', async () => {
    const probe = makeProbeTool('boxed_tool', { sandbox: { strategy: 'subprocess' } });
    const { provider, calls } = fakeProvider();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'boxed_tool', args: { x: 1 } }]),
      tools: [probe],
      permissionFailOpen: true,
      workspace: '/ws/root',
      sandbox: { provider },
    });
    const result = await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(result.success, true);
    assert.equal(probe.calls(), 0, '声明 sandbox 的工具不应直跑');
    assert.equal(calls.length, 1);
    const req = calls[0];
    assert.equal(req.toolName, 'boxed_tool');
    assert.equal(req.toolCallId, 't1');
    assert.deepEqual(req.args, { x: 1 });
    // mergeSpec 完备回填：strategy/net/env 默认值 + workspace 回填 readable/writable
    assert.equal(req.spec.strategy, 'subprocess');
    assert.equal(req.spec.net.mode, 'deny');
    assert.deepEqual(req.spec.fs.readable, ['/ws/root']);
    assert.deepEqual(req.spec.fs.writable, ['/ws/root']);
    assert.deepEqual(req.spec.env, {});
    // provider 结果成为 toolResult 消息（正常配对）
    const msgs = runtime.getMessages();
    const toolResult = msgs.find(m => m.role === 'toolResult') as { content: { text: string }[] };
    assert.ok(toolResult, '应生成 toolResult 消息');
    assert.equal(toolResult.content[0].text, 'sandboxed-ok');
    await runtime.close();
  });

  it('工厂形声明：args 与 workspace 传入工厂，产出进 spec', async () => {
    const probe = makeProbeTool('dyn_tool', {
      sandbox: (args, ctx) => ({
        env: { TARGET: String((args as { target?: string }).target) },
        fs: { readable: [`${ctx.workspace}/data`] },
      }),
    });
    const { provider, calls } = fakeProvider();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'dyn_tool', args: { target: 'abc' } }]),
      tools: [probe],
      permissionFailOpen: true,
      workspace: '/ws/root',
      sandbox: { provider },
    });
    await runtime.run({ message: 'hi', type: 'message' });
    const spec = calls[0].spec;
    assert.deepEqual(spec.env, { TARGET: 'abc' });
    assert.deepEqual(spec.fs.readable, ['/ws/root/data']);
    await runtime.close();
  });

  it('beforeToolCall 改写 args 后按改写值路由', async () => {
    const probe = makeProbeTool('rw_tool', { sandbox: {} });
    const { provider, calls } = fakeProvider();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'rw_tool', args: { a: 1 } }]),
      tools: [probe],
      permissionFailOpen: true,
      sandbox: { provider },
      extensions: [
        createToolHookExtension({
          beforeToolCall: async ({ toolCall }) => {
            if (toolCall.name === 'rw_tool') {
              return { args: { a: 999 } };
            }
            return {};
          },
        }),
      ],
    });
    await runtime.run({ message: 'hi', type: 'message' });
    assert.deepEqual(calls[0].args, { a: 999 }, '路由应使用 beforeToolCall 改写后的 args');
    await runtime.close();
  });

  it('provider 事件透传 onSandboxEvent 遥测', async () => {
    const probe = makeProbeTool('evt_tool', { sandbox: { strategy: 'subprocess' } });
    const { provider } = fakeProvider();
    const events: SandboxTelemetryInfo[] = [];
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'evt_tool', args: {} }]),
      tools: [probe],
      permissionFailOpen: true,
      sandbox: { provider },
      telemetry: { onSandboxEvent: info => { events.push(info); } },
    });
    await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(events.length, 1, 'provider spawn 事件应上报');
    assert.equal(events[0].type, 'spawn');
    assert.equal(events[0].toolName, 'evt_tool');
    assert.equal(events[0].toolCallId, 't1');
    assert.equal(events[0].strategy, 'subprocess');
    await runtime.close();
  });
});

// ─── 降级与严格模式 ──────────────────────────────────────────────────

describe('沙箱降级与 enforced 严格模式', () => {
  it('未配置 sandbox：声明工具降级 inprocess 直跑 + degraded 遥测告警', async () => {
    const probe = makeProbeTool('boxed_tool', { sandbox: { strategy: 'subprocess' } });
    const events: SandboxTelemetryInfo[] = [];
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'boxed_tool', args: {} }]),
      tools: [probe],
      permissionFailOpen: true,
      telemetry: { onSandboxEvent: info => { events.push(info); } },
    });
    const result = await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(result.success, true);
    assert.equal(probe.calls(), 1, 'fail-open：无沙箱配置时降级直跑');
    const degraded = events.find(e => e.type === 'degraded');
    assert.ok(degraded, '降级必须发 degraded 遥测告警');
    assert.equal(
      (degraded!.detail as { reason?: string } | undefined)?.reason,
      'no-sandbox-configured',
    );
    assert.equal((degraded!.detail as { to?: string } | undefined)?.to, 'inprocess');
    await runtime.close();
  });

  it('enforced：声明 os 且平台不支持 → 直接 blocked（不降级）', async () => {
    const probe = makeProbeTool('strict_tool', { sandbox: { strategy: 'os' } });
    const { provider, calls } = fakeProvider({
      supports: strategy => strategy !== 'os',
    });
    const events: SandboxTelemetryInfo[] = [];
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'strict_tool', args: {} }]),
      tools: [probe],
      permissionFailOpen: true,
      sandbox: { provider, enforced: true },
      telemetry: { onSandboxEvent: info => { events.push(info); } },
    });
    const result = await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(result.success, true, 'blocked 只是工具结果，run 不失败');
    assert.equal(probe.calls(), 0, 'enforced 拒绝时不应降级直跑');
    assert.equal(calls.length, 0, 'provider.run 不应被调用');
    const msgs = runtime.getMessages();
    const tr = msgs.find(m => m.role === 'toolResult') as { content: { text: string }[] };
    assert.match(tr.content[0].text, /sandbox enforced/);
    assert.ok(events.some(e => e.type === 'degraded'), '拒绝路径发 degraded 告警');
    await runtime.close();
  });

  it('enforced=false（缺省）：能力不足交由 provider 降级链处理', async () => {
    const probe = makeProbeTool('loose_tool', { sandbox: { strategy: 'os' } });
    const { provider, calls } = fakeProvider({
      supports: strategy => strategy !== 'os', // os 不支持 → default 语义下 provider 内部降级
    });
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'loose_tool', args: {} }]),
      tools: [probe],
      permissionFailOpen: true,
      sandbox: { provider },
    });
    await runtime.run({ message: 'hi', type: 'message' });
    // fake provider 无降级逻辑，但 run 必须被触达（降级判定在 provider 侧）
    assert.equal(calls.length, 1, '非 enforced 时 provider.run 必须被调用（降级在 provider 内）');
    await runtime.close();
  });

  it('defaults 收紧：工具声明 inprocess，运行时基线 subprocess 不可被降级', async () => {
    const probe = makeProbeTool('base_tool', { sandbox: { strategy: 'inprocess' } });
    const { provider, calls } = fakeProvider();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'base_tool', args: {} }]),
      tools: [probe],
      permissionFailOpen: true,
      sandbox: { provider, defaults: { strategy: 'subprocess' } },
    });
    await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(probe.calls(), 0, '运行时基线更强时不应直跑');
    assert.equal(calls[0].spec.strategy, 'subprocess', '取隔离强度更高者');
    await runtime.close();
  });

  it('spec.strategy=inprocess（工具显式 + 无 defaults）：直跑不经 provider', async () => {
    const probe = makeProbeTool('inproc_tool', { sandbox: { strategy: 'inprocess' } });
    const { provider, calls } = fakeProvider();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'inproc_tool', args: {} }]),
      tools: [probe],
      permissionFailOpen: true,
      sandbox: { provider },
    });
    await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(probe.calls(), 1, 'inprocess 策略直跑');
    assert.equal(calls.length, 0, '不消耗 spawn');
    await runtime.close();
  });
});

// ─── 与既有层的组合 ─────────────────────────────────────────────────

describe('沙箱与权限/健壮性组合', () => {
  it('权限裁决先于沙箱：deny 策略下沙箱工具 blocked，provider 不触达', async () => {
    const probe = makeProbeTool('boxed_tool', { sandbox: { strategy: 'subprocess' } });
    const { provider, calls } = fakeProvider();
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'boxed_tool', args: {} }]),
      tools: [probe],
      permissionPolicy: createDenyAllPolicy(),
      sandbox: { provider },
    });
    await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(probe.calls(), 0);
    assert.equal(calls.length, 0, '权限拒绝的工具不应进入沙箱');
    await runtime.close();
  });

  it('provider.run 抛错 → error 结果，run 不失败', async () => {
    const probe = makeProbeTool('boom_tool', { sandbox: { strategy: 'subprocess' } });
    const { provider } = fakeProvider();
    provider.run = async () => {
      throw new Error('worker infrastructure exploded');
    };
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'boom_tool', args: {} }]),
      tools: [probe],
      permissionFailOpen: true,
      sandbox: { provider },
    });
    const result = await runtime.run({ message: 'hi', type: 'message' });
    assert.equal(result.success, true, 'provider 故障不应炸 run');
    const msgs = runtime.getMessages();
    const tr = msgs.find(m => m.role === 'toolResult') as { content: { text: string }[] };
    assert.match(tr.content[0].text, /worker infrastructure exploded/);
    await runtime.close();
  });

  it('provider 结果为标准 ToolResult 时与 resourcesToMessages 往返兼容', async () => {
    const probe = makeProbeTool('rt_tool', { sandbox: { strategy: 'subprocess' } });
    const { provider } = fakeProvider({
      result: async () => ({
        content: [createTextContent('roundtrip-payload')],
        details: { custom: 42 },
      }),
    });
    const runtime = createRuntime({
      streamFn: mockToolStreamFn([{ id: 't1', name: 'rt_tool', args: {} }]),
      tools: [probe],
      permissionFailOpen: true,
      sandbox: { provider },
    });
    await runtime.run({ message: 'hi', type: 'message' });
    const msgs = runtime.getMessages();
    const tr = msgs.find(m => m.role === 'toolResult') as {
      content: { text: string }[];
      isError: boolean;
    };
    assert.equal(tr.content[0].text, 'roundtrip-payload');
    assert.equal(tr.isError, false, '非 error 结果不标记 isError');
    await runtime.close();
  });
});
