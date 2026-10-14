/**
 * aipack-compression -- aipack 上下文压缩（v2 策略管道架构）
 *
 * 设计要点：
 *   - 统一预算：所有决策基于 effectiveBudget（contextWindow - 输出预留 - 安全边距）
 *   - 双水位：precompress(0.70) → trigger(0.80) → target(0.40)，一次压到位摊薄多轮
 *   - 策略管道：trim（无损裁剪）→ summarize（有损摘要，map-reduce）→ truncate（保底）
 *   - 预压缩：低预警线后台 fork 摘要，高水位直接应用，请求路径零 fork
 *   - 生命周期：压不下去时发 ContextExhaustedEvent，检查点/换会话由 host 决策
 *
 * 快速接入：
 *   import { createCompressionTransformer, loadCompressionConfig } from '@aipack-ai/compression';
 *   const transformer = createCompressionTransformer({
 *     config: loadCompressionConfig(),
 *     model, streamFn, contextWindow: model.contextWindow,
 *     // 可选：注入 ExtensionContext.shared 让 CompressionTelemetryExtension 自动上报
 *     sharedMap: extensionContext.shared,
 *   });
 *   // 加入 createRuntime 的 transformers 数组（按数组顺序链式执行）
 *   transformers: [transformer],
 *
 *   // 可选：上下文耗尽时（pinned/保护区本身超限）接管检查点/换会话
 *   transformer.onContextExhausted(({ handoffDocument, suggestedSessionId }) => {
 *     runtime.switchSession(suggestedSessionId);
 *   });
 */

// ─── 复合转换器 ───────────────────────────────────────────────────
export {
  ContextCompressionTransformer,
  createCompressionTransformer,
} from './src/compression-transformer';
export type { CompressionTransformerOptions } from './src/compression-transformer';

// ─── 配置 ─────────────────────────────────────────────────────────
export {
  loadCompressionConfig,
  validateConfig,
} from './src/config';
export type { CompressionConfig, DeepPartial, ConfigValidationError } from './src/config';

// ─── 预算 ─────────────────────────────────────────────────────────
export { ContextBudget } from './src/budget';
export type { BudgetConfig } from './src/budget';

// ─── Token 计量 ───────────────────────────────────────────────────
export {
  TokenMeter,
  createTokenEstimator,
} from './src/token-estimator';
export type { TokenEstimator, TokenizerLike } from './src/token-estimator';

// ─── Fork 执行器 ──────────────────────────────────────────────────
export { ForkRunner } from './src/fork';
export type { ForkRunnerOptions, ForkTextCall, ForkTextResult } from './src/fork';

// ─── 策略管道 ─────────────────────────────────────────────────────
export type {
  CompressionStrategy,
  StrategyContext,
  StrategyResult,
  PrecomputedSummary,
} from './src/strategy';
export { resourceText, formatResourceForTranscript } from './src/strategy';
export { TrimStrategy } from './src/strategies/trim';
export { SummarizeStrategy } from './src/strategies/summarize';
export { TruncateStrategy } from './src/strategies/truncate';

// ─── 会话生命周期 ─────────────────────────────────────────────────
export type {
  ContextExhaustedEvent,
  ContextExhaustedHandler,
  ExhaustedReason,
} from './src/lifecycle';
export { generateHandoffDocument } from './src/lifecycle';

// ─── 安全机制 ─────────────────────────────────────────────────────
export {
  CompressionSafetyGuard,
  createSafetyState,
  abortSafetyState,
  createForkAbortController,
  runFork,
  hasInFlightForks,
  buildToolPairMap,
  isToolPairComplete,
} from './src/safety';
export type {
  CompressionSafetyState,
  SafetyConfig,
  CreateSafetyStateOptions,
} from './src/safety';

// ─── Fork 重试 ────────────────────────────────────────────────────
export {
  ForkStreamError,
  isRetryableStreamError,
  computeBackoffDelay,
  retryWithBackoff,
  runForkWithRetry,
  DEFAULT_FORK_RETRY,
} from './src/retry';
export type {
  RetryConfig,
  ForkResult,
  ForkCallbackResult,
} from './src/retry';

// ─── 遥测 ─────────────────────────────────────────────────────────
export {
  createTelemetry,
  ConsoleTelemetryReporter,
  CompressionTelemetryExtension,
  TELEMETRY_SHARED_KEY,
} from './src/telemetry';
export type {
  CompressionTelemetry,
  CompressionStage,
  TelemetryReporter,
  ConsoleReporterOptions,
} from './src/telemetry';

// ─── 从 aipack 再导出常用类型 ──────────────────────────────────
export type {
  ContextResource,
  ContextTransformer,
  TransformContext,
  Extension,
  Model,
  StreamFn,
} from '@aipack-ai/agent';
export { BaseTransformer } from '@aipack-ai/agent';
