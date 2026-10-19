/**
 * Tier 1 subprocess 沙箱 provider 集成测试（SANDBOX_PLAN §11.2）。
 *
 * 测试以 tsx 直跑 worker.ts 源码（workerPath + nodeArgs 注入），
 * 不依赖构建产物；发布形态（dist/sandbox/worker.js）由 build 保证。
 *
 * 覆盖：
 * - 正常执行往返（ToolResult 兼容 resourcesToMessages 往返契约）
 * - shell 类工具经 provider 执行
 * - env 清洗（worker 读不到宿主自定义变量；spec.env 注入可见）
 * - abort / wallClock / 心跳僵死 → killed + 进程树零残留
 * - 输出超限截断
 * - fs facade 软约束（violation 拦截 / 白名单放行）
 * - 闭包/未注册工具 degraded 路径
 */

import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  mergeSpec,
  createDefaultSandboxProvider,
  SubprocessSandboxProvider,
  probeLinuxSandboxCaps,
  messagesToResources,
  resourcesToMessages,
} from '../index.ts';
import { buildWorkerEnv, resolveWorkerPath } from '../runtime/sandbox/subprocess.ts';
import type {
  SandboxEvent,
  SandboxFsSpec,
  SandboxProvider,
  SandboxResourceSpec,
  SandboxRunRequest,
  SandboxSpec,
} from '../index.ts';

const execFileAsync = promisify(execFile);

// ─── 测试环境 ────────────────────────────────────────────────────────

/** fixture 工具模块（worker 按 toolModules 动态 import 重建注册表） */
const TOOLS_SOURCE = `
import * as fs from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execCb);

export default [
  {
    name: 'echo',
    description: 'echo args back',
    parameters: { type: 'object', properties: {} },
    async execute(toolCallId, args) {
      return { content: [{ type: 'text', text: 'echo:' + JSON.stringify(args) }], details: {} };
    },
  },
  {
    name: 'env-probe',
    description: 'report env values',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const secret = process.env.AIPACK_TEST_SECRET ?? '(absent)';
      const probe = process.env.SANDBOX_PROBE ?? '(absent)';
      return { content: [{ type: 'text', text: JSON.stringify({ secret, probe }) }], details: {} };
    },
  },
  {
    name: 'shell',
    description: 'run echo command',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const r = await exec('echo sandbox-shell-ok');
      return { content: [{ type: 'text', text: r.stdout.trim() }], details: {} };
    },
  },
  {
    name: 'write-inside',
    description: 'write a file inside writable prefix',
    parameters: { type: 'object', properties: {} },
    async execute(toolCallId, args) {
      await fs.promises.writeFile(args.path, 'written-by-worker');
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
  },
  {
    name: 'read-outside',
    description: 'read file outside readable prefix (expect facade violation)',
    parameters: { type: 'object', properties: {} },
    async execute(toolCallId, args) {
      const data = fs.readFileSync(args.path, 'utf8');
      return { content: [{ type: 'text', text: data }], details: {} };
    },
  },
  {
    name: 'sleep',
    description: 'sleep 10s (kill target)',
    parameters: { type: 'object', properties: {} },
    async execute() {
      await new Promise(r => setTimeout(r, 10000));
      return { content: [{ type: 'text', text: 'slept' }], details: {} };
    },
  },
  {
    name: 'stream-stderr',
    description: 'write 2MB to stderr (expect output-limit kill)',
    parameters: { type: 'object', properties: {} },
    async execute() {
      process.stderr.write('x'.repeat(2 * 1024 * 1024));
      return { content: [{ type: 'text', text: 'streamed' }], details: {} };
    },
  },
  {
    name: 'freeze',
    description: 'block main thread 30s (expect heartbeat-lost kill)',
    parameters: { type: 'object', properties: {} },
    async execute() {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      return { content: [{ type: 'text', text: 'unfrozen' }], details: {} };
    },
  },
];
`;

let workspace: string;
let toolsModule: string;
let sentinelDir: string;
let sentinelFile: string;
const HOST_SECRET_VAR = 'AIPACK_TEST_SECRET';
const HOST_SECRET_VALUE = 'host-secret-should-not-leak';

