/**
 * runtime/sandbox/subprocess - Tier 1 subprocess 沙箱 provider（本期核心）
 *
 * 每次工具调用 spawn 一个 worker 进程（node <pkg-dist>/sandbox/worker.js），
 * stdin/stdout NDJSON 协议执行单次工具调用（隔离优先，池化留 M8）。
 *
 * 隔离手段（Tier 1，如实声明）：
 * - env 白名单构造：worker 不继承宿主环境变量（凭证泄漏面 = spec.env 显式项）；
 * - 进程组管理：POSIX detached 进程组 kill(-pid) / Windows taskkill /T /F 杀树；
 * - 三触发强杀：AbortSignal / wallClockMs 超时 / 心跳僵死（首条消息激活计时）；
 * - 输出封顶：宿主侧累计 stdout+stderr 字节，超限 kill + 截断结果；
 * - HOME/TMPDIR 指向每次调用的临时目录，用后清理。
 *
 * 非目标（Tier 1 无法强制，留 Tier 2）：fs 硬边界（worker 内软约束可被
 * child_process 绕过）、网络强约束、memory/cpu/pids 硬配额（R4：优先零依赖，
 * 配额评估与 Windows 原生方案一并做）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type {
  SandboxEvent,
  SandboxEventType,
  SandboxProvider,
  SandboxRunRequest,
  SandboxSpec,
  SandboxStrategy,
} from '../../core/sandbox';
import type { ToolResult } from '../../core/types';
import { createTextContent } from '../../core/types';
import {
  HEARTBEAT_TIMEOUT_DEFAULT_MS,
  type HostMessage,
  type WorkerMessage,
} from './protocol';
import { createWindowsProcessAudit } from './audit-win';

const IS_WIN = process.platform === 'win32';

// ─── worker 入口解析 ────────────────────────────────────────────────

/**
 * 形参经函数传入（非字面量），esbuild 不做 new URL 静态 asset 分析，
 * 构建产物与源码两种形态下均保留运行时语义。
 */
function urlRel(rel: string): string {
  return fileURLToPath(new URL(rel, import.meta.url));
}

/**
 * 解析 worker 入口脚本路径（自动形态，无参调用）：
 * 1. AIPACK_SANDBOX_WORKER 环境变量（显式覆盖）；
 * 2. 产物形态：本文件被打包进 dist/index.js，worker 在 dist/sandbox/worker.js；
 * 3. 源码形态：runtime/sandbox/subprocess.ts → 包根 dist/sandbox/worker.js。
 * 都不存在返回 undefined（supports('subprocess') = false，如实降级）。
 */
export function resolveWorkerPath(): string | undefined {
  const candidates: string[] = [];
  const fromEnv = process.env['AIPACK_SANDBOX_WORKER'];
  if (fromEnv && fromEnv !== '') candidates.push(fromEnv);
  candidates.push(urlRel('./sandbox/worker.js'));
  candidates.push(urlRel('../../dist/sandbox/worker.js'));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

// ─── env 白名单构造 ─────────────────────────────────────────────────

/** Windows 系统必需变量（硬编码清单，从宿主复制；node/进程启动依赖） */
const WIN_SYSTEM_KEYS = [
  'SystemRoot',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
];

/** 框架保留键：由 provider 白名单构造，spec.env 不可覆盖 */
const RESERVED_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
  ...WIN_SYSTEM_KEYS,
];

/** 大小写不敏感取键（Windows env 键不区分大小写，POSIX 精确匹配） */
function envLookup(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (!IS_WIN) return env[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) return env[k];
  }
  return undefined;
}

/**
 * 构造 worker 进程环境：白名单构造，绝不继承宿主 env。
 * - PATH：node 目录 + 平台系统路径（不含宿主自定义条目）；
 * - HOME/USERPROFILE：每次调用的沙箱临时目录（用后清理）；
 * - TMPDIR/TEMP/TMP：沙箱临时目录下的 tmp；
 * - Windows 系统必需变量按硬编码清单复制；
 * - spec.env 显式项逐键注入（保留键不可覆盖）。
 */
