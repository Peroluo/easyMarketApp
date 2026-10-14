/**
 * 遥测 - 压缩动作埋点
 *
 * ContextCompressionTransformer 把每轮遥测写入 `context.shared['compression_telemetry']`，
 * CompressionTelemetryExtension 通过 afterTransform hook 读取并上报。
 *
 * v2 变化：
 *   - level（L1~L5）→ stage（precompress/trim/summarize/truncate/lifecycle）
 *   - cachePreserved → prefixIntact（KV cache 保持的前缀资源数，诚实度量）
 *   - 新增 forkTruncated（fork 输出被 max_tokens 截断）
 */

import type { Extension, ExtensionContext, RuntimeHooks, ContextResource } from '@aipack-ai/agent';

// ─── 共享状态键 ───────────────────────────────────────────────────

export const TELEMETRY_SHARED_KEY = 'compression_telemetry';

// ─── 遥测数据结构 ─────────────────────────────────────────────────

export type CompressionStage =
  | 'precompress'
  | 'trim'
  | 'summarize'
  | 'truncate'
  | 'lifecycle'
  | 'dry_run';

export interface CompressionTelemetry {
  timestamp: number;
  sessionKey: string;
  turn: number;
  stage: CompressionStage;
  action: string;
  beforeTokens: number;
  afterTokens: number;
  resourcesAffected: number;
  triggerReason: string;
  /** KV cache 保持的前缀资源数（首个被修改/删除资源之前的资源数） */
  prefixIntact: number;
  duration: number;
  /** 是否发生了回滚（如配对验证失败） */
  rolledBack?: boolean;
  /** 是否发生错误（如 fork 失败、持久化失败） */
  failed?: boolean;
  /** 错误/警告信息 */
  message?: string;

  /** 单次 fork 调用耗时（ms） */
  forkDurationMs?: number;
  /** 单次 fork 调用重试次数 */
  forkRetries?: number;
  /** fork 实际使用的模型 id */
  forkModelId?: string;
  /** fork 调用的 token 用量 */
  forkUsage?: {
    input?: number;
    output?: number;
    total?: number;
  };
  /** fork 输出被 max_tokens 截断（stopReason === 'length'） */
  forkTruncated?: boolean;
  /** 触发压缩时 token 占比最高的资源（前 N） */
  topContributors?: { id: string; type: string; tokens: number }[];
  /** 压缩前资源条数 */
  messageCountBefore?: number;
  /** 压缩后资源条数 */
  messageCountAfter?: number;
}

/** 创建遥测条目的辅助函数 */
export function createTelemetry(
  stage: CompressionStage,
  action: string,
  beforeTokens: number,
  afterTokens: number,
  options?: Partial<CompressionTelemetry>,
): CompressionTelemetry {
  return {
    timestamp: Date.now(),
    sessionKey: '',
    turn: 0,
    stage,
    action,
    beforeTokens,
    afterTokens,
    resourcesAffected: options?.resourcesAffected ?? 0,
    triggerReason: options?.triggerReason ?? 'threshold_exceeded',
    prefixIntact: options?.prefixIntact ?? 0,
    duration: options?.duration ?? 0,
    rolledBack: options?.rolledBack,
    failed: options?.failed,
    message: options?.message,
    forkDurationMs: options?.forkDurationMs,
    forkRetries: options?.forkRetries,
    forkModelId: options?.forkModelId,
    forkUsage: options?.forkUsage,
    forkTruncated: options?.forkTruncated,
    topContributors: options?.topContributors,
    messageCountBefore: options?.messageCountBefore,
    messageCountAfter: options?.messageCountAfter,
  };
}

// ─── 遥测上报 Extension ───────────────────────────────────────────

export interface TelemetryReporter {
  report(t: CompressionTelemetry): void;
}

export interface ConsoleReporterOptions {
  logTokenDelta: boolean;
  logTriggerReason: boolean;
}

/** 默认控制台上报器 */
export class ConsoleTelemetryReporter implements TelemetryReporter {
  constructor(private opts: ConsoleReporterOptions = { logTokenDelta: true, logTriggerReason: true }) {}

  report(t: CompressionTelemetry): void {
    const payload: Record<string, unknown> = {
      event: 'aipack_compact',
      stage: t.stage,
      action: t.action,
      beforeTokens: t.beforeTokens,
      afterTokens: t.afterTokens,
      reductionRatio: t.beforeTokens > 0
        ? Number(((t.beforeTokens - t.afterTokens) / t.beforeTokens).toFixed(4))
        : 0,
      prefixIntact: t.prefixIntact,
      duration: t.duration,
    };
    if (this.opts.logTokenDelta) {
      payload.tokenDelta = t.beforeTokens - t.afterTokens;
    }
    if (this.opts.logTriggerReason) {
      payload.triggerReason = t.triggerReason;
    }
    if (t.rolledBack) payload.rolledBack = true;
    if (t.failed) payload.failed = true;
    if (t.message) payload.message = t.message;
    if (t.forkDurationMs !== undefined) payload.forkDurationMs = t.forkDurationMs;
    if (t.forkRetries !== undefined) payload.forkRetries = t.forkRetries;
    if (t.forkModelId !== undefined) payload.forkModelId = t.forkModelId;
    if (t.forkUsage !== undefined) payload.forkUsage = t.forkUsage;
    if (t.forkTruncated) payload.forkTruncated = true;
    if (t.topContributors !== undefined) payload.topContributors = t.topContributors;
    if (t.messageCountBefore !== undefined) payload.messageCountBefore = t.messageCountBefore;
    if (t.messageCountAfter !== undefined) payload.messageCountAfter = t.messageCountAfter;
    console.log(JSON.stringify(payload));
  }
}

/** 遥测 Extension - 通过 afterTransform hook 自动上报 */
export class CompressionTelemetryExtension implements Extension {
  readonly name = 'compression-telemetry';

  private reporter: TelemetryReporter;

  constructor(reporter?: TelemetryReporter) {
    this.reporter = reporter ?? new ConsoleTelemetryReporter();
  }

  apply(hooks: RuntimeHooks, context: ExtensionContext): void {
    // 在 apply 闭包中捕获 context，以便 tap 回调访问 shared 状态
    const reporter = this.reporter;
    const shared = context.shared;

    hooks.afterTransform.tapPromise('compression-telemetry', async (resources: ContextResource[]) => {
      const telemetry = shared.get(TELEMETRY_SHARED_KEY) as CompressionTelemetry[] | undefined;
      if (!telemetry || telemetry.length === 0) return resources;

      for (const t of telemetry) {
        try {
          reporter.report(t);
        } catch {
          // 上报失败不影响 pipeline
        }
      }
      // 清空本轮遥测，避免下一轮重复上报
      shared.delete(TELEMETRY_SHARED_KEY);
      return resources;
    });
  }
}