const workerTs = fileURLToPath(new URL('../runtime/sandbox/worker.ts', import.meta.url));
// import.meta.resolve 解析 tsx 的 import 入口（绝对 URL，不依赖 cwd 的裸名解析）
const tsxEntryUrl = import.meta.resolve('tsx');

/** 测试 provider：直跑 worker.ts 源码（不依赖构建产物） */
function makeProvider(overrides?: { heartbeatTimeoutMs?: number; toolModules?: string[] }) {
  return new SubprocessSandboxProvider({
    workerPath: workerTs,
    nodeArgs: ['--import', tsxEntryUrl],
    toolModules: overrides?.toolModules ?? [toolsModule],
    heartbeatTimeoutMs: overrides?.heartbeatTimeoutMs,
    // 本 suite 验证单次会话语义（spawn → exec → exit 事件序列）：
    // 池化复用（M8）由 sandbox-pool.test.ts 专项覆盖
    pool: { maxWorkers: 0 },
  });
}

/** 完备 spec：mergeSpec 契约回填（workspace 回填 readable/writable） */
function makeSpec(partial?: {
  fs?: Partial<SandboxFsSpec>;
  env?: Record<string, string>;
  resources?: Partial<SandboxResourceSpec>;
  strategy?: SandboxSpec['strategy'];
}): SandboxSpec {
  return mergeSpec(
    undefined,
    {
      ...(partial?.fs ? { fs: partial.fs } : {}),
      ...(partial?.env ? { env: partial.env } : {}),
      ...(partial?.resources ? { resources: partial.resources } : {}),
      ...(partial?.strategy ? { strategy: partial.strategy } : {}),
    },
    workspace,
  );
}

/** 构造 run 请求（events 收集器内联） */
function makeReq(
  provider: { run(req: SandboxRunRequest): Promise<unknown> },
  opts: {
    toolName: string;
    args?: unknown;
    spec?: SandboxSpec;
    events?: SandboxEvent[];
    signal?: AbortSignal;
  },
): SandboxRunRequest {
  return {
    toolName: opts.toolName,
    toolCallId: `tc_${Math.random().toString(36).slice(2, 10)}`,
    args: opts.args ?? {},
    spec: opts.spec ?? makeSpec(),
    signal: opts.signal ?? new AbortController().signal,
    onEvent: opts.events ? (e) => { opts.events!.push(e); } : undefined,
  };
}

