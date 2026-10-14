/**
 * 复合压缩转换器 - 策略管道编排器
 *
 * v2 架构（取代 v1 五级阈值瀑布）：
 *
 *   ┌─ ContextBudget ── 统一有效预算（扣除输出预留 + 安全边距）+ 双水位
 *   ├─ TokenMeter ───── 计量（契约安全缓存 + fork usage 自动校准）
 *   ├─ ForkRunner ───── fork 执行（stopReason 校验 + 输入预算 + 校准回填）
 *   ├─ 策略管道 ─────── trim（无损）→ summarize（有损，map-reduce）→ truncate（保底）
 *   ├─ Precompress ──── 低预警线后台摘要，高水位直接应用（请求路径零 fork）
 *   └─ Lifecycle ────── 压不下去时发 ContextExhaustedEvent，检查点/换会话归 host
 *
 * 关键修复（相对 v1）：
 *   - 串行化改为真互斥：promise 链原子交接，并发 run 不再同时读到同一旧 chain
 *   - 每策略独立 tool pairing 校验，失败仅回滚该策略
 *   - 没有任何"永久禁用"状态；冷却只做失败退避
 *   - dryRun / telemetry / LRU 会话管理保留
 */

import type {
  ContextResource, TransformContext, Model, StreamFn,
} from '@aipack-ai/agent';
import { BaseTransformer } from '@aipack-ai/agent';
import type { TokenEstimator } from './token-estimator';
import { TokenMeter } from './token-estimator';
import type { CompressionConfig } from './config';
import { validateConfig } from './config';
import type { CompressionTelemetry, TelemetryReporter } from './telemetry';
import { TELEMETRY_SHARED_KEY, createTelemetry } from './telemetry';
import {
  CompressionSafetyGuard,
  createSafetyState,
  abortSafetyState,
  hasInFlightForks,
  type CompressionSafetyState,
} from './safety';
import { ContextBudget } from './budget';
import { ForkRunner } from './fork';
import { DEFAULT_FORK_RETRY, type RetryConfig } from './retry';
import type { CompressionStrategy, StrategyContext, StrategyResult, PrecomputedSummary } from './strategy';
import { TrimStrategy } from './strategies/trim';
import { SummarizeStrategy } from './strategies/summarize';
import { TruncateStrategy } from './strategies/truncate';
import {
  generateHandoffDocument,
  type ContextExhaustedHandler,
  type ExhaustedReason,
} from './lifecycle';

/** safetyStates LRU 上限 */
const MAX_SESSIONS = 256;
/** telemetryHistory 上限 */
const MAX_TELEMETRY_HISTORY = 100;
/** 预压缩产物最大存活 turn 数（过期丢弃，重新后台生成） */
const PRECOMPRESS_MAX_TURNS = 8;

export interface CompressionTransformerOptions {
  config: CompressionConfig;
  model: Model;
  streamFn: StreamFn;
  /** 模型上下文窗口（token） */
  contextWindow: number;
  /**
   * 共享状态 Map（通常是 ExtensionContext.shared）。
   * 若提供，遥测会写入该 Map 的 `compression_telemetry` 键，
   * 供 CompressionTelemetryExtension 在 afterTransform hook 中读取上报。
   */
  sharedMap?: Map<string, unknown>;
  /** 直接上报器（若提供，优先于 sharedMap 使用） */
  telemetryReporter?: TelemetryReporter;
}

interface SessionEntry {
  safety: CompressionSafetyState;
  /** 最近一次访问时间戳（LRU 淘汰用） */
  lastAccess: number;
  /** 互斥链：本次 run 的完成 promise，后到者 await 它（原子交接，真互斥） */
  chain: Promise<void> | null;
  /** 后台预压缩产物（低预警线启动，高水位消费） */
  pending: PendingPrecompute | null;
}

interface PendingPrecompute {
  promise: Promise<PrecomputedSummary | null>;
  createdAtTurn: number;
}

export class ContextCompressionTransformer extends BaseTransformer {
  readonly name = 'context-compression';

  private meter: TokenEstimator;
  private compressionConfig: CompressionConfig;
  private contextWindow: number;
  private model: Model;

  private trim: TrimStrategy;
  private summarize: SummarizeStrategy;
  private truncate: TruncateStrategy;
  private summarizeFork: ForkRunner;
  private lifecycleFork: ForkRunner;
  private safetyGuard: CompressionSafetyGuard;

