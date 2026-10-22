/**
 * LangfuseExtension 测试（离线：注入 fake transport）
 * - 未启用时 no-op
 * - 完整链路：root(chain) → tool/llm 子 run → root end
 * - 原始 Telemetry 始终被转发
 * - 上报失败不阻断转发
 * - inputs 超限截断
 * - run 结束后活跃表清理（同 traceId 后续事件不再上报）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LangfuseExtension } from '../index.js';
import type { TracedRun, TracedRunConfig, TraceTransport } from '../index.js';
import type {
  ExtensionContext,
  RuntimeHooks,
  Telemetry,
  RunStartTelemetryInfo,
  RunTelemetryInfo,
  ToolTelemetryInfo,
  ModelTelemetryInfo,
} from '@aipack-ai/agent';

// ─── fake transport ───────────────────────────────────────────────

interface RecordedRun {
  config: TracedRunConfig;
  parent: RecordedRun | null;
  ended: { outputs?: unknown; error?: string; endTime?: number } | null;
  posts: number;
  patches: number;
  children: RecordedRun[];
}

function makeFakeTransport(options: { failOnCreate?: boolean } = {}) {
  const runs: RecordedRun[] = [];

  class FakeRun implements TracedRun {
    readonly recorded: RecordedRun;
    constructor(config: TracedRunConfig, parent: RecordedRun | null) {
      this.recorded = { config, parent, ended: null, posts: 0, patches: 0, children: [] };
      runs.push(this.recorded);
    }
    get id() {
      return String(this.recorded.config.id ?? '');
    }
    postRun() {
      this.recorded.posts += 1;
      return Promise.resolve();
    }
    patchRun() {
      this.recorded.patches += 1;
      return Promise.resolve();
    }
    end(outputs?: unknown, error?: string, endTime?: number) {
      this.recorded.ended = { outputs, error, endTime };
      return Promise.resolve();
    }
    createChild(config: TracedRunConfig): TracedRun {
      const child = new FakeRun(config, this.recorded) as FakeRun;
      this.recorded.children.push(child.recorded);
      return child;
    }
  }

  const transport: TraceTransport = {
    createRoot(config: TracedRunConfig): TracedRun {
      if (options.failOnCreate) throw new Error('transport down');
      return new FakeRun(config, null);
    },
  };

  return { transport, runs };
}

// ─── fake hooks / context ─────────────────────────────────────────

interface CapturedTap {
  name: string;
  fn: (ctx: unknown) => Promise<unknown>;
}

function makeHooks(): { hooks: RuntimeHooks; taps: CapturedTap[] } {
  const taps: CapturedTap[] = [];
  const hooks = {
    beforeModelCall: {
      tapPromise(name: string, fn: (ctx: unknown) => Promise<unknown>) {
        taps.push({ name, fn });
      },
    },
  } as unknown as RuntimeHooks;
  return { hooks, taps };
}

function makeContext(original?: Telemetry) {
  let current: Telemetry | undefined = original;
  const ctx: ExtensionContext = {
    config: {},
    workspace: '/tmp',
    sessionKey: 'default',
    shared: new Map(),
    telemetry: {
      get: () => current,
      set: next => {
        current = next;
      },
    },
  };
  return {
    ctx,
    get: () => current,
  };
}

// ─── fake telemetry 事件 ──────────────────────────────────────────

function runStartInfo(overrides?: Partial<RunStartTelemetryInfo>): RunStartTelemetryInfo {
  return {
    traceId: 'trace-1',
    sessionKey: 'default',
    request: { message: 'hi', type: 'message' },
    queuedAt: 1_000,
    ...overrides,
  };
}

function runEndInfo(overrides?: Partial<RunTelemetryInfo>): RunTelemetryInfo {
  return {
    traceId: 'trace-1',
    sessionKey: 'default',
    request: { message: 'hi', type: 'message' },
    durationMs: 100,
    activeMs: 90,
    queuedMs: 10,
    turnCount: 1,
    result: {
      content: 'world',
      toolsUsed: [],
      usage: { input: 10, output: 5 },
      stopReason: 'completed',
      metadata: {},
      success: true,
    },
    success: true,
    tokens: { input: 10, output: 5 },
    ...overrides,
  };
}

function toolInfo(overrides?: Partial<ToolTelemetryInfo>): ToolTelemetryInfo {
  return {
    traceId: 'trace-1',
    spanId: 'span-tool-1',
    sessionKey: 'default',
    toolName: 'echo',
    args: { msg: 'foo' },
    durationMs: 20,
    result: { content: [{ type: 'text', text: 'foo' }], details: {} },
    success: true,
    status: 'ok',
    ...overrides,
  };
}

function modelInfo(overrides?: Partial<ModelTelemetryInfo>): ModelTelemetryInfo {
  return {
    traceId: 'trace-1',
    spanId: 'span-model-1',
    sessionKey: 'default',
    modelId: 'gpt-test',
    attempts: 1,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 80,
    stream: true,
    ...overrides,
  };
}

const noopRunTree = { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] };

async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

// ─── 测试 ─────────────────────────────────────────────────────────

describe('LangfuseExtension', () => {
  it('未启用时（无 transport/凭据）为 no-op，不替换 telemetry', async () => {
    const { transport, runs } = makeFakeTransport();
    const { ctx, get } = makeContext();
    const ext = new LangfuseExtension({ enabled: false, transport });
    const { hooks } = makeHooks();

    ext.apply(hooks, ctx);

    assert.equal(get(), undefined); // 原始 telemetry 未被替换
    // 模拟 runtime 发射事件（未启用时 telemetry 未被包装，此处直接验证 runs 为空）
    assert.equal(runs.length, 0);
  });

  it('完整链路：root(chain) + tool/llm 子 run + root end，metadata 带 traceId', async () => {
    const { transport, runs } = makeFakeTransport();
    const { ctx, get } = makeContext();
    const { hooks, taps } = makeHooks();
    const ext = new LangfuseExtension({ transport });

    ext.apply(hooks, ctx);
    const wrapped = get();
    assert.ok(wrapped, 'telemetry 应被替换为包装层');

    // 模拟 beforeModelCall 捕获
    assert.equal(taps.length, 1);
    await taps[0].fn(noopRunTree);

    await wrapped.onRunStart?.(runStartInfo());
    await wrapped.onToolCall?.(toolInfo());
    await wrapped.onModelCall?.(modelInfo());
    await wrapped.onRunEnd?.(runEndInfo());
    await flush();

    // 1 root + 1 tool + 1 llm
    assert.equal(runs.length, 3);
    const [root, tool, model] = runs;

    assert.equal(root.config.name, 'aipack.agent');
    assert.equal(root.config.run_type, 'chain');
    assert.equal((root.config.inputs as Record<string, unknown>).message, 'hi');
    assert.equal(root.parent, null);
    assert.ok(root.posts >= 1);

    assert.equal(tool.config.run_type, 'tool');
    assert.equal(tool.config.name, 'echo');
    assert.equal(tool.parent, root);
    assert.deepEqual(tool.ended?.outputs, { content: [{ type: 'text', text: 'foo' }], details: {} });

    assert.equal(model.config.run_type, 'llm');
    assert.equal(model.config.name, 'gpt-test');
    assert.equal(model.parent, root);
    assert.deepEqual((model.config.inputs as Record<string, unknown>).messages, [
      { role: 'user', content: 'hi' },
    ]);
    assert.deepEqual(model.ended?.outputs, {
      input_tokens: 100,
      output_tokens: 50,
      cache_read: undefined,
      cache_write: undefined,
    });

    // root 结束
    assert.deepEqual(root.ended?.outputs, { output: 'world' });
    assert.equal(root.ended?.error, undefined);
    // metadata 经 patchRun 上报（end 的第 4 参数在本 fake 中不记录，验证 patch 被调用）
    assert.ok(root.patches >= 1);

    // 活跃表清理：同 traceId 后续工具事件不再上报
    await wrapped.onToolCall?.(toolInfo({ spanId: 'span-tool-2' }));
    await flush();
    assert.equal(runs.length, 3);
  });

  it('run 失败：root end 带 error', async () => {
    const { transport, runs } = makeFakeTransport();
    const { ctx, get } = makeContext();
    const { hooks } = makeHooks();

    new LangfuseExtension({ transport }).apply(hooks, ctx);
    const wrapped = get()!;

    await wrapped.onRunStart?.(runStartInfo());
    await wrapped.onRunEnd?.(
      runEndInfo({
        success: false,
        result: {
          content: '',
          toolsUsed: [],
          usage: {},
          stopReason: 'error',
          metadata: {},
          success: false,
          error: 'boom',
        },
      }),
    );
    await flush();

    assert.equal(runs.length, 1);
    assert.equal(runs[0].ended?.error, 'boom');
  });

  it('原始 Telemetry 始终被转发', async () => {
    const { transport } = makeFakeTransport();
    const seen: string[] = [];
    const original: Telemetry = {
      onRunStart: () => {
        seen.push('onRunStart');
      },
      onRunEnd: () => {
        seen.push('onRunEnd');
      },
    };
    const { ctx, get } = makeContext(original);
    const { hooks } = makeHooks();

    new LangfuseExtension({ transport }).apply(hooks, ctx);
    const wrapped = get()!;

    await wrapped.onRunStart?.(runStartInfo());
    await wrapped.onRunEnd?.(runEndInfo());

    assert.deepEqual(seen, ['onRunStart', 'onRunEnd']);
  });

  it('transport 抛错不阻断，original 仍被转发', async () => {
    const errors: Array<{ err: unknown; where: string }> = [];
    const { transport } = makeFakeTransport({ failOnCreate: true });
    const seen: string[] = [];
    const original: Telemetry = {
      onRunStart: () => {
        seen.push('onRunStart');
      },
    };
    const { ctx, get } = makeContext(original);
    const { hooks } = makeHooks();

    new LangfuseExtension({ transport, onError: (err, where) => errors.push({ err, where }) }).apply(
      hooks,
      ctx,
    );
    const wrapped = get()!;

    await wrapped.onRunStart?.(runStartInfo());
    assert.deepEqual(seen, ['onRunStart']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].where, 'onRunStart');
  });

  it('inputs 超过 maxInputBytes 时截断', async () => {
    const { transport, runs } = makeFakeTransport();
    const { ctx, get } = makeContext();
    const { hooks } = makeHooks();

    new LangfuseExtension({ transport, maxInputBytes: 16 }).apply(hooks, ctx);
    const wrapped = get()!;

    await wrapped.onRunStart?.(runStartInfo());
    await flush();

    assert.equal(runs.length, 1);
    const inputs = runs[0].config.inputs as Record<string, unknown>;
    assert.equal(inputs.truncated, true);
    assert.ok(typeof inputs.preview === 'string' && inputs.preview.length <= 16);
  });

  it('活跃 run 表超限淘汰最旧并补报结束', async () => {
    const { transport, runs } = makeFakeTransport();
    const { ctx, get } = makeContext();
    const { hooks } = makeHooks();

    new LangfuseExtension({ transport, maxActiveRuns: 1 }).apply(hooks, ctx);
    const wrapped = get()!;

    await wrapped.onRunStart?.(runStartInfo({ traceId: 't1' }));
    await wrapped.onRunStart?.(runStartInfo({ traceId: 't2' }));
    await flush();

    // t1 被淘汰：2 root，第一个已补报结束
    assert.equal(runs.length, 2);
    assert.equal((runs[0].ended?.outputs as Record<string, unknown>)?.output, '[evicted] maxActiveRuns exceeded');

    // t1 的后续事件被忽略
    await wrapped.onToolCall?.(toolInfo({ traceId: 't1' }));
    await flush();
    assert.equal(runs.length, 2);
  });
});
