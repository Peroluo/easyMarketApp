/**
 * runtime/sandbox/bwrap - Tier 2 Linux OS 沙箱 provider（bwrap 命名空间）
 *
 * 真正的安全边界（与 Tier 1 软约束的本质区别）：工具进程在 bubblewrap 构造的
 * mount/pid/net 命名空间内运行，未挂载路径**不可见**（内核强制，绕过需内核漏洞）：
 * - fs：最小挂载面——系统目录只读 ro-bind、readable 前缀 ro-bind、writable
 *   前缀 bind；deny 路径在挂载序列末尾以 tmpfs（目录）/ 空文件 ro-bind（文件）
 *   覆盖遮蔽；其余宿主路径一律不存在；
 * - net：deny（含 proxy，broker 未实现前保守处理）→ --unshare-net 内核级断网；
 * - env：--clearenv + --setenv 白名单（HOME=沙箱内 tmpfs，绝不继承宿主）；
 * - 进程：--unshare-user（显式 user namespace，root 无 CAP_SYS_ADMIN 时必须
 *   走 unprivileged 路径）+ --unshare-pid（pid 隔离）+ --die-with-parent；
 * - 配额：cgroup v2 + systemd 可用时经 systemd-run --scope 施加
 *   MemoryMax/CPUQuota/TasksMax 硬配额；不可用则直跑 bwrap（丢配额保边界）。
 *
 * 降级链（M3 ToolExecutor + default.ts 路由）：无 bwrap → subprocess + degraded；
 * enforced 严格模式 → 直接拒绝。
 * worker 内 fs facade 仍然生效（spec 经 init 下发）：边界由内核，facade 提供
 * 工具层一致的 violation 遥测信号。
 */

import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { isPathWithin } from '../../core/sandbox';
import type {
  SandboxProvider,
  SandboxRunRequest,
  SandboxSpec,
  SandboxStrategy,
} from '../../core/sandbox';
import type { ToolResult } from '../../core/types';
import { HEARTBEAT_TIMEOUT_DEFAULT_MS } from './protocol';
import { resolveWorkerPath, runProtocolSession } from './subprocess';

const IS_LINUX = process.platform === 'linux';

/** 系统目录只读白名单（存在性探测后进入 argv） */
const SYSTEM_RO_DIRS = [
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/run',
];
/** 沙箱内 PATH（最小系统面） */
const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin';
/** 沙箱内 HOME（tmpfs，与宿主 HOME 完全隔离） */
const SANDBOX_HOME = '/tmp/aipack-sandbox-home';

// ─── 能力探测（结果缓存）────────────────────────────────────────────

export interface LinuxSandboxCaps {
  /** bwrap 可执行（版本探测成功） */
  bwrap: boolean;
  /** cgroup v2（/sys/fs/cgroup/cgroup.controllers 存在） */
  cgroupV2: boolean;
  /** systemd-run 可执行（配额包装器） */
  systemdRun: boolean;
  /** 配额可施加 = cgroup v2 且 systemd-run 可用 */
  readonly quota: boolean;
}

const capsCache: { promise: Promise<LinuxSandboxCaps> | undefined } = { promise: undefined };

/** 探测结果包一层默认值，避免类型收窄问题 */
function withQuota(c: Omit<LinuxSandboxCaps, 'quota'>): LinuxSandboxCaps {
  return { ...c, quota: c.bwrap && c.cgroupV2 && c.systemdRun };
}

