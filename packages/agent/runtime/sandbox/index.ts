/**
 * runtime/sandbox - 工具执行隔离层实现（Tier 1/2 provider + 工厂）
 *
 * 契约见 core/sandbox.ts；计划见仓库根 SANDBOX_PLAN.md。
 * - protocol.ts    NDJSON 协议常量与消息类型（宿主/worker 共享）
 * - worker.ts      worker 进程入口（独立构建入口 dist/sandbox/worker.js）
 * - subprocess.ts  Tier 1 provider（spawn / env 清洗 / 进程组 kill / 输出封顶）
 * - bwrap.ts       Tier 2 Linux provider（mount namespace + cgroup 配额）
 * - seatbelt.ts    Tier 2 macOS provider（sandbox-exec profile 生成）
 * - audit-win.ts   Windows 进程树资源审计（M5，顶替 Job Object 硬配额）
 * - default.ts     createDefaultSandboxProvider（平台分派 + 降级链）
 */

export {
  SubprocessSandboxProvider,
  buildWorkerEnv,
  resolveWorkerPath,
  runProtocolSession,
} from './subprocess';
export type {
  SubprocessSandboxProviderOptions,
  ProtocolSessionSpec,
  ResourceAudit,
} from './subprocess';
export {
  BwrapSandboxProvider,
  buildBwrapArgv,
  probeLinuxSandboxCaps,
} from './bwrap';
export type { BwrapSandboxProviderOptions, BwrapArgvOptions, LinuxSandboxCaps } from './bwrap';
export {
  SeatbeltSandboxProvider,
  buildSeatbeltProfile,
} from './seatbelt';
export type {
  SeatbeltSandboxProviderOptions,
  SeatbeltProfileOptions,
} from './seatbelt';
export {
  createWindowsProcessAudit,
  parseCsvLine,
  aggregateTree,
  checkResourceLimits,
  PROCESS_LIMIT_REASON,
  MEMORY_LIMIT_REASON,
} from './audit-win';
export { createDefaultSandboxProvider } from './default';
export type { DefaultSandboxProviderOptions } from './default';
export { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_DEFAULT_MS } from './protocol';
export type { HostMessage, WorkerMessage } from './protocol';