export function buildWorkerEnv(
  specEnv: Record<string, string>,
  sandboxHome: string,
): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  const nodeDir = nodePath.dirname(process.execPath);
  const tmpDir = nodePath.join(sandboxHome, 'tmp');

  if (IS_WIN) {
    for (const k of WIN_SYSTEM_KEYS) {
      const v = envLookup(process.env, k);
      if (v !== undefined) env[k] = v;
    }
    const sysRoot = env['SystemRoot'] ?? 'C:\\Windows';
    env['PATH'] = `${sysRoot}\\system32;${sysRoot};${sysRoot}\\System32\\Wbem;${nodeDir}`;
    env['USERPROFILE'] = sandboxHome;
    env['TEMP'] = tmpDir;
    env['TMP'] = tmpDir;
  } else {
    env['PATH'] = `/usr/local/bin:/usr/bin:/bin:${nodeDir}`;
    env['HOME'] = sandboxHome;
    env['TMPDIR'] = tmpDir;
  }

  for (const [k, v] of Object.entries(specEnv)) {
    const reserved = RESERVED_KEYS.some(r =>
      IS_WIN ? r.toLowerCase() === k.toLowerCase() : r === k,
    );
    if (reserved) continue; // 框架保留键不可覆盖（契约语义）
    env[k] = v;
  }
  return env;
}

// ─── 进程树强杀 ──────────────────────────────────────────────────────

/**
 * 杀掉 worker 及其整棵派生树（工具可能派生后台进程逃逸单进程 kill）。
 * - Windows：taskkill /T /F 递归杀树；
 * - POSIX：detached spawn 时 pid 即进程组长，kill(-pid) 杀整组；对组长非 pid
 *   的防御场景再补 child.kill()。
 */
async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return; // 未起或已退
  }
  if (IS_WIN) {
    await new Promise<void>(resolve => {
      // taskkill 跑在宿主侧（继承宿主全量 env，不受沙箱 env 约束）
      const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      tk.on('error', () => resolve());
      tk.on('exit', () => resolve());
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ESRCH：进程组已不存在
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出
    }
  }
}

// ─── provider ───────────────────────────────────────────────────────

export interface SubprocessSandboxProviderOptions {
  /** worker 入口脚本显式覆盖（默认自动解析，见 resolveWorkerPath） */
  workerPath?: string;
  /** 启动 worker 的 node 附加参数（如测试直跑 TS 源码：['--import','tsx']） */
  nodeArgs?: string[];
  /** 心跳僵死判定阈值（默认 15s；从 worker 首条 stdout 消息激活计时） */
  heartbeatTimeoutMs?: number;
  /** worker 进程加载的工具模块路径（RuntimeOptions.sandbox.toolModules 透传） */
  toolModules?: string[];
}

export class SubprocessSandboxProvider implements SandboxProvider {
  private readonly _workerPath: string | undefined;
  private readonly _nodeArgs: string[];
  private readonly _heartbeatTimeoutMs: number;
  private readonly _toolModules: string[];

  constructor(options: SubprocessSandboxProviderOptions = {}) {
    // 显式 workerPath 直接信任（配置错误在 run 时以 spawn error 显式失败）
    this._workerPath = options.workerPath ?? resolveWorkerPath();
    this._nodeArgs = options.nodeArgs ?? [];
    this._heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_DEFAULT_MS;
    this._toolModules = options.toolModules ?? [];
  }

  async supports(strategy: SandboxStrategy): Promise<boolean> {
    if (strategy === 'subprocess') return this._workerPath !== undefined;
    // 本 provider 只实现 subprocess：inprocess 由 ToolExecutor 直跑（M3 接线），
    // os/microvm 是 Tier 2/3，本期未实现
    return false;
  }