  private sessions = new Map<string, SessionEntry>();
  private sharedMap?: Map<string, unknown>;
  private telemetryReporter?: TelemetryReporter;
  private exhaustedHandlers: ContextExhaustedHandler[] = [];

  constructor(opts: CompressionTransformerOptions) {
    super();

    // 防御性校验 contextWindow
    if (!Number.isFinite(opts.contextWindow) || opts.contextWindow <= 0) {
      throw new Error(
        `[aipack-compression] Invalid contextWindow: ${opts.contextWindow}. ` +
        `Must be a positive finite number (got model.contextWindow=${opts.model.contextWindow}).`,
      );
    }

    const cfg = opts.config;
    this.compressionConfig = cfg;
    this.contextWindow = opts.contextWindow;
    this.model = opts.model;

    this.meter = new TokenMeter({
      charsPerTokenAscii: cfg.estimator.charsPerTokenAscii,
      charsPerTokenCJK: cfg.estimator.charsPerTokenCJK,
      imageTokensPerBlock: cfg.estimator.imageTokensPerBlock,
      cacheCapacity: cfg.estimator.cacheCapacity,
    });

    const retry: RetryConfig = {
      ...DEFAULT_FORK_RETRY,
      ...cfg.safety.retry,
      isRetryable: DEFAULT_FORK_RETRY.isRetryable,
    };
    const forkCommon = {
      streamFn: opts.streamFn,
      model: opts.model,
      meter: this.meter,
      forkTimeoutMs: cfg.safety.forkTimeoutMs,
      retry,
    };
    this.summarizeFork = new ForkRunner({
      ...forkCommon,
      forkModel: cfg.summarize.forkModel,
      forkMaxTokens: cfg.summarize.forkMaxTokens,
    });
    this.lifecycleFork = new ForkRunner({
      ...forkCommon,
      forkModel: cfg.lifecycle.forkModel,
      forkMaxTokens: cfg.lifecycle.forkMaxTokens,
    });

    this.trim = new TrimStrategy();
    this.summarize = new SummarizeStrategy();
    this.truncate = new TruncateStrategy();

    this.safetyGuard = new CompressionSafetyGuard({
      maxAttempts: cfg.safety.maxAttempts,
      cooldownTurns: cfg.safety.cooldownTurns,
      forkTimeoutMs: cfg.safety.forkTimeoutMs,
    });

    this.sharedMap = opts.sharedMap;
    this.telemetryReporter = opts.telemetryReporter;

    // 启动时校验配置（仅 warn，不阻塞启动）
    const configErrors = validateConfig(cfg, false);
    if (configErrors.length > 0) {
      const msg = configErrors
        .map(e => `[${e.severity}] ${e.path}: ${e.message}`)
        .join('; ');
      console.warn(`[aipack-compression] config validation issues: ${msg}`);
    }
  }

  /** 注册上下文耗尽处理器（检查点/换会话由 host 决策） */
  onContextExhausted(handler: ContextExhaustedHandler): void {
    this.exhaustedHandlers.push(handler);
  }

  protected async run(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]> {
    if (!this.compressionConfig.enabled) return resources;

    const sessionKey = context.runtime.sessionKey;
    const entry = this.getOrCreateEntry(sessionKey);

    // 真互斥：promise 链原子交接。
    // v1 的 check-then-await 不是原子的：并发 B、C 同时读到旧 chain，
    // A 完成后 B、C 并行执行。v2 每个 run 先原子地把自己接到链尾，再等前一个。
    if (!this.compressionConfig.safety.serializePerSession) {
      return this.doRun(resources, context, entry);
    }

    const prev = entry.chain ?? Promise.resolve();
    let release!: () => void;
    const myChain = new Promise<void>(r => { release = r; });
    entry.chain = myChain;
    await prev.catch(() => { /* 旧 run 失败不阻塞新 run */ });
    try {
      return await this.doRun(resources, context, entry);
    } finally {
      release();
      if (entry.chain === myChain) entry.chain = null;
    }
  }

  // ─── 主流程 ─────────────────────────────────────────────────────

