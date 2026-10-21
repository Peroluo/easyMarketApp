/**
 * core/telemetry - 轻量可观测性契约
 *
 * 定义在 core（契约层）供 runtime / telemetry 等各层单向依赖，
 * 消除此前的 core ↔ telemetry 类型级循环依赖。
 *
 * 可选注入到 Runtime（RuntimeOptions.telemetry），用于观测：
 * - onRunStart：一次 run()/stream() 入队（配合 onRunEnd 求排队时长）
 * - onRunEnd：一次 run()/stream() 完成（含耗时、step 数、Token、成本与最终 Result）
 * - onToolCall：单次工具执行（含耗时、成功标志与 ToolResult）
 * - onModelCall：单次模型调用（含 token 用量、重试次数、成本与耗时）
 * - onRetry：provider 内部单次重试（per-attempt 粒度，含退避时长）
 * - onPermissionDenied：工具调用被权限策略拒绝
 * - onApprovalPending / onApprovalResolved：异步审批挂起与结算（Human-in-the-loop）
 * - onHookError：扩展钩子（tap）抛错（默认策略下不影响主流程，仅观测）
 *
 * 设计原则：
 * - 全可选（未实现的方法静默跳过）
 * - 上报失败不影响主流程（内部吞错）
 * - 与 Extension 钩子正交：Telemetry 面向"观测"，Extension 面向"干预/注入"
 * - 一次 run = 一条 Trace：run/stream 入口生成 traceId，贯穿 runEnd/tool/model/retry 事件
 */

import type { Request } from './request';
import type { Result } from './result';
import type { ToolResult } from './types';
import type { AgentErrorCategory } from './errors';

/**
 * 统一错误分类：复用 AI 层 AgentErrorCategory，另加非模型错误类别。
 * 模型/流层错误消息带 "[category]" 前缀（formatCategoryError 产出），可直接解析。
 */
export type ErrorClass =
  | AgentErrorCategory
  | 'tool_error'
  | 'terminated'
  | 'validation';

/** 一次 run() 完成事件载荷（run() 与 stream() 均触发） */
export interface RunTelemetryInfo {
  /** 本次运行的全局唯一 id（run/stream 入口生成，贯穿所有事件） */
  traceId: string;
  sessionKey: string;
  request: Request;
  /** 端到端耗时（排队 + 执行） */
  durationMs: number;
  /** 纯执行耗时（排队外） */
  activeMs: number;
  /** 入队等待时长（会话串行队列） */
  queuedMs: number;
  /** 对话轮数 = step 长度 */
  turnCount: number;
  result: Result;
  /** 是否成功（Result.success） */
  success: boolean;
  errorClass?: ErrorClass;
  tokens: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** 流式请求首 token 延迟（非流式缺省） */
  ttftMs?: number;
}

/** 单次工具执行事件载荷 */
export interface ToolTelemetryInfo {
  traceId: string;
  /** 本次工具调用的 span id */
  spanId: string;
  sessionKey: string;
  toolName: string;
  args: unknown;
  durationMs: number;
  result: ToolResult;
  success: boolean;
  /** ok / error / blocked(权限拒) / skipped(前序终止)。成功率只认 ok */
  status: 'ok' | 'error' | 'blocked' | 'skipped';
  errorClass?: ErrorClass;
}

/** 单次模型调用事件载荷（含流式正常结束与错误路径的累计用量） */
export interface ModelTelemetryInfo {
  traceId: string;
  /** 本次模型调用的 span id */
  spanId: string;
  sessionKey: string;
  modelId: string;
  /** 含首次调用：1 = 无重试 */
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  durationMs: number;
  stream: boolean;
  errorClass?: ErrorClass;
}

/** 工具调用被权限策略拒绝事件载荷 */
export interface PermissionDeniedTelemetryInfo {
  traceId?: string;
  sessionKey: string;
  toolName: string;
  permissions: readonly string[];
  args: unknown;
  reason: string;
}

/** 审批单挂起事件载荷（pending 决策触发，可据此做"等待审批"告警） */
export interface ApprovalPendingTelemetryInfo {
  traceId?: string;
  sessionKey: string;
  /** 审批单 id（外部以 id 批准 / 驳回） */
  approvalId: string;
  toolName: string;
  permissions: readonly string[];
  args: unknown;
  /** 审批超时时刻（epoch ms；未配置超时为 undefined） */
  expiresAt?: number;
}

