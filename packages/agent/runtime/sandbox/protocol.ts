/**
 * runtime/sandbox/protocol - Tier 1 subprocess 沙箱 NDJSON 协议
 *
 * 宿主（subprocess.ts）与 worker（worker.ts）共享的消息类型与常量。
 * 通信走 worker 的 stdin/stdout，每行一条 JSON（NDJSON）；stderr 仅诊断。
 *
 * 生命周期：
 *   宿主 spawn worker → 发 init（toolModules + spec）
 *   → worker 重建工具注册表 + 安装 fs facade + 挂载 secrets API → 回 ready
 *   → 宿主发 exec → worker 执行工具 → 回 result（或 error）→ 自行退出
 *   exec 期间可穿插 broker 交互（M6）：worker 发 request-secret → 宿主回 secret
 *
 * 心跳是协议层消息（独立 op），不是 SandboxEventType 遥测事件：
 *   worker 生命周期内周期性发 op:heartbeat，宿主超时无消息判定僵死强杀。
 */

import type { SandboxSpec, SandboxEvent } from '../../core/sandbox';
import type { ToolResult } from '../../core/types';

/** worker 心跳间隔（毫秒） */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** 宿主心跳僵死判定默认阈值（毫秒）：3 个心跳周期无任何 stdout 消息 */
export const HEARTBEAT_TIMEOUT_DEFAULT_MS = HEARTBEAT_INTERVAL_MS * 3;

// ─── 宿主 → worker（stdin）─────────────────────────────────────────

/** 握手：worker 按此重建工具注册表并安装 fs facade */
export interface InitMessage {
  op: 'init';
  /** 工具模块路径列表（绝对路径或 file:// URL），worker 逐个 import 并收集 Tool */
  toolModules: string[];
  /** 本次调用的完备 SandboxSpec（mergeSpec 产物） */
  spec: SandboxSpec;
}

/** 单请求：worker 查注册表执行工具（每次调用一个 worker，无多请求） */
export interface ExecMessage {
  op: 'exec';
  toolName: string;
  toolCallId: string;
  args: unknown;
}

/**
 * 凭证请求（M6 secrets broker）：worker 内工具经 requestSecret 发起，
 * id 用于并发请求关联（宿主以同 id 的 SecretMessage 响应）。
 */
export interface RequestSecretMessage {
  op: 'request-secret';
  /** 请求关联 id（worker 侧生成，响应原样带回） */
  id: string;
  /** 请求的凭证名（宿主按 spec.secrets 白名单裁决） */
  name: string;
}

export type HostMessage = InitMessage | ExecMessage | SecretMessage;

// ─── worker → 宿主（stdout）────────────────────────────────────────

export type WorkerMessage =
  | { op: 'ready' }                                     // 注册表就绪，等待 exec
  | { op: 'heartbeat' }                                 // 协议层心跳（非遥测事件）
  | { op: 'event'; event: SandboxEvent }                // 流式遥测事件（violation/degraded）
  | RequestSecretMessage                                 // 凭证请求（等待宿主 SecretMessage 响应）
  | { op: 'result'; toolResult: ToolResult }            // 终止消息：正常结果
  | { op: 'error'; message: string; code?: string };     // 终止消息：异常终止

// ─── 宿主 → worker（stdin）的 broker 响应（exec 期间异步到达）─────────

/**
 * 凭证响应：裁决通过 → value（worker 注入自身 process.env 后 resolve）；
 * 未声明/宿主不可用 → error（worker reject）。二者互斥。
 */
export interface SecretMessage {
  op: 'secret';
  /** 响应关联 id（对应 RequestSecretMessage.id） */
  id: string;
  name: string;
  value?: string;
  error?: string;
}
