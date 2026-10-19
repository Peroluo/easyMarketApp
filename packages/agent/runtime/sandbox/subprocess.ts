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
  type RequestSecretMessage,
  type SecretMessage,
  type WorkerMessage,
} from './protocol';
import { createWindowsProcessAudit } from './audit-win';
import { makeSandboxEmit, startNetProxyForSpec } from './net-proxy';

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

// ─── worker 池（M8：同 spec 复用空闲 worker）────────────────────────

/** 池配置：maxWorkers=0 关闭池化（每次调用完整 spawn → init → 单轮 → 自退） */
export interface SubprocessPoolOptions {
  /** 同指纹空闲 worker 容量上限（默认 3；超出 LRU 逐出最旧） */
  maxWorkers?: number;
  /** 空闲 worker 回收时长毫秒（默认 60s） */
  idleTtlMs?: number;
}

const POOL_MAX_WORKERS_DEFAULT = 3;
const POOL_IDLE_TTL_MS_DEFAULT = 60_000;
/** 空闲 TTL 扫描周期 */
const POOL_SWEEP_INTERVAL_MS = 500;

/**
 * spec 稳定指纹：可复用的判据 = worker 初始化面完全一致（fs/net/secrets/
 * env/资源声明经 init 全量下发 worker）。键排序后序列化，字段序无关。
 * per-call 差异（不同 resources 声明）自然分桶——正确性优先。
 */