  private async doRun(
    resources: ContextResource[],
    context: TransformContext,
    entry: SessionEntry,
  ): Promise<ContextResource[]> {
    const cfg = this.compressionConfig;
    const sessionKey = context.runtime.sessionKey;
    const turn = context.runtime.turn;
    const safety = entry.safety;

    const budget = this.buildBudget();
    const tokens = this.meter.estimateAll(resources);

    // dryRun：只算 token + 生成遥测，不修改资源
    if (cfg.dryRun) {
      return this.runDry(resources, budget, tokens, sessionKey, turn, safety);
    }

    // 未到高水位：必要时启动后台预压缩，原样返回
    if (!budget.shouldCompact(tokens)) {
      this.maybeStartPrecompress(entry, resources, budget, tokens, sessionKey, turn);
      return resources;
    }

    // 尝试限流（跨 turn 重置；耗尽进冷却）
    if (!this.safetyGuard.canCompress(safety, turn)) return resources;

    const startTime = Date.now();
    const topContributors = this.computeTopContributors(resources, 3);
    const allTelemetry: CompressionTelemetry[] = [];

    let current = resources;

    // ── 策略 1：trim（无损） ──
    current = await this.runStrategy(this.trim, current, budget, safety, sessionKey, turn, allTelemetry, resources.length);

    // ── 策略 2：summarize（有损；优先消费预压缩产物） ──
    if (!budget.reachedTarget(this.meter.estimateAll(current)) && cfg.summarize.enabled) {
      const precomputed = await this.takePendingSummary(entry, current, turn);
      current = await this.runStrategy(
        this.summarize, current, budget, safety, sessionKey, turn, allTelemetry, resources.length,
        precomputed,
      );
    }

    // ── 策略 3：truncate（保底；仅当超硬限） ──
    if (budget.overHardLimit(this.meter.estimateAll(current))) {
      current = await this.runStrategy(this.truncate, current, budget, safety, sessionKey, turn, allTelemetry, resources.length);
    }

    // ── 上下文耗尽：truncate 后仍超硬限 → 发事件，检查点/换会话归 host ──
    const tokensAfter = this.meter.estimateAll(current);
    if (budget.overHardLimit(tokensAfter)) {
      await this.emitExhausted(
        current, budget, tokensAfter, safety, sessionKey, turn, allTelemetry,
      );
    }

    // ── 补充遥测元信息 ──
    const duration = Date.now() - startTime;
    for (const t of allTelemetry) {
      if (!t.sessionKey) t.sessionKey = sessionKey;
      if (!t.turn) t.turn = turn;
      t.duration = duration;
      t.topContributors = topContributors;
      t.messageCountBefore ??= resources.length;
      t.messageCountAfter ??= current.length;
    }

    this.pushTelemetryHistory(safety, allTelemetry);
    if (allTelemetry.length > 0 && cfg.telemetry.enabled) {
      this.reportTelemetry(allTelemetry);
    }

    // 预压缩产物由 takePendingSummary 在消费/失效时清理；
    // trim 单独达标跳过 summarize 时保留（应用前会再做有效性校验）
    return current;
  }

  /** 执行单个策略：尝试计数 + 配对校验 + 失败回滚（仅回滚该策略） */
  private async runStrategy(
    strategy: CompressionStrategy,
    resources: ContextResource[],
    budget: ContextBudget,
    safety: CompressionSafetyState,
    sessionKey: string,
    turn: number,
    allTelemetry: CompressionTelemetry[],
    messageCountBefore: number,
    precomputed?: PrecomputedSummary,
  ): Promise<ContextResource[]> {
    const ctx: StrategyContext = {
      resources,
      budget,
      meter: this.meter,
      safety,
      sessionKey,
      turn,
      config: this.compressionConfig,
      // trim/truncate 不需要 fork；统一注入 summarizeFork（lifecycle 用独立 runner）
      fork: this.summarizeFork,
      precomputed,
    };
    const result: StrategyResult = await strategy.compress(ctx);

    const unchanged = result.resources === resources && result.telemetry.every(t => !t.failed);
    if (unchanged && result.telemetry.length === 0) return resources;

    this.safetyGuard.recordAttempt(safety);

    // 失败遥测（fork 失败等）：保留 resources，只记录
    const hasFailure = result.telemetry.some(t => t.failed);
    if (hasFailure && result.resources === resources) {
      for (const t of result.telemetry) t.messageCountBefore = messageCountBefore;
      allTelemetry.push(...result.telemetry);
      return resources;
    }

    // 资源有变化：配对校验，失败回滚该策略
    if (result.resources !== resources
      && !this.safetyGuard.validateToolPairing(result.resources)) {
      allTelemetry.push(...result.telemetry.map(t => ({
        ...t,
        rolledBack: true,
        message: `${strategy.name}_tool_pairing_validation_failed`,
        messageCountBefore,
      })));
      return resources;
    }

    for (const t of result.telemetry) t.messageCountBefore = messageCountBefore;
    allTelemetry.push(...result.telemetry);
    return result.resources;
  }