  async run(req: SandboxRunRequest): Promise<ToolResult> {
    if (this._workerPath === undefined) {
      throw new Error(
        'SubprocessSandboxProvider: worker entry not found. ' +
        'Build the package (pnpm build) or set AIPACK_SANDBOX_WORKER.',
      );
    }
    if (req.spec.strategy !== 'subprocess') {
      throw new Error(
        `SubprocessSandboxProvider: unsupported strategy "${req.spec.strategy}" ` +
        `(route via createDefaultSandboxProvider for degradation)`,
      );
    }
    return runInWorker(this._workerPath, {
      nodeArgs: this._nodeArgs,
      heartbeatTimeoutMs: this._heartbeatTimeoutMs,
      toolModules: this._toolModules,
    }, req);
  }
}

// ─── 单次执行状态机 ─────────────────────────────────────────────────

interface WorkerRunOptions {
  nodeArgs: string[];
  heartbeatTimeoutMs: number;
  toolModules: string[];
}

/** 未设 outputBytes 时的行缓冲硬顶（防 worker 异常输出无界行撑爆宿主） */
const MAX_LINE_FALLBACK_BYTES = 8 * 1024 * 1024;
/** stderr 诊断尾部保留量（error 结果附带） */
const STDERR_TAIL_BYTES = 4096;

/** 协议会话规格：Tier 1（直接 node）与 Tier 2（bwrap 包裹）共用宿主侧状态机 */
export interface ProtocolSessionSpec {
  /** 完整命令行（argv[0] 为解释器/包装器，末项为 worker 脚本或其包裹链） */
  argv: string[];
  /** 子进程环境（宿主侧 env；Tier 2 沙箱内 env 经 --clearenv/--setenv 另行构造） */
  env: NodeJS.ProcessEnv;
  /** POSIX 进程组分离（kill(-pid) 杀整组）；Windows 走 taskkill /T */
  detached: boolean;
  /** 会话结束后递归清理的宿主目录（Tier 1 的 HOME 伪造目录 / Tier 2 的 deny 空文件目录） */
  cleanupDirs: string[];
  /** 心跳僵死判定阈值 */
  heartbeatTimeoutMs: number;
  /** init 消息携带的工具模块路径（worker 重建注册表） */
  toolModules: string[];
  /**
   * 可选资源审计（M5 Windows 顶替 Job Object 的进程树审计）：
   * spawn 后以 worker pid 解析（工厂形）；周期采样进程树规模/内存，
   * 超限返回 kill 原因（事后审计语义，非硬配额）。
   */
  audit?: (childPid: number) => ResourceAudit | undefined;
}

/** 资源审计接口：平台实现（audit-win）注入，状态机只管周期与 kill */
export interface ResourceAudit {
  /** 采样间隔（毫秒） */
  intervalMs: number;
  /** 采样一次；undefined = 本轮无数据（探测失败等，静默跳过） */
  sample(): Promise<{ processes: number; memoryBytes: number } | undefined>;
  /** 阈值判定：超限返回 kill 原因字符串，未超限返回 undefined */
  check(sample: { processes: number; memoryBytes: number }): string | undefined;
}

async function runInWorker(
  workerPath: string,
  opts: WorkerRunOptions,
  req: SandboxRunRequest,
): Promise<ToolResult> {
  // ── 沙箱临时目录（HOME/TMPDIR 伪造值，用后清理）──
  const sandboxHome = await nodeFs.promises.mkdtemp(
    nodePath.join(os.tmpdir(), 'aipack-sandbox-'),
  );
  await nodeFs.promises.mkdir(nodePath.join(sandboxHome, 'tmp'), { recursive: true });
  return runProtocolSession(
    {
      argv: [process.execPath, ...opts.nodeArgs, workerPath],
      env: buildWorkerEnv(req.spec.env, sandboxHome),
      detached: !IS_WIN,
      cleanupDirs: [sandboxHome],
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
      toolModules: opts.toolModules,
      // Windows 无 OS 沙箱时（os 降级链终点），声明了 memory/processes 限额
      // 的调用启用进程树审计（M5 顶替 Job Object 的事后审计语义）
      ...(IS_WIN &&
      (req.spec.resources.memoryMb !== undefined || req.spec.resources.processes !== undefined)
        ? { audit: (pid: number) => createWindowsProcessAudit(pid, req.spec.resources) }
        : {}),
    },
    req,
  );
}