async function probeCommand(bin: string): Promise<boolean> {
  return new Promise(resolve => {
    const p = spawn(bin, ['--version'], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', code => resolve(code === 0));
  });
}

/**
 * bwrap 可用性真实验证：--version 只证明二进制存在，能否构造沙箱取决于
 * userns/mountns 内核路径（容器环境常封锁 unprivileged userns，seccomp 默认
 * profile 即拒绝 unshare(CLONE_NEWUSER)）。探测形态与实际执行一致
 * （--unshare-user + 最小 ro-bind），通过 = 内核路径全通。
 */
function probeBwrapSandbox(): Promise<boolean> {
  return new Promise(resolve => {
    const argv = [
      '--unshare-user',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--', '/bin/sh', '-c', 'true',
    ];
    const p = spawn('bwrap', argv, { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', code => resolve(code === 0));
  });
}

/** Linux 沙箱能力探测（缓存；非 Linux 平台全 false） */
export function probeLinuxSandboxCaps(): Promise<LinuxSandboxCaps> {
  if (!IS_LINUX) {
    return Promise.resolve(withQuota({ bwrap: false, cgroupV2: false, systemdRun: false }));
  }
  capsCache.promise ??= (async () =>
    withQuota({
      bwrap: await probeBwrapSandbox(),
      cgroupV2: nodeFs.existsSync('/sys/fs/cgroup/cgroup.controllers'),
      systemdRun: await probeCommand('systemd-run'),
    }))();
  return capsCache.promise;
}

// ─── fs spec → bwrap 参数映射（纯函数，跨平台可测）───────────────────

export interface BwrapArgvOptions {
  /** bwrap 可执行路径/命令名（缺省 'bwrap'） */
  bwrapBin?: string;
  /** worker 解释器（node 路径） */
  nodeBin: string;
  /** worker 入口脚本（宿主绝对路径） */
  workerPath: string;
  /** node 附加参数（如 --import tsx） */
  nodeArgs?: string[];
  /** 工具模块路径（宿主绝对路径，worker 按名重建注册表） */
  toolModules?: string[];
  /** deny 文件遮蔽用空文件（宿主绝对路径，bwrap 调用方准备） */
  denyEmptyFile?: string;
  /** 是否施加 systemd-run 配额包装（探测可用时） */
  useQuota?: boolean;
  /** spec.strategy（仅 os 走此 provider） */
}

/** 挂载去重：path 已被 mounted 任一前缀覆盖则无需再挂 */
function isCoveredBy(path: string, mounted: readonly string[]): boolean {
  return mounted.some(m => isPathWithin(path, m));
}

/** 可执行负载前的配额包装段（systemd-run 在 bwrap 内、payload 前） */
function quotaPrefix(spec: SandboxSpec): string[] {
  const r = spec.resources;
  const props: string[] = [];
  if (r.memoryMb !== undefined) props.push(`-p`, `MemoryMax=${r.memoryMb}M`);
  if (r.cpuMs !== undefined) {
    // cpuMs 语义 = 每秒 CPU 时间预算（毫秒）→ CPUQuota 百分比（1000ms → 100%）
    props.push('-p', `CPUQuota=${Math.max(1, Math.round(r.cpuMs / 10))}%`);
  }
  if (r.processes !== undefined) props.push('-p', `TasksMax=${r.processes}`);
  if (props.length === 0) return [];
  return ['systemd-run', '--scope', '--quiet', ...props];
}

/**
 * 生成完整 bwrap 命令行（纯函数）。挂载顺序 = 遮蔽语义的关键：
 * 系统 ro-bind → readable ro-bind → writable bind → deny 遮蔽（末尾生效）。
 * deny 为目录 → --tmpfs 覆盖；为文件（或已存在）→ 空文件 ro-bind 覆盖；
 * 宿主不存在且未被任何前缀覆盖的 deny 路径本就不可见，跳过。
 */
export function buildBwrapArgv(spec: SandboxSpec, o: BwrapArgvOptions): string[] {
  const argv: string[] = [o.bwrapBin ?? 'bwrap'];
  const mounted: string[] = [];

  // 1. 系统目录只读挂载（运行环境 + systemd dbus socket /run）
  for (const dir of SYSTEM_RO_DIRS) {
    if (IS_LINUX && !nodeFs.existsSync(dir)) continue; // 探测仅在目标平台有意义
    argv.push('--ro-bind', dir, dir);
    mounted.push(dir);
  }
  // 2. proc/dev/tmp 基础设施：必须先于一切数据面/基础设施 bind——后续 bind
  //    的目标可能位于 /tmp 下（测试 fixture、workspace 常见），先 --tmpfs /tmp
  //    再 bind 才不被遮蔽（bwrap 按命令行顺序挂载，后挂遮蔽先挂）
  argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  // 3. node/worker/toolModules 所在目录只读（基础设施可见性，非数据面授权：
  //    worker 自身的 fs facade 仍按 spec 校验工具的数据访问）
  for (const infra of [o.nodeBin, o.workerPath, ...(o.toolModules ?? [])]) {
    const dir = nodePath.dirname(infra);
    if (isCoveredBy(dir, mounted)) continue;
    argv.push('--ro-bind', dir, dir);
    mounted.push(dir);
  }

  // 4. readable 只读 / writable 可写（去重：已被更强前缀覆盖的跳过）
  for (const p of spec.fs.readable) {
    if (isCoveredBy(p, mounted)) continue;
    argv.push('--ro-bind', p, p);
    mounted.push(p);
  }
  for (const p of spec.fs.writable) {
    if (isCoveredBy(p, mounted)) continue;
    argv.push('--bind', p, p);
    mounted.push(p);
  }

  // 5. deny 遮蔽（挂载序末尾 → 覆盖前面一切可见性）
  for (const deny of spec.fs.deny ?? []) {
    let isDir = false;
    try {
      isDir = nodeFs.statSync(deny).isDirectory();
    } catch {
      // 宿主不存在：若未被覆盖则本就不可见，跳过；被覆盖（如 workspace 下
      // 尚未生成的文件名）→ 保守按文件遮蔽
      if (!isCoveredBy(deny, mounted)) continue;
      isDir = false;
    }
    if (isDir) argv.push('--tmpfs', deny);
    else if (o.denyEmptyFile !== undefined) {
      argv.push('--ro-bind', o.denyEmptyFile, deny);
    }
  }

  // 6. 环境：清空 + 白名单（HOME=沙箱内 tmpfs；PATH 最小系统面）
  argv.push('--tmpfs', SANDBOX_HOME, '--clearenv');
  argv.push('--setenv', 'HOME', SANDBOX_HOME);
  argv.push('--setenv', 'TMPDIR', SANDBOX_HOME);
  argv.push('--setenv', 'PATH', SANDBOX_PATH);
  for (const [k, v] of Object.entries(spec.env)) {
    argv.push('--setenv', k, v);
  }

  // 7. 网络与进程命名空间
  if (spec.net.mode !== 'allow') {
    // deny → 内核断网；proxy → broker（M6）未实现前保守断网
    argv.push('--unshare-net');
  }
  // --unshare-user 显式声明：root 但无 CAP_SYS_ADMIN（容器）时 bwrap 不会自动
  // 走 unprivileged 路径（默认直接 unshare(CLONE_NEWNS) → EPERM）；桌面非 root
  // 场景与 bwrap 默认 unprivileged 行为一致
  argv.push('--unshare-user', '--unshare-pid', '--die-with-parent');

  // 8. 配额包装（可选）+ payload
  if (o.useQuota) argv.push(...quotaPrefix(spec));
  argv.push(o.nodeBin, ...(o.nodeArgs ?? []), o.workerPath);
  return argv;
}

// ─── Provider ────────────────────────────────────────────────────────

export interface BwrapSandboxProviderOptions {
  /** bwrap 可执行覆盖（缺省 PATH 上的 bwrap） */
  bwrapBin?: string;
  /** worker 入口脚本显式覆盖（缺省自动解析，同 Tier 1） */
  workerPath?: string;
  /** node 附加参数（如测试直跑 TS 源码：['--import','tsx']） */
  nodeArgs?: string[];
  /** 心跳僵死判定阈值 */
  heartbeatTimeoutMs?: number;
  /** worker 进程加载的工具模块路径 */
  toolModules?: string[];
}

export class BwrapSandboxProvider implements SandboxProvider {
  private readonly _bwrapBin: string;
  private readonly _workerPath: string | undefined;
  private readonly _nodeArgs: string[];
  private readonly _heartbeatTimeoutMs: number;
  private readonly _toolModules: string[];

  constructor(options: BwrapSandboxProviderOptions = {}) {
    this._bwrapBin = options.bwrapBin ?? 'bwrap';
    this._workerPath = options.workerPath ?? resolveWorkerPath();
    this._nodeArgs = options.nodeArgs ?? [];
    this._heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_DEFAULT_MS;
    this._toolModules = options.toolModules ?? [];
  }

  async supports(strategy: SandboxStrategy): Promise<boolean> {
    if (strategy !== 'os') return false;
    if (!IS_LINUX || this._workerPath === undefined) return false;
    const caps = await probeLinuxSandboxCaps();
    return caps.bwrap;
  }

  async run(req: SandboxRunRequest): Promise<ToolResult> {
    if (!IS_LINUX || this._workerPath === undefined || !(await this.supports('os'))) {
      throw new Error(
        'BwrapSandboxProvider: bwrap sandbox unavailable on this platform ' +
        '(route via createDefaultSandboxProvider for degradation)',
      );
    }
    if (req.spec.strategy !== 'os') {
      throw new Error(
        `BwrapSandboxProvider: unsupported strategy "${req.spec.strategy}"`,
      );
    }
    const caps = await probeLinuxSandboxCaps();

    // deny 文件遮蔽用空文件（宿主侧准备，会话后清理）
    const denyDir = await nodeFs.promises.mkdtemp(
      nodePath.join(os.tmpdir(), 'aipack-bwrap-'),
    );
    const denyEmptyFile = nodePath.join(denyDir, 'empty');
    await nodeFs.promises.writeFile(denyEmptyFile, '');

    const argv = buildBwrapArgv(req.spec, {
      bwrapBin: this._bwrapBin,
      nodeBin: process.execPath,
      workerPath: this._workerPath,
      nodeArgs: this._nodeArgs,
      toolModules: this._toolModules,
      denyEmptyFile,
      useQuota: caps.quota,
    });

    // bwrap 自身用宿主 PATH 定位；沙箱内 env 已由 --clearenv/--setenv 构造
    return runProtocolSession(
      {
        argv,
        env: { PATH: process.env.PATH ?? SANDBOX_PATH },
        detached: true,
        cleanupDirs: [denyDir],
        heartbeatTimeoutMs: this._heartbeatTimeoutMs,
        toolModules: this._toolModules,
      },
      req,
    );
  }
}