  // ─── 预压缩 ────────────────────────────────────────────────────

  /** 低预警线：无 pending 时后台启动摘要 fork（不阻塞请求路径） */
  private maybeStartPrecompress(
    entry: SessionEntry,
    resources: ContextResource[],
    budget: ContextBudget,
    tokens: number,
    sessionKey: string,
    turn: number,
  ): void {
    const cfg = this.compressionConfig;
    if (!cfg.summarize.enabled || entry.pending) return;
    if (!budget.shouldPrecompress(tokens)) return;

    const ctx: StrategyContext = {
      resources,
      budget,
      meter: this.meter,
      safety: entry.safety,
      sessionKey,
      turn,
      config: cfg,
      fork: this.summarizeFork,
    };
    const promise = this.summarize
      .precompute(ctx)
      .then(summary => {
        if (summary) {
          this.pushTelemetryHistory(entry.safety, [createTelemetry(
            'precompress', 'precompress_ready', tokens, tokens, {
              sessionKey,
              turn,
              resourcesAffected: summary.sourceIds.length,
              forkDurationMs: summary.forkDurationMs,
              message: `background_summary_ready:${summary.sourceIds.length} resources`,
              prefixIntact: resources.length,
            },
          )]);
          if (cfg.telemetry.enabled) {
            this.reportTelemetry(entry.safety.telemetryHistory.slice(-1));
          }
        }
        return summary;
      })
      .catch(() => null);

    entry.pending = { promise, createdAtTurn: turn };
  }

  /** 取有效的预压缩产物：过期/失败 → null，并清理 pending */
  private async takePendingSummary(
    entry: SessionEntry,
    resources: ContextResource[],
    turn: number,
  ): Promise<PrecomputedSummary | undefined> {
    const pending = entry.pending;
    if (!pending) return undefined;

    // 过期淘汰
    if (turn - pending.createdAtTurn > PRECOMPRESS_MAX_TURNS) {
      entry.pending = null;
      return undefined;
    }

    const summary = await pending.promise;
    entry.pending = null;
    if (!summary) return undefined;

    // 有效性：sourceIds 仍在当前资源中（summarize.applyPrecomputed 会再验一次）
    const idSet = new Set(resources.map(r => r.id));
    if (!summary.sourceIds.every(id => idSet.has(id))) return undefined;
    return summary;
  }

  // ─── 上下文耗尽 ────────────────────────────────────────────────

  private async emitExhausted(
    resources: ContextResource[],
    budget: ContextBudget,
    tokensAfter: number,
    safety: CompressionSafetyState,
    sessionKey: string,
    turn: number,
    allTelemetry: CompressionTelemetry[],
  ): Promise<void> {
    // 原因推断：无可丢资源 → pinned 超限；否则是保护窗口超限
    const reason: ExhaustedReason =
      tokensAfter > 0 && resources.every(r => r.pinned)
        ? 'pinned_overload'
        : 'protected_overload';

    const { event, telemetry } = await generateHandoffDocument({
      config: this.compressionConfig,
      fork: this.lifecycleFork,
      safety,
      resources,
      sessionKey,
      turn,
      reason,
      tokensAfter,
      hardLimitTokens: budget.hardLimitTokens,
    });

    for (const t of telemetry) {
      t.messageCountBefore = resources.length;
      t.messageCountAfter = resources.length;
    }
    allTelemetry.push(...telemetry);
    this.pushTelemetryHistory(safety, telemetry);

    // 通知 host（检查点/换会话是 host 的职责）
    for (const handler of this.exhaustedHandlers) {
      try {
        await handler(event);
      } catch {
        // handler 失败不影响 pipeline
      }
    }
  }

  // ─── dryRun ─────────────────────────────────────────────────────

