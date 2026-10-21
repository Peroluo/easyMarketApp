/**
 * packages - Agent 框架入口
 *
 * 独立框架，不依赖 src/。
 * 所有功能通过 Transformer、Extension 等机制扩展。
 *
 * 公共导出面采用显式清单（不再 `export * from './core'`）：
 * 仅暴露稳定契约与公共 API；tapable 钩子实现类 / TaskGraphImpl /
 * TaskGraphBuilder / ContextResourceBuilder 等内部机制不再进入公共 API，
 * 内部重构不再构成 breaking change。深路径导入（如 'aipack/core'）不受影响。
 */

// ─── 核心契约：消息/内容/模型/工具类型与工具函数 ─────────────────
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
} from './core';
export {
  extractText,
  extractToolCalls,
  createTextContent,
  createEmptyUsage,
} from './core';

// ─── Runtime: 编排层 ──────────────────────────────────────────────
export { AgentRuntime, createRuntime } from './runtime';
export type { Runtime, Compilation, RuntimeOptions, CompactionOptions } from './core';

// ─── Tapable: 钩子失败策略（实现类为内部机制，不导出） ────────────
export { setTapFailurePolicy, getTapFailurePolicy, setTapErrorHandler } from './core/tapable';
export type { TapFailurePolicy, TapErrorInfo, TapErrorHandler } from './core/tapable';

// ─── Request: 请求入口 ────────────────────────────────────────────
export { RequestBuilder, createRequest } from './core';
export type { Request, RequestType } from './core';

// ─── ContextResource: 上下文资源 ──────────────────────────────────
export {
  createMessageResource,
  createToolCallResource,
  createToolResultResource,
} from './core';
export type { ContextResource, ResourceType, ResourceRole } from './core';
export {
  messageToResource,
  messagesToResources,
  resourceToMessage,
  resourcesToMessages,
  extractToolCallsFromResource,
  extractTextFromResource,
} from './context-resource';

// ─── TaskGraph: 任务依赖图（Builder/Impl 为内部实现） ──────────────
export { createTaskGraph } from './core';
export type { TaskGraph, GraphNode } from './core';
export {
  buildTaskGraph,
  graphToMessages,
  analyzeToolChains,
  findOrphanedToolCalls,
  getGraphStats,
} from './task-graph';

// ─── ContextTransformer: 上下文转换器 ─────────────────────────────
export type { ContextTransformer, TransformContext, TransformRuntime, TransformerOptions } from './core';
export { BaseTransformer } from './core';
export {
  ToolPairingTransformer,
  StateSnapshotTransformer,
  TruncationTransformer,
  TokenBudgetTransformer,
  SystemMessageCleanerTransformer,
  ensureToolPairing,
  createDefaultTransformers,
} from './transformer';

// ─── Extension: 扩展插件 ─────────────────────────────────────────
export { BaseExtension, ExtensionManager } from './core';
export type { Extension, ExtensionContext, RuntimeHooks } from './core';
export {
  LoggingExtension,
  EventCaptureExtension,
  RequestInterceptorExtension,
  ResultPostProcessorExtension,
  SharedStateExtension,
  createDefaultExtensions,
  createExtensionManager,
  createToolHookExtension,
} from './extension';

// ─── Tool Hooks: 工具调用钩子 ─────────────────────────────────────
export { isErrorToolResult } from './core';
export type {
  ToolCallContext,
  AfterToolCallContext,
  BeforeToolCallResult,
  AfterToolCallResult,
  BeforeToolCallDecision,
  AfterToolCallDecision,
} from './core';

// ─── Result: 运行结果 ────────────────────────────────────────────
export { ResultBuilder, createResult, createErrorResult } from './core';
export type { Result, ResultChunk } from './core';
export {
  buildResultFromMessages,
  buildResultFromAssistantMessage,
  buildResultWithResources,
  ResultAggregator,
} from './result';

// ─── SessionManager: 多会话共享 Runtime 门面 ───────────────────────
export { SessionManager, createSessionManager } from './session-manager';
export type { SessionManagerOptions } from './session-manager';

// ─── Session: 会话存储实现 ────────────────────────────────────────
export {
  MemorySessionStorage,
  createMemorySessionStorage,
  FileSessionStorage,
  createFileSessionStorage,
} from './session';
export { SESSION_VERSION } from './core';
export type {
  SessionModel,
  StoredSession,
  SessionStorage,
  StorageLock,
  FileSessionStorageOptions,
  MemorySessionStorageOptions,
} from './core';

// ─── PermissionPolicy / Approval: 框架级工具权限层 ────────────────
export {
  createPermissionPolicy,
  createAllowListPolicy,
  createDenyAllPolicy,
  createAllowAllPolicy,
  hasPermission,
  createApprovalManager,
  toStoredApproval,
  fromStoredApproval,
} from './core';
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
} from './core';
export {
  FileApprovalStore,
  defaultApprovalDir,
  MemoryApprovalStore,
} from './approval';

// ─── AI 模型层(从 ./ai 选择性重导出,便于单包消费)─────────────────
// 完整 AI surface 见 'aipack/ai' 子路径;此处仅重导出消费者常用、且不与
// core 同名冲突的符号,外加 Model as AiModel 别名。
export {
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
  getEnvApiKey,
  hasProviderConfigured,
  BUILTIN_PROVIDERS,
} from './ai';
export type { Model as AiModel } from './ai';

// ─── AI 适配器(模型层 ↔ 框架核心 胶水)────────────────────────────
export { adaptAiModel, createStreamFnFromAi } from './adapters/ai';

// ─── Telemetry: 轻量可观测性 ─────────────────────────────────────
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
