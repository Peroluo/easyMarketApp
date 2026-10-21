/**
 * packages/core - 核心类型与接口
 *
 * 定义整个 Agent 架构的"契约层"，
 * 所有实现包（runtime, transformer, extension 等）都依赖此包。
 */

// ─── 核心类型: 消息/内容/模型/工具 ─────────────────────────────────
export type {
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
  ContentBlock,
  BaseMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  SystemMessage,
  Message,
  Usage,
  Model,
  ToolResult,
  Tool,
  Context,
  StreamOptions,
  StreamEvent,
  StreamResult,
  StreamFn,
  AgentState,
  ThinkingLevel,
} from './types';
export {
  extractText,
  extractToolCalls,
  createTextContent,
  createEmptyUsage,
} from './types';

// ─── token 估算单一实现（约 4 字符/token，各层共用） ─────────────
export { estimateTextTokens, estimateMessageTokens } from './tokens';

// ─── 错误分类契约（实现见 ai/errors）─────────────────────────────
export { AgentErrorCategory } from './errors';

// ─── Telemetry: 轻量可观测性契约（实现侧经 RuntimeOptions 注入）────
export { noopTelemetry } from './telemetry';
export type {
  Telemetry,
  ErrorClass,
  RunStartTelemetryInfo,
  RunTelemetryInfo,
  ToolTelemetryInfo,
  ModelTelemetryInfo,
  RetryTelemetryInfo,
  PermissionDeniedTelemetryInfo,
  ApprovalPendingTelemetryInfo,
  ApprovalResolvedTelemetryInfo,
  CompactionTelemetryInfo,
  HookErrorTelemetryInfo,
} from './telemetry';

// ─── Tapable: 事件钩子系统 ─────────────────────────────────────────
export {
  SyncHook,
  AsyncSeriesHook,
  AsyncSeriesWaterfallHook,
  HookMap,
} from './tapable';
export type { Tap, TapType } from './tapable';

// ─── Runtime: 运行时接口 ──────────────────────────────────────────
export type { Runtime, Compilation, RuntimeOptions, CompactionOptions } from './runtime';

// ─── Request: 请求入口 ────────────────────────────────────────────
export { RequestBuilder, createRequest } from './request';
export type { Request, RequestType } from './request';

// ─── ContextResource: 上下文资源 ──────────────────────────────────
export {
  ContextResourceBuilder,
  createMessageResource,
  createToolCallResource,
  createToolResultResource,
} from './context-resource';
export type { ContextResource, ResourceType, ResourceRole } from './context-resource';

// ─── TaskGraph: 任务依赖图 ────────────────────────────────────────
export {
  TaskGraphImpl,
  TaskGraphBuilder,
  createTaskGraph,
} from './task-graph';
export type { TaskGraph, GraphNode } from './task-graph';

// ─── ContextTransformer: 上下文转换器 ─────────────────────────────
export { BaseTransformer } from './transformer';
export type { ContextTransformer, TransformContext, TransformRuntime, TransformerOptions } from './transformer';

// ─── Extension: 扩展插件 ──────────────────────────────────────────
export { ExtensionManager, BaseExtension } from './extension';
export type { Extension, ExtensionContext, RuntimeHooks } from './extension';

// ─── Tool Hooks: 工具调用钩子 ─────────────────────────────────────
export { isErrorToolResult } from './tool-hooks';
export type {
  ToolCallContext,
  AfterToolCallContext,
  BeforeToolCallResult,
  AfterToolCallResult,
  BeforeToolCallDecision,
  AfterToolCallDecision,
} from './tool-hooks';

// ─── Result: 运行结果 ─────────────────────────────────────────────
export { ResultBuilder, createResult, createErrorResult } from './result';
export type { Result, ResultChunk } from './result';

// ─── PermissionPolicy: 框架级工具权限层 ───────────────────────────
export {
  createPermissionPolicy,
  createAllowListPolicy,
  createDenyAllPolicy,
  createAllowAllPolicy,
  hasPermission,
  createApprovalManager,
  toStoredApproval,
  fromStoredApproval,
} from './permission';
export type {
  PermissionDecision,
  PermissionRequest,
  PermissionPolicy,
  PermissionRule,
  CreatePermissionPolicyOptions,
  PendingApproval,
  ApprovalOutcome,
  ApprovalOutcomeStatus,
  ApprovalCreateOptions,
  ApprovalManager,
  CreateApprovalManagerOptions,
  StoredApproval,
  ApprovalAuditRecord,
  ApprovalStore,
} from './permission';

// ─── Session: 会话持久化契约 ──────────────────────────────────────
export { SESSION_VERSION } from './session';
export type {
  SessionModel,
  StoredSession,
  SessionStorage,
  StorageLock,
  FileSessionStorageOptions,
  MemorySessionStorageOptions,
} from './session';
