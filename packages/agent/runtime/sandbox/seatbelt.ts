/**
 * runtime/sandbox/seatbelt - Tier 2 macOS OS 沙箱（sandbox-exec / Seatbelt）
 *
 * 与 bwrap 同构（M5：与 M4 共享 provider 接口，仅平台命令生成差异）：
 * - fs：Seatbelt 拒绝式策略——deny default 基线 + 系统/基础设施/工作区
 *   路径逐条 allow；deny 前缀显式拒绝（Seatbelt 取最具体规则优先）；
 * - net：deny 缺省（deny default 已断网）；allow → (allow network*)；
 *   proxy（M6）→ profile 放行 network-outbound 到宿主 forwarder 的
 *   127.0.0.1:port（Seatbelt 可按 remote 地址强制，比 bwrap 的 env 约定强：
 *   白名单外的直连被内核拒绝）；forwarder 不可用 → 保持 deny default；
 * - env：macOS 无 --clearenv 等价物，由宿主 spawn env 白名单构造
 *   （复用 buildWorkerEnv POSIX 分支：PATH 最小化、HOME=每次调用临时目录）；
 * - 配额：Seatbelt 无资源配额原语（超出 profile 能力），不施加
 *   （memory/processes 依赖 cgroup 类机制，macOS 无对应，留审计近似可选）。
 *
 * 状态：profile 模板生成 + provider 骨架已全平台测试；darwin 集成
 * （sandbox-exec 真跑）留 macOS CI（标记 experimental：mach-lookup 等
 * allow 面需真机校准，过宽点在 profile 注释中标注）。
 */

import { existsSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import type {
  SandboxProvider,
  SandboxRunRequest,
  SandboxStrategy,
} from '../../core/sandbox';
import type { ToolResult } from '../../core/types';
import { HEARTBEAT_TIMEOUT_DEFAULT_MS } from './protocol';
import { makeSandboxEmit, startNetProxyForSpec } from './net-proxy';
import { resolveWorkerPath, runProtocolSession, buildWorkerEnv } from './subprocess';

const IS_MAC = process.platform === 'darwin';
/** macOS sandbox-exec 路径（系统自带；Apple 标记 deprecated 但持续可用） */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** 系统只读路径（node/系统库加载基线） */
const MAC_SYSTEM_READ = ['/usr', '/bin', '/sbin', '/lib', '/etc', '/System'];

export interface SeatbeltProfileOptions {
  /** worker 的 HOME 临时目录（宿主 mkdtemp；profile 需放行读写，工具临时文件落点） */
  homePath: string;
  /** node 解释器绝对路径（process-exec 基线已全放行，此参数供未来收紧） */
  nodeBin: string;
  /** worker 入口脚本（宿主绝对路径） */
  workerPath: string;
  /** 工具模块路径（宿主绝对路径，worker 按名重建注册表） */
  toolModules?: string[];
  /**
   * 宿主 net forwarder 端口（M6 net.mode 'proxy'）：定义时 profile 放行
   * network-outbound 到 127.0.0.1:port（其余 remote 全拒 = proxy 强制边界）；
   * undefined（forwarder 不可用）→ 保持 deny default（fail-closed）。
   */
  netProxyPort?: number;
}

/**
 * 生成 Seatbelt profile（纯函数，跨平台可测）。
 * 规则形态：(version 1) + deny default 基线 + 逐条 allow；
 * Seatbelt 语义 = 最具体规则优先，故 deny subpath 无需关心与 allow 的先后。
 */
export function buildSeatbeltProfile(
  spec: import('../../core/sandbox').SandboxSpec,
  o: SeatbeltProfileOptions,
): string {
  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '',
    ';; ── 进程与系统调用基线（node 运行所需；experimental 收敛点见 M5 说明）──',
    '(allow process-exec*)',
    '(allow process-fork*)',
    '(allow sysctl-read)',
    '(allow ipc-posix*)',
    '(allow mach-lookup)',
    '(allow file-read-metadata)',
    '(allow file-ioctl)',
  ];

  // ── fs：系统只读 + 基础设施（node/worker/toolModules 所在路径）──
  for (const p of MAC_SYSTEM_READ) lines.push(`(allow file-read* (subpath "${p}"))`);
  for (const infra of [o.nodeBin, o.workerPath, ...(o.toolModules ?? [])]) {
    lines.push(`(allow file-read* (subpath "${nodePath.dirname(infra)}"))`);
  }

  // ── HOME 临时目录（读写放行：工具临时文件落点，宿主侧每次调用清理）──
  lines.push(`(allow file-read* (subpath "${o.homePath}"))`);
  lines.push(`(allow file-write* (subpath "${o.homePath}"))`);

  // ── spec.fs 映射：readable 只读 / writable 读写 / deny 显式拒绝（最具体优先）──
  for (const p of spec.fs.readable) {
    lines.push(`(allow file-read* (subpath "${p}"))`);
  }
  for (const p of spec.fs.writable) {
    lines.push(`(allow file-read* (subpath "${p}"))`);
    lines.push(`(allow file-write* (subpath "${p}"))`);
  }
  for (const p of spec.fs.deny ?? []) {
    lines.push(`(deny file-read* (subpath "${p}"))`);
    lines.push(`(deny file-write* (subpath "${p}"))`);
  }

  // ── 网络：deny 缺省（deny default 已涵盖）──
  if (spec.net.mode === 'allow') {
    lines.push('(allow network*)');
  } else if (spec.net.mode === 'proxy' && o.netProxyPort !== undefined) {
    // proxy（M6）：仅放行到宿主 forwarder（loopback IP 形态，worker 内无需 DNS
    // 出站——代理变量是 127.0.0.1:port；其余 remote 全拒 = proxy 强制边界）
    lines.push(`(allow network-outbound (remote ip "127.0.0.1:${o.netProxyPort}"))`);
  }
  // proxy + forwarder 不可用 → 保持 deny default（fail-closed）

  // ── spec.env 不经 profile（macOS env 由宿主 spawn 白名单构造）──
  return lines.join('\n') + '\n';
}