/** 审批单结算事件载荷（批准 / 驳回 / 超时 / 取消） */
export interface ApprovalResolvedTelemetryInfo {
  traceId?: string;
  sessionKey: string;
  approvalId: string;
  toolName: string;
  outcome: 'approved' | 'denied' | 'timeout' | 'cancelled';
  /** 挂起时长 ms */
  waitedMs: number;
}

/** run()/stream() 开始事件载荷（入队前触发） */
export interface RunStartTelemetryInfo {
  traceId: string;
  sessionKey: string;
  request: Request;
  /** 进入会话队列的时刻（epoch ms） */
  queuedAt: number;
}

/** 单次重试事件载荷（provider 内部 retry() 真正退避重试时上报） */
export interface RetryTelemetryInfo {
  traceId: string;
  /** 关联的模型调用 span（P2：重试明细落到具体 model span） */
  spanId?: string;
  provider: string;
  modelId: string;
  /** 第几次重试（从 1 开始） */
  attempt: number;
  errorClass: ErrorClass;
  /** HTTP 状态码（如有，如 429/502） */
  status?: number;
  /** 本次退避延迟（ms） */
  delayMs: number;
  /** 恒为 true：onRetry 仅在真正重试时触发；重试耗尽由 onModelCall.attempts + errorClass 兜底 */
  willRetry: boolean;
}

/** 内置摘要压缩事件载荷 */
export interface CompactionTelemetryInfo {
  traceId: string;
  sessionKey: string;
  /** summary = 摘要成功；truncate = 摘要失败/超预算降级硬截断 */
  mode: 'summary' | 'truncate';
  /** 触发来源：threshold = 阈值触发；overflow = 溢出恢复 */
  trigger: 'threshold' | 'overflow';
  /** 压缩前估算 token */
  tokensBefore: number;
  /** 压缩后估算 token（摘要消息 + 保留消息） */
  tokensAfter: number;
  /** 被压缩（丢弃或并入摘要）的消息条数 */
  droppedMessages: number;
  /** 摘要文本（mode = summary 时） */
  summary?: string;
}

/** 扩展钩子（tap）抛错事件载荷：默认策略下 tap 失败不影响主流程，但上报可观测 */
export interface HookErrorTelemetryInfo {
  /** 关联运行 id（钩子在 run 之外触发时缺省） */
  traceId?: string;
  sessionKey: string;
  /** 钩子名（RuntimeHooks 中的钩子名或自定义名） */
  hook: string;
  /** tap 名（注册钩子时传入的 name） */
  tap: string;
  /** tap 抛出的原始错误 */
  error: unknown;
}

export interface Telemetry {
  /** 一次 run()/stream() 入队开始 */
  onRunStart?(info: RunStartTelemetryInfo): void | Promise<void>;
  /** 一次 run()/stream() 完成（成功或失败均触发） */
  onRunEnd?(info: RunTelemetryInfo): void | Promise<void>;
  /** 单次工具执行完成（含被 catch 的错误结果） */
  onToolCall?(info: ToolTelemetryInfo): void | Promise<void>;
  /** 单次模型调用完成（含流式正常结束与错误路径的累计用量） */
  onModelCall?(info: ModelTelemetryInfo): void | Promise<void>;
  /** 单次重试（provider 内退避重试时触发） */
  onRetry?(info: RetryTelemetryInfo): void | Promise<void>;
  /** 内置摘要压缩完成（摘要成功或降级硬截断均触发） */
  onCompaction?(info: CompactionTelemetryInfo): void | Promise<void>;
  /** 工具调用被 PermissionPolicy 拒绝（confirm 拒绝 / deny 决策 / pending 未批准均触发） */
  onPermissionDenied?(info: PermissionDeniedTelemetryInfo): void | Promise<void>;
  /** 审批单挂起（pending 决策 → 等待外部批准） */
  onApprovalPending?(info: ApprovalPendingTelemetryInfo): void | Promise<void>;
  /** 审批单结算（批准 / 驳回 / 超时 / 取消） */
  onApprovalResolved?(info: ApprovalResolvedTelemetryInfo): void | Promise<void>;
  /** 扩展钩子（tap）抛错（默认策略下 tap 失败不影响主流程） */
  onHookError?(info: HookErrorTelemetryInfo): void | Promise<void>;
}

/** 空实现（默认），便于组合 */
export function noopTelemetry(): Telemetry {
  return {};
}