function specFingerprint(spec: SandboxSpec): string {
  const keys = Object.keys(spec).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${k}=${JSON.stringify((spec as unknown as Record<string, unknown>)[k] ?? null)}`);
  }
  return parts.join('|');
}

/** 池条目：一个可复用的沙箱化 worker（协议会话 + 会话级 net-proxy + 临时 HOME） */
interface PoolEntry {
  readonly key: string;
  readonly session: ProtocolSession;
  readonly proxy: Awaited<ReturnType<typeof startNetProxyForSpec>>;
  readonly sandboxHome: string;
  /** 本轮 violation（fs/net/secret 越界）→ 回池前销毁：不可信状态不复用 */
  tainted: boolean;
  /** 最近一次回池时间（sweep 回收判据；借出期间无意义） */
  lastIdleAt?: number;
}

/**
 * worker 池：按 spec 指纹复用空闲 worker。
 * - acquire：命中指纹的空闲 entry 出池标 busy；未命中 → spawn 全新会话
 * - release：exec 轮结束且未污染未死亡 → 回池（LRU 刷新 + 空闲计时重置）；
 *   污染（violation）/ 死亡（kill/意外退出 / worker error）→ 销毁
 * - 超额：LRU 逐出最旧空闲 entry；空闲超 TTL 定期回收（sweep 定时器 unref）
 * 单线程模型内 map 操作天然互斥；销毁前先出池，无借出竞态。
 */
class SubprocessWorkerPool {
  private readonly _maxWorkers: number;
  private readonly _idleTtlMs: number;
  /** 指纹 → 空闲 entry 列表（Map 保插入序，最旧在前） */
  private readonly _idle = new Map<string, PoolEntry[]>();
  private readonly _sweeper: NodeJS.Timeout;

  constructor(options: SubprocessPoolOptions = {}) {
    this._maxWorkers = options.maxWorkers ?? POOL_MAX_WORKERS_DEFAULT;
    this._idleTtlMs = options.idleTtlMs ?? POOL_IDLE_TTL_MS_DEFAULT;
    this._sweeper = setInterval(
      () => this._sweep(Date.now()),
      POOL_SWEEP_INTERVAL_MS,
    );
    this._sweeper.unref();
  }

  get maxWorkers(): number {
    return this._maxWorkers;
  }

  /** 池路径执行：acquire（或 spawn）→ exec → release（回池或销毁） */
  async execute(
    workerPath: string,
    opts: WorkerRunOptions,
    req: SandboxRunRequest,
  ): Promise<ToolResult> {
    const key = specFingerprint(req.spec);
    const entry = this._takeIdle(key) ?? (await this._spawnEntry(workerPath, opts, req, key));
    try {
      // 轮内 violation 监听：标记污染（回池前销毁），不改变事件流向
      const wrapped: SandboxRunRequest = {
        ...req,
        onEvent: ev => {
          if (ev.type === 'violation') entry.tainted = true;
          req.onEvent?.(ev);
        },
      };
      const result = await entry.session.exec(wrapped);
      if (entry.tainted || entry.session.dead) {
        await this._destroyEntry(entry);
      } else {
        this._returnIdle(entry, Date.now());
      }
      return result;
    } catch (err) {
      await this._destroyEntry(entry);
      throw err;
    }
  }

  /** 全量回收（进程退出前显式调用；未调用时 OS 兜底收 orphan） */
  async closeAll(): Promise<void> {
    const all = [...this._idle.values()].flat();
    this._idle.clear();
    await Promise.all(all.map(e => this._destroyEntry(e)));
  }

  private _takeIdle(key: string): PoolEntry | undefined {
    const list = this._idle.get(key);
    if (list === undefined || list.length === 0) return undefined;
    // 取最新（尾端）——刚归还的热 worker 命中率高
    return list.pop();
  }

  private _returnIdle(entry: PoolEntry, now: number): void {
    if (this._maxWorkers <= 0) {
      void this._destroyEntry(entry);
      return;
    }
    entry.lastIdleAt = now;
    const list = this._idle.get(entry.key) ?? [];
    list.push(entry);
    this._idle.set(entry.key, list);
    // 全池超额：从最旧端（各指纹列表头部）逐出
    let total = this._totalIdle();
    while (total > this._maxWorkers) {
      const oldestKey = this._idle.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldestList = this._idle.get(oldestKey);
      const victim = oldestList?.shift();
      if (victim === undefined) {
        this._idle.delete(oldestKey);
      } else {
        void this._destroyEntry(victim);
      }
      total = this._totalIdle();
    }
  }

  private _totalIdle(): number {
    let n = 0;
    for (const list of this._idle.values()) n += list.length;
    return n;
  }

  private _sweep(now: number): void {
    for (const [key, list] of this._idle) {
      const expired = list.filter(e => (e.lastIdleAt ?? 0) < now - this._idleTtlMs);
      const alive = list.filter(e => (e.lastIdleAt ?? 0) >= now - this._idleTtlMs);
      if (alive.length === 0) this._idle.delete(key);
      else this._idle.set(key, alive);
      for (const e of expired) void this._destroyEntry(e);
    }
  }

  /** spawn 全新池条目：mkdtemp HOME + net-proxy + 协议会话握手 */
  private async _spawnEntry(
    workerPath: string,
    opts: WorkerRunOptions,
    req: SandboxRunRequest,
    key: string,
  ): Promise<PoolEntry> {
    const sandboxHome = await nodeFs.promises.mkdtemp(
      nodePath.join(os.tmpdir(), 'aipack-sandbox-'),
    );
    await nodeFs.promises.mkdir(nodePath.join(sandboxHome, 'tmp'), { recursive: true });
    let proxy: PoolEntry['proxy'];
    let session: ProtocolSession;
    try {
      proxy = await startNetProxyForSpec(req.spec, makeSandboxEmit(req));
      const env = buildWorkerEnv(req.spec.env, sandboxHome);
      if (proxy !== undefined) Object.assign(env, proxy.env);
      session = await ProtocolSession.create(
        {
          argv: [process.execPath, ...opts.nodeArgs, workerPath],
          env,
          detached: !IS_WIN,
          cleanupDirs: [sandboxHome],
          heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
          toolModules: opts.toolModules,
          ...(IS_WIN &&
          (req.spec.resources.memoryMb !== undefined || req.spec.resources.processes !== undefined)
            ? { audit: (pid: number) => createWindowsProcessAudit(pid, req.spec.resources) }
            : {}),
        },
        req,
      );
    } catch (err) {
      // spawn/proxy/握手失败：清理已建资源后向上抛
      await proxy?.forwarder.close().catch(() => {});
      await nodeFs.promises.rm(sandboxHome, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    return { key, session, proxy, sandboxHome, tainted: false };
  }

  /** 销毁：协议会话（shutdown→杀树→HOME 清理）+ net-proxy 关闭 */
  private async _destroyEntry(entry: PoolEntry): Promise<void> {
    await entry.session.destroy().catch(() => {});
    await entry.proxy?.forwarder.close().catch(() => {});
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
  /**
   * worker 池（M8）：同 spec 空闲 worker 复用（spawn→init 握手开销摊销）。
   * 缺省 { maxWorkers: 3, idleTtlMs: 60000 }；maxWorkers: 0 关闭（单次语义）。
   * 污染（violation）/ kill / 意外退出的 worker 不复用（回池前销毁）。
   */
  pool?: SubprocessPoolOptions;
}

export class SubprocessSandboxProvider implements SandboxProvider {
  private readonly _workerPath: string | undefined;
  private readonly _nodeArgs: string[];
  private readonly _heartbeatTimeoutMs: number;
  private readonly _toolModules: string[];
  private readonly _pool: SubprocessWorkerPool | undefined;

  constructor(options: SubprocessSandboxProviderOptions = {}) {
    // 显式 workerPath 直接信任（配置错误在 run 时以 spawn error 显式失败）
    this._workerPath = options.workerPath ?? resolveWorkerPath();
    this._nodeArgs = options.nodeArgs ?? [];
    this._heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_DEFAULT_MS;
    this._toolModules = options.toolModules ?? [];
    const poolOptions = options.pool === undefined
      ? {} as SubprocessPoolOptions
      : options.pool;
    this._pool = (poolOptions.maxWorkers ?? POOL_MAX_WORKERS_DEFAULT) > 0
      ? new SubprocessWorkerPool(poolOptions)
      : undefined;
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
    const opts: WorkerRunOptions = {
      nodeArgs: this._nodeArgs,
      heartbeatTimeoutMs: this._heartbeatTimeoutMs,
      toolModules: this._toolModules,
    };
    // 池化路径（M8）：同 spec 复用空闲 worker；未配置池走单次语义
    if (this._pool !== undefined) {
      return this._pool.execute(this._workerPath, opts, req);
    }
    return runInWorker(this._workerPath, opts, req);
  }

  /** 回收池内全部空闲 worker（进程收尾显式调用；未调用由 OS 兜底） */
  async close(): Promise<void> {
    await this._pool?.closeAll();
  }
}

// ─── 协议会话（多轮 exec；M8 池化的基础）────────────────────────────

interface WorkerRunOptions {
  nodeArgs: string[];
  heartbeatTimeoutMs: number;
  toolModules: string[];
}

/** 未设 outputBytes 时的行缓冲硬顶（防 worker 异常输出无界行撑爆宿主） */
const MAX_LINE_FALLBACK_BYTES = 8 * 1024 * 1024;
/** stderr 诊断尾部保留量（error 结果附带） */
const STDERR_TAIL_BYTES = 4096;
/** destroy() 等 worker 优雅退出的上限；超时兜底强杀（防僵尸进程） */
const SHUTDOWN_GRACE_MS = 2_000;

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
  /**
   * secrets broker 宿主侧凭证解析（M6）：按名解析宿主持有凭证，
   * 缺省 process.env[name]。裁决（spec.secrets 白名单）在状态机内，
   * 此 hook 只管取值——凭证源可注入（测试/自定义存储）。
   */
  resolveSecret?: (name: string) => string | undefined;
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

/**
 * NDJSON 协议会话（宿主侧状态机，M8 起支持多轮 exec 复用同一 worker）：
 * - create：spawn → init → ready 握手（注册表就绪），挂会话级心跳监控
 * - exec：单轮工具调用（per-call 触发器 wallClock/abort/audit、输出封顶计数）
 * - destroy：shutdown/EOF 优雅退出（限时）→ 兜底杀树 → 清理会话宿主目录 → exit 事件
 *
 * 事件序列语义：spawn（create 时）→ [violation/degraded/killed...]（exec 轮）→
 * exit（destroy 时）。单次会话（runProtocolSession 薄封装）与既有行为一致。
 */
export class ProtocolSession {
  private readonly _child: ChildProcess;
  private readonly _session: ProtocolSessionSpec;
  private readonly _spec: SandboxSpec;
  /**
   * 事件归属的当前请求（M8 多轮化）：exec 轮内置为本轮 req，
   * 空闲期/销毁期事件（心跳 kill、exit 等）归属最近一次交互的 req。
   */
  private _currentReq: SandboxRunRequest;
  /** 心跳计时从 worker 首条 stdout 消息激活（保护 spawn/加载间隙） */
  private _heartbeatArmed = false;
  private _lastMessageAt = Date.now();
  private _stderrTail = '';
  /** 会话是否已终结（kill / worker 自退 / destroy 完成） */
  private _dead = false;
  private _killReason: string | undefined;
  private _exitEmitted = false;
  /** 当前 exec 轮状态（无进行中轮时为 undefined） */
  private _round: RoundState | undefined;
  private readonly _heartbeatTimer: NodeJS.Timeout;

  /** 握手期（create 等 ready 期间）失败通知；create 完成后置 undefined */
  private _failHandshake: ((err: Error) => void) | undefined;

  private constructor(
    child: ChildProcess,
    session: ProtocolSessionSpec,
    spec: SandboxSpec,
    req: SandboxRunRequest,
  ) {
    this._child = child;
    this._session = session;
    this._spec = spec;
    this._currentReq = req;
    this._heartbeatTimer = setInterval(() => {
      if (!this._heartbeatArmed) return;
      if (Date.now() - this._lastMessageAt > session.heartbeatTimeoutMs) {
        this.killNow('heartbeat-lost');
      }
    }, 500);
  }

  /** 会话事件出口：归属当前轮请求（spec 实际策略语义与单次路径一致） */
  private _emitEvent(type: SandboxEventType, detail?: Record<string, unknown>): void {
    const event: SandboxEvent = {
      type,
      toolName: this._currentReq.toolName,
      toolCallId: this._currentReq.toolCallId,
      strategy: this._spec.strategy,
      ...(detail !== undefined ? { detail } : {}),
    };
    this._currentReq.onEvent?.(event);
  }

  /** spawn + init + ready 握手；失败/中途退出 → 抛 error（调用方无需 destroy） */
  static async create(
    session: ProtocolSessionSpec,
    req: SandboxRunRequest,
  ): Promise<ProtocolSession> {
    const { spec } = req;

    const child = spawn(session.argv[0], session.argv.slice(1), {
      env: session.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: session.detached,
      windowsHide: true,
    });

    const self = new ProtocolSession(child, session, spec, req);
    // 握手期失败通道：spawn error / worker 握手期退出 / error 消息 → 抛出 create
    const failure = new Promise<never>((_, reject) => {
      self._failHandshake = (err: Error): void => {
        reject(err);
      };
    });
    failure.catch(() => { /* 无人 race 时防 unhandledRejection */ });

    child.once('error', err => {
      if (!self._dead) {
        self._dead = true;
        self._failHandshake?.(new Error(`worker spawn failed: ${(err as Error).message}`));
      }
    });

    // 流错误兜底（EPIPE 等），防 unhandled error 崩宿主
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => {
        // 写入已死进程的 stdin 等场景：静默，由 exit/killed 路径收尾
      });
    }

    self._emitEvent('spawn', { pid: child.pid, argv0: session.argv[0] });

    // net.mode 'allow'（显式直连，宽松上限）：发遥测告警提示收敛到 proxy/deny
    if (spec.net.mode === 'allow') {
      self._emitEvent('degraded', {
        reason: 'net-allow-direct',
        hint: 'unrestricted network access; prefer net.mode "proxy" (audited allow-list) or "deny"',
      });
    }

    // ── stdout 协议流（会话级持续解析；exec 轮间心跳也在此刷新时间戳）──
    child.stdout!.on('data', (chunk: Buffer) => {
      self._lastMessageAt = Date.now();
      if (self._dead) return;
      self._roundOutput(chunk);
      self._pending += chunk.toString('utf8');
      let idx: number;
      while ((idx = self._pending.indexOf('\n')) >= 0) {
        const line = self._pending.slice(0, idx);
        self._pending = self._pending.slice(idx + 1);
        if (line.trim() !== '') self._handleLine(line);
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      self._roundOutput(chunk);
      // 保留诊断尾部（worker 转发的工具 stdout 与原生诊断均在此）
      self._stderrTail = (self._stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });

    child.once('exit', () => {
      self._onWorkerExit();
    });

    // ── 发送 init（spawn 后立即写 stdin，worker 启动后消费）──
    const init: HostMessage = { op: 'init', toolModules: session.toolModules, spec };
    child.stdin!.write(JSON.stringify(init) + '\n');

    // ── 等 ready 握手（或握手期失败：spawn error / worker 提前退出 / error 消息）──
    const readyPromise = new Promise<void>(resolve => {
      self._resolveReady = resolve;
    });
    try {
      await Promise.race([readyPromise, failure]);
    } catch (err) {
      // 握手失败：收尾会话资源（临时目录等）后向上抛
      await self.destroy().catch(() => {});
      throw err;
    }
    self._resolveReady = undefined;
    self._failHandshake = undefined;
    return self;
  }

  private _resolveReady: (() => void) | undefined;
  private _pending = '';

  /** 单轮 exec（per-call 触发器在轮内挂/卸；kill 作用于整个会话） */
  async exec(req: SandboxRunRequest): Promise<ToolResult> {
    if (this._dead) {
      return this._buildDeadResult('sandbox worker session already terminated');
    }
    if (this._round !== undefined) {
      // 单会话串行协议：并发轮会覆盖前一轮的 resolve，显式拒绝防挂死
      return this._buildDeadResult(
        'concurrent exec on a single protocol session is not supported',
      );
    }
    const { spec, signal, toolName, toolCallId } = req;
    this._currentReq = req; // 事件归属本轮
    const outputLimit = spec.resources.outputBytes ?? MAX_LINE_FALLBACK_BYTES;
    const round: RoundState = {
      req,
      outputLimit,
      outputBytes: 0,
      resolve: undefined as unknown as (r: ToolResult) => void,
      timers: [],
      cleanup: [],
    };
    const done = new Promise<ToolResult>(resolve => {
      round.resolve = resolve;
    });
    this._round = round;

    // ── per-call 触发器：wallClock / abort / 审计 ──
    if (spec.resources.wallClockMs !== undefined) {
      round.timers.push(
        setTimeout(() => this.killNow('wall-clock-timeout'), spec.resources.wallClockMs),
      );
    }
    if (signal.aborted) {
      this.killNow('aborted');
    } else {
      const onAbort = (): void => this.killNow('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      round.cleanup.push(() => signal.removeEventListener('abort', onAbort));
    }
    const audit =
      this._child.pid !== undefined
        ? this._session.audit?.(this._child.pid)
        : undefined;
    if (audit !== undefined) {
      const auditTimer = setInterval(() => {
        void audit.sample().then(s => {
          if (this._dead || this._round !== round || s === undefined) return;
          const reason = audit.check(s);
          if (reason !== undefined) this.killNow(reason);
        }).catch(() => { /* 采样失败静默：审计不成为故障源 */ });
      }, audit.intervalMs);
      round.timers.push(auditTimer);
    }

    // 发送 exec（create 已保证 ready 握手完成，注册表就绪）
    const execMsg: HostMessage = { op: 'exec', toolName, toolCallId, args: req.args };
    this._child.stdin!.write(JSON.stringify(execMsg) + '\n');

    const final = await done;
    // 轮收尾：卸触发器；会话已被 kill（轮触发器所致）→ 完成销毁收尾
    for (const t of round.timers) clearTimeout(t);
    for (const fn of round.cleanup) fn();
    this._round = undefined;
    if (this._dead && !this._destroyed) await this._finalize();
    return final;
  }

  private _destroyed = false;

  /** 会话终结收尾：杀树（幂等）+ 销毁 stdio + 清理宿主目录 + exit 事件（一次性） */
  private async _finalize(): Promise<void> {
    if (this._destroyed) return;
    this._destroyed = true;
    clearInterval(this._heartbeatTimer);
    await killTree(this._child);
    // 显式销毁 stdio：Windows taskkill 强杀下管道无 EOF，句柄悬挂会阻止
    // 宿主事件循环自然退出（PipeWrap/ProcessWrap 残留）
    this._child.stdin?.destroy();
    this._child.stdout?.destroy();
    this._child.stderr?.destroy();
    for (const dir of this._session.cleanupDirs) {
      try {
        await nodeFs.promises.rm(dir, { recursive: true, force: true });
      } catch {
        // Windows 句柄释放竞态：延迟重试一次后放弃（临时目录由 OS 兜底回收）
        await new Promise(r => setTimeout(r, 200));
        await nodeFs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!this._exitEmitted) {
      this._exitEmitted = true;
      this._emitEvent('exit', {
        exitCode: this._child.exitCode,
        signalCode: this._child.signalCode,
        killed: this._killReason,
        outputBytes: this._round?.outputBytes ?? this._lastRoundOutputBytes,
        ...(this._stderrTail !== '' ? { stderrTail: this._stderrTail } : {}),
      });
    }
  }

  /** 主动销毁（单次语义收尾 / 池回收）：shutdown 优雅退出 → 限时 → 兜底强杀 */
  async destroy(): Promise<void> {
    if (this._dead && this._destroyed) return;
    if (!this._dead) {
      this._dead = true;
      clearInterval(this._heartbeatTimer);
      // 优雅路径：shutdown → EOF（worker exit）；限时兜底 killTree
      try {
        this._child.stdin!.write(JSON.stringify({ op: 'shutdown' } satisfies HostMessage) + '\n');
        this._child.stdin!.end();
      } catch {
        // 已死流：走强杀
      }
      const exited = new Promise<void>(resolve => {
        if (this._child.exitCode !== null || this._child.signalCode !== null) resolve();
        else this._child.once('exit', () => resolve());
      });
      await Promise.race([
        exited,
        new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref?.()),
      ]);
    }
    await this._finalize();
  }

  /** 会话是否已死（kill / 意外退出 / destroy） */
  get dead(): boolean {
    return this._dead;
  }

  private _lastRoundOutputBytes = 0;

  /** kill 语义：整个会话强杀（工具调用轮触发器越界 → 该 worker 不可信，销毁） */
  private killNow(reason: string): void {
    if (this._dead || this._killReason !== undefined) return;
    this._killReason = reason;
    this._dead = true;
    clearInterval(this._heartbeatTimer);
    this._emitEvent('killed', { reason });
    // 本轮 pending result 以 killed 错误收尾（若还在等）
    this._round?.resolve(this._buildKilledResult(reason));
    // 杀树命令在后台完成（exit 事件到达后 _finalize 由 destroy/exec 收尾触发）
    void killTree(this._child);
  }

  private _buildKilledResult(reason: string): ToolResult {
    const bytes = this._round?.outputBytes ?? 0;
    const limit = this._round?.req.spec.resources.outputBytes ?? 'internal';
    const message =
      reason === 'output-limit'
        ? `sandbox output limit exceeded (${bytes} bytes received, limit ${limit}); output truncated`
        : `sandbox worker killed: ${reason}`;
    return {
      content: [createTextContent(message)],
      details: { error: message, killed: reason, outputBytes: bytes },
    };
  }

  private _buildDeadResult(reason: string): ToolResult {
    return {
      content: [createTextContent(reason)],
      details: { error: reason, ...(this._stderrTail !== '' ? { stderrTail: this._stderrTail } : {}) },
    };
  }

  /** worker 进程退出（正常自退仅在 destroy 后；其余 = 意外死亡） */
  private _onWorkerExit(): void {
    if (this._dead) return; // destroy/kill 路径已收尾（_finalize 负责后续）
    this._dead = true;
    clearInterval(this._heartbeatTimer);
    if (this._resolveReady !== undefined) {
      // 握手期退出（argv 错误等）：通知 create 失败（防 ready 等待挂死）
      this._failHandshake?.(
        new Error(
          `sandbox worker exited before ready ` +
          `(code=${this._child.exitCode ?? 'null'} signal=${this._child.signalCode ?? 'null'})` +
          (this._stderrTail !== '' ? `: ${this._stderrTail}` : ''),
        ),
      );
      return;
    }
    const round = this._round;
    if (round !== undefined) {
      const message =
        `sandbox worker exited unexpectedly ` +
        `(code=${this._child.exitCode ?? 'null'} signal=${this._child.signalCode ?? 'null'})`;
      round.resolve({
        content: [createTextContent(message)],
        details: { error: message, ...(this._stderrTail !== '' ? { stderrTail: this._stderrTail } : {}) },
      });
    }
    if (!this._destroyed) void this._finalize();
  }

  /** per-round 输出计数与封顶（kill 后不再累计，输出截断语义） */
  private _roundOutput(chunk: Buffer): void {
    const round = this._round;
    if (round === undefined || this._killReason !== undefined) return;
    // 单 data chunk 原子到达：计入量按限额截断（不因一个大 chunk 把计数推过限值）
    const room = Math.max(0, round.outputLimit - round.outputBytes);
    round.outputBytes += Math.min(chunk.length, room);
    this._lastRoundOutputBytes = round.outputBytes;
    if (chunk.length > room) this.killNow('output-limit');
  }

  /** secrets broker 裁决（M6）：白名单（spec.secrets，大小写不敏感）→ 取值 → 回填 */
  private _handleSecretRequest(msg: RequestSecretMessage): void {
    const sendSecret = (m: SecretMessage): void => {
      this._child.stdin!.write(JSON.stringify(m) + '\n');
    };
    const declared = this._spec.secrets ?? [];
    const allowed = declared.some(d => d.toLowerCase() === msg.name.toLowerCase());
    if (!allowed) {
      // 未声明的凭证请求：拒绝 + violation（沙箱内永远不存在未授权凭证面）
      this._emitEvent('violation', { kind: 'secret', name: msg.name, reason: 'not-declared' });
      sendSecret({
        op: 'secret', id: msg.id, name: msg.name,
        error: `secret "${msg.name}" is not declared in spec.secrets`,
      });
      return;
    }
    // 凭证源：resolveSecret 注入（缺省宿主 process.env）——存在即全权负责
    const value = this._session.resolveSecret !== undefined
      ? this._session.resolveSecret(msg.name)
      : process.env[msg.name];
    if (value === undefined) {
      sendSecret({
        op: 'secret', id: msg.id, name: msg.name,
        error: `secret "${msg.name}" is not available on host`,
      });
      return;
    }
    sendSecret({ op: 'secret', id: msg.id, name: msg.name, value });
  }

  private _handleLine(line: string): void {
    this._lastMessageAt = Date.now();
    let msg: WorkerMessage;
    try {
      msg = JSON.parse(line) as WorkerMessage;
    } catch {
      return; // 畸形行（协议容错）：忽略
    }
    switch (msg.op) {
      case 'ready':
        this._heartbeatArmed = true;
        this._resolveReady?.();
        break;
      case 'heartbeat':
        break; // 仅刷新时间戳
      case 'event':
        // worker 侧事件（fs/net violation 等）：归属当前轮 req
        //（空闲期孤儿事件路由到最近交互轮——onEvent 仅记录，settle 后调用安全）
        this._currentReq.onEvent?.(msg.event);
        break;
      case 'request-secret':
        this._handleSecretRequest(msg);
        break;
      case 'result':
        this._round?.resolve(msg.toolResult);
        break;
      case 'error':
        this._dead = true;
        clearInterval(this._heartbeatTimer);
        if (this._resolveReady !== undefined) {
          // 握手期 worker error（init 失败等）：通知 create 失败
          this._failHandshake?.(new Error(`sandbox worker error: ${msg.message}`));
          return;
        }
        this._round?.resolve({
          content: [createTextContent(`sandbox worker error: ${msg.message}`)],
          details: { error: `sandbox worker error: ${msg.message}`, code: msg.code },
        });
        if (!this._destroyed) void this._finalize();
        break;
    }
  }
}

/** 单轮会话状态（per-call 触发器与输出计数） */
interface RoundState {
  req: SandboxRunRequest;
  outputLimit: number;
  outputBytes: number;
  resolve: (r: ToolResult) => void;
  timers: NodeJS.Timeout[];
  cleanup: (() => void)[];
}

/**
 * 单次协议会话便捷封装（bwrap/seatbelt 一次性执行路径）：
 * create → exec 一轮 → destroy。事件序列与既有单次语义一致
 * （spawn → [轮内事件] → exit）。
 */
export async function runProtocolSession(
  session: ProtocolSessionSpec,
  req: SandboxRunRequest,
): Promise<ToolResult> {
  const s = await ProtocolSession.create(session, req);
  try {
    return await s.exec(req);
  } finally {
    await s.destroy().catch(() => {});
  }
}

/** 单次执行路径（池关闭时）：完整 spawn → init → 单轮 → shutdown 销毁 */
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
  // ── net.mode 'proxy'（M6）：宿主侧 forwarder + worker env 代理注入 ──
  const proxy = await startNetProxyForSpec(req.spec, makeSandboxEmit(req));
  const env = buildWorkerEnv(req.spec.env, sandboxHome);
  if (proxy !== undefined) Object.assign(env, proxy.env);
  try {
    return await runProtocolSession(
      {
        argv: [process.execPath, ...opts.nodeArgs, workerPath],
        env,
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
  } finally {
    await proxy?.forwarder.close().catch(() => {});
  }
}