/** NDJSON 协议会话宿主侧状态机（spawn / 流处理 / 心跳 / 限额 / kill / 清理） */
export async function runProtocolSession(
  session: ProtocolSessionSpec,
  req: SandboxRunRequest,
): Promise<ToolResult> {
  const { spec, signal, toolName, toolCallId } = req;
  const emit = (type: SandboxEventType, detail?: Record<string, unknown>): void => {
    const event: SandboxEvent = {
      type,
      toolName,
      toolCallId,
      // 事件归属策略取实际 spec（Tier 2 下为 'os'，worker 侧事件同理）
      strategy: spec.strategy,
      ...(detail !== undefined ? { detail } : {}),
    };
    req.onEvent?.(event);
  };

  const child = spawn(session.argv[0], session.argv.slice(1), {
    env: session.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: session.detached,
    windowsHide: true,
  });

  // ── 执行状态 ──
  let settled = false;
  let killReason: string | undefined;
  let result: ToolResult | undefined;
  let workerError: { message: string; code?: string } | undefined;
  let outputBytes = 0;
  let stderrTail = '';
  // 心跳计时从 worker 首条消息激活（保护 spawn/加载间隙，wallClock 兜底）
  let heartbeatArmed = false;
  let lastMessageAt = Date.now();
  const timers: NodeJS.Timeout[] = [];
  const cleanup: (() => void)[] = [];
  const outputLimit = spec.resources.outputBytes ?? MAX_LINE_FALLBACK_BYTES;

  let resolveDone: ((r: ToolResult) => void) | undefined;
  const done = new Promise<ToolResult>(resolve => {
    resolveDone = resolve;
  });

  const doSettle = (): void => {
    if (settled) return;
    settled = true;
    for (const t of timers) clearTimeout(t);
    for (const fn of cleanup) fn();
    emit('exit', {
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      killed: killReason,
      outputBytes,
      ...(stderrTail !== '' ? { stderrTail } : {}),
    });
    resolveDone?.(buildFinalResult());
  };

  const killNow = (reason: string): void => {
    if (settled || killReason !== undefined) return;
    killReason = reason;
    emit('killed', { reason });
    // 杀树命令完成后 settle（taskkill /F 返回时目标已终止）
    void killTree(child).then(doSettle);
  };

  const buildFinalResult = (): ToolResult => {
    if (result !== undefined) return result;
    if (workerError !== undefined) {
      return errorResult(`sandbox worker error: ${workerError.message}`, {
        code: workerError.code,
        stderrTail,
      });
    }
    if (killReason !== undefined) {
      const reasonDetail =
        killReason === 'output-limit'
          ? `sandbox output limit exceeded (${outputBytes} bytes received, ` +
            `limit ${spec.resources.outputBytes ?? 'internal'}); output truncated`
          : `sandbox worker killed: ${killReason}`;
      return errorResult(reasonDetail, {
        killed: killReason,
        outputBytes,
        ...(stderrTail !== '' ? { stderrTail } : {}),
      });
    }
    return errorResult(
      `sandbox worker exited unexpectedly ` +
      `(code=${child.exitCode ?? 'null'} signal=${child.signalCode ?? 'null'})`,
      { stderrTail },
    );
  };

  function errorResult(message: string, extra?: Record<string, unknown>): ToolResult {
    return { content: [createTextContent(message)], details: { error: message, ...extra } };
  }

  // ── 流处理 ──
  // 流错误兜底（EPIPE 等），防 unhandled error 崩宿主
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', () => {
      // 写入已死进程的 stdin 等场景：静默，由 exit/killed 路径收尾
    });
  }

  const countOutput = (chunk: Buffer): void => {
    if (killReason !== undefined) return; // kill 后不再累计（输出截断语义）
    // 单 data chunk 原子到达：计入量按限额截断（宿主消费到 outputLimit 即杀，
    // 不因一个大 chunk 把计数推过限值——报告的 outputBytes 反映截断语义）
    const room = Math.max(0, outputLimit - outputBytes);
    outputBytes += Math.min(chunk.length, room);
    if (chunk.length > room) killNow('output-limit');
  };

  // ready 后发送 exec（注册表就绪保证）；sentExec 保证单次
  let sentExec = false;
  const sendExec = (): void => {
    if (sentExec) return;
    sentExec = true;
    const msg: HostMessage = { op: 'exec', toolName, toolCallId, args: req.args };
    child.stdin!.write(JSON.stringify(msg) + '\n');
  };

  let pending = '';
  const handleMessage = (line: string): void => {
    lastMessageAt = Date.now();
    let msg: WorkerMessage;
    try {
      msg = JSON.parse(line) as WorkerMessage;
    } catch {
      return; // 畸形行（协议容错）：忽略
    }
    switch (msg.op) {
      case 'ready':
        heartbeatArmed = true;
        sendExec();
        break;
      case 'heartbeat':
        break; // 仅刷新时间戳
      case 'event':
        req.onEvent?.(msg.event);
        break;
      case 'result':
        result = msg.toolResult;
        break;
      case 'error':
        workerError = { message: msg.message, code: msg.code };
        break;
    }
  };

  child.stdout!.on('data', (chunk: Buffer) => {
    countOutput(chunk);
    lastMessageAt = Date.now();
    if (killReason !== undefined || settled) return;
    pending += chunk.toString('utf8');
    let idx: number;
    while ((idx = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      if (line.trim() !== '') handleMessage(line);
    }
    if (pending.length > outputLimit) killNow('output-limit');
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    countOutput(chunk);
    // 保留诊断尾部（worker 转发的工具 stdout 与原生诊断均在此）
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  // ── 生命周期事件 ──
  child.on('error', err => {
    // spawn 失败（node 缺失等）：无进程可等，直接 settle
    if (!settled && killReason === undefined && workerError === undefined) {
      workerError = { message: `worker spawn failed: ${(err as Error).message}` };
    }
    doSettle();
  });
  child.on('exit', () => {
    doSettle(); // 正常 result 自退 / 强杀后收尾，幂等
  });

  emit('spawn', { pid: child.pid, argv0: session.argv[0] });

  // ── 触发器：wallClock / 心跳 / abort ──
  if (spec.resources.wallClockMs !== undefined) {
    timers.push(
      setTimeout(() => killNow('wall-clock-timeout'), spec.resources.wallClockMs),
    );
  }
  timers.push(
    setInterval(() => {
      if (!heartbeatArmed) return;
      if (Date.now() - lastMessageAt > session.heartbeatTimeoutMs) {
        killNow('heartbeat-lost');
      }
    }, 500),
  );
  // 资源审计（可选）：采样失败静默跳过，超限走统一 kill 路径（killed 事件带原因）
  const audit = child.pid !== undefined ? session.audit?.(child.pid) : undefined;
  if (audit !== undefined) {
    const auditTimer = setInterval(() => {
      void audit.sample().then(s => {
        if (settled || s === undefined) return;
        const reason = audit.check(s);
        if (reason !== undefined) killNow(reason);
      }).catch(() => { /* 采样失败静默：审计不成为故障源 */ });
    }, audit.intervalMs);
    timers.push(auditTimer);
  }
  if (signal.aborted) {
    killNow('aborted');
  } else {
    const onAbort = () => killNow('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    cleanup.push(() => signal.removeEventListener('abort', onAbort));
  }

  // ── 发送 init（spawn 后立即写 stdin，worker 启动后消费）──
  const init: HostMessage = { op: 'init', toolModules: session.toolModules, spec };
  child.stdin!.write(JSON.stringify(init) + '\n');
  // exec 在收到 ready 时发送（见 handleMessage），保证注册表就绪

  // ── 收尾：等结果 → 杀残留 → 清理会话宿主目录 ──
  const final = await done;
  await killTree(child); // 兜底（正常路径 worker 已自退，no-op）
  for (const dir of session.cleanupDirs) {
    try {
      await nodeFs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄释放竞态：延迟重试一次后放弃（临时目录由 OS 兜底回收）
      await new Promise(r => setTimeout(r, 200));
      await nodeFs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return final;
}