// ─── Provider ────────────────────────────────────────────────────────

export interface SeatbeltSandboxProviderOptions {
  /** sandbox-exec 显式覆盖（缺省 /usr/bin/sandbox-exec） */
  sandboxExecPath?: string;
  /** worker 入口脚本显式覆盖（缺省自动解析，同 Tier 1） */
  workerPath?: string;
  /** node 附加参数（如 --import tsx） */
  nodeArgs?: string[];
  /** 心跳僵死判定阈值 */
  heartbeatTimeoutMs?: number;
  /** worker 进程加载的工具模块路径 */
  toolModules?: string[];
}

export class SeatbeltSandboxProvider implements SandboxProvider {
  private readonly _execPath: string;
  private readonly _workerPath: string | undefined;
  private readonly _nodeArgs: string[];
  private readonly _heartbeatTimeoutMs: number;
  private readonly _toolModules: string[];

  constructor(options: SeatbeltSandboxProviderOptions = {}) {
    this._execPath = options.sandboxExecPath ?? SANDBOX_EXEC;
    this._workerPath = options.workerPath ?? resolveWorkerPath();
    this._nodeArgs = options.nodeArgs ?? [];
    this._heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_DEFAULT_MS;
    this._toolModules = options.toolModules ?? [];
  }

  async supports(strategy: SandboxStrategy): Promise<boolean> {
    if (strategy !== 'os') return false;
    if (!IS_MAC || this._workerPath === undefined) return false;
    if (this._execPath !== SANDBOX_EXEC) return true; // 显式覆盖直接信任
    return existsSync(SANDBOX_EXEC);
  }

  async run(req: SandboxRunRequest): Promise<ToolResult> {
    if (!IS_MAC || this._workerPath === undefined || !(await this.supports('os'))) {
      throw new Error(
        'SeatbeltSandboxProvider: sandbox-exec unavailable on this platform ' +
        '(route via createDefaultSandboxProvider for degradation)',
      );
    }
    if (req.spec.strategy !== 'os') {
      throw new Error(`SeatbeltSandboxProvider: unsupported strategy "${req.spec.strategy}"`);
    }

    // HOME 临时目录（宿主侧，用后清理；macOS 无 tmpfs 原语）
    const homePath = await nodeFs.promises.mkdtemp(
      nodePath.join(os.tmpdir(), 'aipack-seatbelt-'),
    );
    // net.mode 'proxy'（M6）：宿主侧 forwarder（profile 放行 loopback 出站 + env 注入）
    const proxy = await startNetProxyForSpec(req.spec, makeSandboxEmit(req));
    // profile 文件（sandbox-exec -f 读取后即可删，随会话目录一并清理）
    const profilePath = nodePath.join(homePath, 'profile.sb');
    const profile = buildSeatbeltProfile(req.spec, {
      homePath,
      nodeBin: process.execPath,
      workerPath: this._workerPath,
      toolModules: this._toolModules,
      netProxyPort: proxy?.forwarder.port,
    });
    await nodeFs.promises.writeFile(profilePath, profile, 'utf8');

    // sandbox-exec -f profile -- node worker.js
    // env 白名单由宿主 spawn 侧构造；proxy 变量在白名单之上合并
    // （覆盖 spec.env 同名键——proxy 模式下出口归框架）
    const env = buildWorkerEnv(req.spec.env, homePath);
    if (proxy !== undefined) Object.assign(env, proxy.env);
    try {
      return await runProtocolSession(
        {
          argv: [
            this._execPath, '-f', profilePath, '--',
            process.execPath, ...this._nodeArgs, this._workerPath,
          ],
          detached: true,
          cleanupDirs: [homePath],
          heartbeatTimeoutMs: this._heartbeatTimeoutMs,
          toolModules: this._toolModules,
          env,
        },
        req,
      );
    } finally {
      await proxy?.forwarder.close().catch(() => {});
    }
  }
}