/** 进程零残留断言：worker pid（spawn 事件 detail）应已不存在 */
async function assertPidGone(pid: unknown): Promise<void> {
  if (typeof pid !== 'number') return;
  if (process.platform === 'win32') {
    const r = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`]);
    assert.ok(
      !r.stdout.includes(String(pid)),
      `worker pid ${pid} still alive (taskkill /T failed?)`,
    );
  } else {
    // 低 CPU 配额环境（如单核容器）下 SIGKILL 后内核回收进程表项有延迟：
    // 立即探测会误判存活。给 2s 宽限重试，宽限后仍存活才是真失败。
    const deadline = Date.now() + 2_000;
    for (;;) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (!alive || Date.now() >= deadline) {
        assert.ok(!alive, `worker pid ${pid} still alive (process group kill failed?)`);
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

function isErrorResult(r: { details?: unknown }): boolean {
  return (r.details as { error?: unknown } | undefined)?.error !== undefined;
}

// ─── 纯函数单测 ─────────────────────────────────────────────────────

describe('buildWorkerEnv（env 白名单构造）', () => {
  const home = path.join(os.tmpdir(), 'sbx-home');

  it('spec.env 注入生效且不继承宿主变量（含 NODE_OPTIONS）', () => {
    const prevNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--inspect=0'; // 哨兵：绝不允许进 worker
    try {
      const env = buildWorkerEnv({ MY_TOOL_VAR: '42' }, home);
      assert.equal(env['MY_TOOL_VAR'], '42');
      assert.equal(env['NODE_OPTIONS'], undefined);
      assert.equal(env['AIPACK_SANDBOX_WORKER'], undefined);
    } finally {
      if (prevNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prevNodeOptions;
    }
  });

  it('框架保留键不可被 spec.env 覆盖（PATH/HOME/TMPDIR）', () => {
    const env = buildWorkerEnv(
      { PATH: '/evil', HOME: '/evil', TMPDIR: '/evil', CUSTOM: 'ok' },
      home,
    );
    assert.notEqual(env['PATH'], '/evil');
    assert.equal(env['CUSTOM'], 'ok');
    const posixEnv = env as Record<string, string>;
    if (process.platform !== 'win32') {
      assert.equal(posixEnv['HOME'], home);
      assert.ok(posixEnv['TMPDIR'].startsWith(home));
    } else {
      assert.equal(posixEnv['USERPROFILE'], home);
      assert.ok(posixEnv['TEMP'].startsWith(home));
    }
  });
});

describe('resolveWorkerPath', () => {
  it('AIPACK_SANDBOX_WORKER 显式覆盖优先', () => {
    const prev = process.env.AIPACK_SANDBOX_WORKER;
    process.env.AIPACK_SANDBOX_WORKER = workerTs;
    try {
      assert.equal(resolveWorkerPath(), workerTs);
    } finally {
      if (prev === undefined) delete process.env.AIPACK_SANDBOX_WORKER;
      else process.env.AIPACK_SANDBOX_WORKER = prev;
    }
  });
});

describe('createDefaultSandboxProvider（能力探测 + 路由）', () => {
  // fixture 自足：模块级共享的 toolsModule 由「SubprocessSandboxProvider 集成」
  // suite 的 before 初始化，而本 suite 先执行——直接引用会拿到 undefined。
  // Windows 下 supports('os') 恒 false 掩盖了这点；Linux+bwrap 下 os 路径真进
  // bwrap.run，undefined toolModule 在 argv 构造（dirname(undefined)）即崩。
  // 池化 provider 提升到套件作用域：默认池（maxWorkers 3 / idleTtl 60s）的空闲
  // worker 是活进程，不 close() 会挂住测试进程直至 TTL 兜底
  let provider: SandboxProvider;
  let fixtureDir: string | undefined;

  before(async () => {
    fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aipack-sbx-dflt-'));
    const fixtureTools = path.join(fixtureDir, 'tools.mjs');
    await fs.promises.writeFile(fixtureTools, TOOLS_SOURCE);
    provider = createDefaultSandboxProvider({
      workerPath: workerTs,
      nodeArgs: ['--import', tsxEntryUrl],
      toolModules: [fixtureTools],
    });
  });

  after(async () => {
    await (provider as SubprocessSandboxProvider).close?.();
    if (fixtureDir !== undefined) {
      await fs.promises.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('supports：inprocess/subprocess true；os 按平台能力；microvm false', async () => {
    assert.equal(await provider.supports('inprocess'), true);
    assert.equal(await provider.supports('subprocess'), true);
    // os 走真实能力探测（内部构造最小 bwrap 沙箱验证内核路径）：
    // Linux + bwrap 可用 → true；其余环境（Windows/macOS、无 bwrap Linux）→ false
    const caps = await probeLinuxSandboxCaps();
    assert.equal(await provider.supports('os'), process.platform === 'linux' && caps.bwrap);
    assert.equal(await provider.supports('microvm'), false);
  });

  it('inprocess 到达 provider = 路由错误：显式 error + degraded 事件', async () => {
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq(provider, {
      toolName: 'echo',
      spec: makeSpec({ strategy: 'inprocess' }),
      events,
    }))) as { content: { type: string; text: string }[]; details?: unknown };
    assert.ok(isErrorResult(result), 'inprocess 请求必须显式失败');
    assert.ok(events.some(e => e.type === 'degraded'));
  });

  it('os 策略降级链：能力不足时 degraded（os→subprocess）后按 subprocess 执行', async t => {
    // 降级链仅在 os 能力不足环境发生。os 可用（Linux+bwrap）时 run('os')
    // 直进 bwrap 真执行——本用例的 tsx 源码形态 worker 在 bwrap 内亦不可运行
    // （tsx loader 不在挂载面），os 真执行由 sandbox-os.test.ts 的 dist 形态覆盖。
    if (await provider.supports('os')) {
      return t.skip('os 能力可用：不发生降级（os 真执行见 sandbox-os.test.ts）');
    }
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq(provider, {
      toolName: 'echo',
      args: { ok: 1 },
      spec: makeSpec({ strategy: 'os' }),
      events,
    }))) as { content: { type: string; text: string }[] };
    const degraded = events.find(e => e.type === 'degraded');
    assert.ok(degraded, '必须有 degraded 事件');
    assert.equal(
      (degraded?.detail as { from?: string; to?: string } | undefined)?.to,
      'subprocess',
    );
    assert.match(result.content[0].text, /echo/);
  });
});

// ─── 集成测试（真 spawn worker）──────────────────────────────────────

describe('SubprocessSandboxProvider 集成', () => {
  before(async () => {
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aipack-sbx-test-'));
    toolsModule = path.join(workspace, 'tools.mjs');
    await fs.promises.writeFile(toolsModule, TOOLS_SOURCE);
    // workspace 外哨兵文件（readable 之外，violation 用例目标）
    sentinelDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aipack-sbx-sentinel-'));
    sentinelFile = path.join(sentinelDir, 'secret.txt');
    await fs.promises.writeFile(sentinelFile, 'SENTINEL-SECRET');
    process.env[HOST_SECRET_VAR] = HOST_SECRET_VALUE;
  });

  after(async () => {
    delete process.env[HOST_SECRET_VAR];
    await fs.promises.rm(workspace, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(sentinelDir, { recursive: true, force: true }).catch(() => {});
  });

  it('supports：仅 subprocess 为 true', async () => {
    const provider = makeProvider();
    assert.equal(await provider.supports('subprocess'), true);
    assert.equal(await provider.supports('inprocess'), false);
    assert.equal(await provider.supports('os'), false);
    assert.equal(await provider.supports('microvm'), false);
  });

  it('正常执行往返：ToolResult 结构 + resourcesToMessages 契约兼容', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq(provider, {
      toolName: 'echo',
      args: { hello: 'world' },
      events,
    }))) as { content: { type: string; text: string }[]; details: unknown };

    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /hello/);
    assert.ok(!isErrorResult(result));

    // 压缩往返契约（项目硬约束）：沙箱 ToolResult 经 resource 往返无损
    const message = {
      role: 'toolResult',
      toolCallId: 'tc_roundtrip',
      toolName: 'echo',
      isError: false,
      content: result.content,
      details: result.details,
    } as const;
    const roundtrip = resourcesToMessages(messagesToResources([message]));
    assert.equal(roundtrip.length, 1);
    assert.deepEqual((roundtrip[0] as { content: unknown }).content, result.content);

    // 事件序列：spawn → exit，无 killed
    assert.equal(events[0]?.type, 'spawn');
    assert.equal(events[events.length - 1]?.type, 'exit');
    assert.ok(!events.some(e => e.type === 'killed'));
  });

  it('shell 类工具经 provider 执行成功', async () => {
    const provider = makeProvider();
    const result = (await provider.run(makeReq(provider, { toolName: 'shell' }))) as {
      content: { text: string }[];
    };
    assert.equal(result.content[0].text, 'sandbox-shell-ok');
  });

  it('env 清洗：宿主自定义变量不可见，spec.env 注入可见', async () => {
    const provider = makeProvider();
    const result = (await provider.run(makeReq(provider, {
      toolName: 'env-probe',
      spec: makeSpec({ env: { SANDBOX_PROBE: '42' } }),
    }))) as { content: { text: string }[] };
    const probe = JSON.parse(result.content[0].text) as { secret: string; probe: string };
    assert.equal(probe.secret, '(absent)', '宿主变量泄漏到了 worker 进程');
    assert.equal(probe.probe, '42');
  });

  it('fs facade 软约束：readable 外读取 → violation 事件 + error 结果', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq(provider, {
      toolName: 'read-outside',
      args: { path: sentinelFile },
      events,
    }))) as { content: { text: string }[]; details?: { error?: string } };

    const violation = events.find(e => e.type === 'violation');
    assert.ok(violation, '必须有 violation 事件');
    assert.equal((violation?.detail as { path?: string } | undefined)?.path, sentinelFile);
    assert.ok(isErrorResult(result), '越界读取必须返回 error 结果');
    assert.match(result.details?.error ?? '', /violation/);
    // 哨兵内容不泄漏
    assert.ok(!result.content[0].text.includes('SENTINEL-SECRET'));
  });

  it('fs facade 放行：writable 前缀内写入成功', async () => {
    const provider = makeProvider();
    const target = path.join(workspace, 'written.txt');
    const result = (await provider.run(makeReq(provider, {
      toolName: 'write-inside',
      args: { path: target },
    }))) as { content: { text: string }[] };
    assert.equal(result.content[0].text, 'ok');
    assert.equal(await fs.promises.readFile(target, 'utf8'), 'written-by-worker');
  });

  it('abort：killed 事件 + error 结果 + 进程零残留', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const controller = new AbortController();
    const req = makeReq(provider, {
      toolName: 'sleep',
      events,
      signal: controller.signal,
    });
    const runPromise = provider.run(req) as Promise<{ content: { text: string }[]; details?: { killed?: string } }>;
    setTimeout(() => controller.abort(), 300);
    const result = await runPromise;

    const killed = events.find(e => e.type === 'killed');
    assert.ok(killed, '必须有 killed 事件');
    assert.equal((killed?.detail as { reason?: string } | undefined)?.reason, 'aborted');
    assert.ok(isErrorResult(result));
    assert.equal(result.details?.killed, 'aborted');
    await assertPidGone(events.find(e => e.type === 'spawn')?.detail?.pid);
  });

  it('wallClockMs 超时：killed + 进程零残留', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq(provider, {
      toolName: 'sleep',
      spec: makeSpec({ resources: { wallClockMs: 400 } }),
      events,
    }))) as { details?: { killed?: string } };

    const killed = events.find(e => e.type === 'killed');
    assert.ok(killed);
    assert.equal(
      (killed?.detail as { reason?: string } | undefined)?.reason,
      'wall-clock-timeout',
    );
    assert.equal(result.details?.killed, 'wall-clock-timeout');
    await assertPidGone(events.find(e => e.type === 'spawn')?.detail?.pid);
  });

  it('心跳僵死：worker 主线程冻结 → heartbeat-lost 强杀', async () => {
    const provider = makeProvider({ heartbeatTimeoutMs: 2500 });
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq(provider, {
      toolName: 'freeze',
      events,
    }))) as { details?: { killed?: string } };

    assert.equal(result.details?.killed, 'heartbeat-lost');
    await assertPidGone(events.find(e => e.type === 'spawn')?.detail?.pid);
  });

  it('输出超限：kill + 截断 error 结果', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq(provider, {
      toolName: 'stream-stderr',
      spec: makeSpec({ resources: { outputBytes: 64 * 1024 } }),
      events,
    }))) as {
      content: { text: string }[];
      details?: { killed?: string; error?: string; outputBytes?: number };
    };

    assert.equal(result.details?.killed, 'output-limit');
    assert.match(result.details?.error ?? '', /output limit exceeded/);
    // 2MB 输出被截断在阈值附近（不完整收包）
    assert.ok((result.details?.outputBytes ?? 0) < 2 * 1024 * 1024);
    assert.ok(events.some(e => e.type === 'killed'));
  });

  it('闭包/未注册工具：degraded 事件 + 明确 error 结果', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq(provider, {
      toolName: 'closure-tool-not-in-any-module',
      events,
    }))) as { content: { text: string }[]; details?: { error?: string } };

    const degraded = events.find(e => e.type === 'degraded');
    assert.ok(degraded, '必须有 degraded 事件');
    assert.equal(
      (degraded?.detail as { reason?: string } | undefined)?.reason,
      'tool-not-resolvable',
    );
    assert.ok(isErrorResult(result));
    assert.match(result.details?.error ?? '', /not available in the sandbox worker/);
  });
});