  private runDry(
    resources: ContextResource[],
    budget: ContextBudget,
    tokens: number,
    sessionKey: string,
    turn: number,
    safety: CompressionSafetyState,
  ): ContextResource[] {
    const telemetry: CompressionTelemetry[] = [];
    const would: string[] = [];
    if (budget.shouldPrecompress(tokens)) would.push('precompress');
    if (budget.shouldCompact(tokens)) {
      would.push('trim', 'summarize');
      if (budget.overHardLimit(tokens)) would.push('truncate');
    }

    if (would.length > 0) {
      const t = createTelemetry('dry_run', 'dry_run_would_trigger', tokens, tokens, {
        sessionKey,
        turn,
        message: `dry_run: would run [${would.join(' → ')}]`,
        prefixIntact: resources.length,
        messageCountBefore: resources.length,
        messageCountAfter: resources.length,
      });
      telemetry.push(t);
    }

    this.pushTelemetryHistory(safety, telemetry);
    if (telemetry.length > 0 && this.compressionConfig.telemetry.enabled) {
      this.reportTelemetry(telemetry);
    }
    return resources;
  }

  // ─── 辅助 ───────────────────────────────────────────────────────

  private buildBudget(): ContextBudget {
    const cfg = this.compressionConfig;
    return new ContextBudget(this.contextWindow, {
      outputReserveTokens: cfg.budget.outputReserveTokens ?? this.model.maxTokens,
      safetyMarginRatio: cfg.budget.safetyMarginRatio,
      triggerRatio: cfg.budget.triggerRatio,
      targetRatio: cfg.budget.targetRatio,
      precompressRatio: cfg.budget.precompressRatio,
    });
  }

  /** token 占比最高的 N 个 resource（运维定位"哪个工具刷屏"） */
  private computeTopContributors(
    resources: ContextResource[],
    limit: number,
  ): { id: string; type: string; tokens: number }[] {
    return resources
      .map(r => ({ id: r.id, type: r.type, tokens: this.meter.estimate(r) }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, limit);
  }

  private pushTelemetryHistory(safety: CompressionSafetyState, items: CompressionTelemetry[]): void {
    if (items.length === 0) return;
    safety.telemetryHistory.push(...items);
    if (safety.telemetryHistory.length > MAX_TELEMETRY_HISTORY) {
      safety.telemetryHistory.splice(0, safety.telemetryHistory.length - MAX_TELEMETRY_HISTORY);
    }
  }

  /** 上报遥测：优先 reporter，否则写入 sharedMap */
  private reportTelemetry(telemetry: CompressionTelemetry[]): void {
    if (this.telemetryReporter) {
      for (const t of telemetry) {
        try {
          this.telemetryReporter.report(t);
        } catch {
          // 上报失败不影响 pipeline
        }
      }
      return;
    }

    if (this.sharedMap) {
      const existing = (this.sharedMap.get(TELEMETRY_SHARED_KEY) as CompressionTelemetry[] | undefined) ?? [];
      this.sharedMap.set(TELEMETRY_SHARED_KEY, [...existing, ...telemetry]);
    }
  }

  private getOrCreateEntry(sessionKey: string): SessionEntry {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing;
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictOldest();
    }

    const entry: SessionEntry = {
      safety: createSafetyState(),
      lastAccess: Date.now(),
      chain: null,
      pending: null,
    };
    this.sessions.set(sessionKey, entry);
    return entry;
  }

  /**
   * LRU 淘汰：跳过有 in-flight fork 的 session；
   * 全部 in-flight 时兜底淘汰最老者（中断它），避免 Map 无限增长。
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.sessions) {
      if (hasInFlightForks(entry.safety)) continue;
      if (entry.lastAccess < oldestTime) {
        oldestTime = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = this.sessions.get(oldestKey);
      if (entry) abortSafetyState(entry.safety);
      this.sessions.delete(oldestKey);
      return;
    }

    // 兜底：所有 session 都 in-flight，淘汰真正最老的
    let fallbackOldest: string | null = null;
    let fallbackTime = Infinity;
    for (const [key, entry] of this.sessions) {
      if (entry.lastAccess < fallbackTime) {
        fallbackTime = entry.lastAccess;
        fallbackOldest = key;
      }
    }
    if (fallbackOldest) {
      const entry = this.sessions.get(fallbackOldest);
      if (entry) abortSafetyState(entry.safety);
      this.sessions.delete(fallbackOldest);
    }
  }
}

/** 工厂函数 */
export function createCompressionTransformer(
  options: CompressionTransformerOptions,
): ContextCompressionTransformer {
  return new ContextCompressionTransformer(options);
}
