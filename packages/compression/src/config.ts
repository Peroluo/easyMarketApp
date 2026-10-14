/**
 * 压缩配置 - v2 策略管道架构
 *
 * 相比 v1（L1~L5 五级阈值瀑布）的变化：
 *   - 五级 threshold/targetRatio 矩阵 → budget 双水位（trigger/target/precompress）
 *   - 级别开关 → 策略开关（trim / summarize / truncate）
 *   - 会话生命周期（检查点/交接）拆到 lifecycle，由 host 通过事件处理
 *
 * 环境变量加载支持显式 0 值（修复 v1 `Number(env.X) || default` 无法设置 0 的问题）。
 */

import type { RetryConfig } from './retry';

// ─── 配置接口 ─────────────────────────────────────────────────────

export interface CompressionConfig {
  enabled: boolean;

  estimator: {
    charsPerTokenAscii: number;
    charsPerTokenCJK: number;
    /** 每个图片块的估算 token */
    imageTokensPerBlock: number;
    /** string 缓存容量 */
    cacheCapacity: number;
  };

  budget: {
    /**
     * 为模型输出预留的 token。
     * 缺省（undefined）= 取 model.maxTokens；设 0 表示不预留（不推荐）。
     */
    outputReserveTokens?: number;
    /** 相对 contextWindow 的安全边距比例（估算误差缓冲） */
    safetyMarginRatio: number;
    /** 高水位：达到 effective × triggerRatio 触发压缩 */
    triggerRatio: number;
    /** 低水位：压缩目标 */
    targetRatio: number;
    /** 预压缩启动线（须 < triggerRatio） */
    precompressRatio: number;
  };

  /** 策略 1：无损裁剪（thinking 剥离、tool result 按 token 预算裁剪、空白规范化） */
  trim: {
    enabled: boolean;
    stripThinking: boolean;
    trimToolResults: boolean;
    normalizeWhitespace: boolean;
    /** 单个 tool_result 的 token 预算，超过即裁剪（按 token 而非行数，单行大输出同样生效） */
    toolResultMaxTokens: number;
    toolResultHeadLines: number;
    toolResultTailLines: number;
    /** 裁剪时保留的关键行上限（error/fail/exception 等匹配行） */
    keyLineLimit: number;
  };

  /** 策略 2：有损摘要（fork 模型，支持 map-reduce 分块，pinned 摘要再摘要） */
  summarize: {
    enabled: boolean;
    forkModel?: string;
    forkMaxTokens: number;
    /** 可压缩资源少于该数则跳过摘要 */
    minResourcesToCompress: number;
    /** 保护最近的 N 条资源不参与摘要 */
    protectedRecentCount: number;
    /** map-reduce 单块 transcript token 预算（0 = 不分块，按 fork 窗口自动决定） */
    maxChunkTokens: number;
    /**
     * pinned 历史摘要再摘要触发比例：旧摘要总量超过 effective × 该值时，
     * 并入本次摘要一并再压缩（修复 v1 假合并只拼接不减 token 的问题）
     */
    pinnedReSummarizeRatio: number;
  };

  /** 策略 3：硬截断保底（按工具对整体丢弃最旧非 pinned 资源） */
  truncate: {
    enabled: boolean;
    /** 保护最近 N 条非 pinned 资源不被丢弃 */
    minWorkingSet: number;
  };

  /** 会话生命周期：上下文耗尽事件（检查点/交接由 host 处理，压缩器只发事件） */
  lifecycle: {
    enabled: boolean;
    forkModel?: string;
    forkMaxTokens: number;
  };

  safety: {
    /** 单 turn 内最大压缩尝试次数（跨 level 累加，跨 turn 重置） */
    maxAttempts: number;
    /** 尝试耗尽后的冷却 turn 数（失败退避，不再永久禁用） */
    cooldownTurns: number;
    forkTimeoutMs: number;
    retry: RetryConfig;
    /** 同 session 是否强制串行化 */
    serializePerSession: boolean;
  };

  /** 只算 token + 生成遥测，不修改资源 */
  dryRun: boolean;

  telemetry: {
    enabled: boolean;
    logTokenDelta: boolean;
    logTriggerReason: boolean;
  };
}

// ─── 深度部分类型 ─────────────────────────────────────────────────

/** 深度部分类型，允许只覆盖嵌套对象的某些字段 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ─── 环境变量工具（支持显式 0 值） ─────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function envStr(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw !== '' ? raw : undefined;
}

// ─── 默认配置加载 ─────────────────────────────────────────────────

export function loadCompressionConfig(
  overrides?: DeepPartial<CompressionConfig>,
): CompressionConfig {
  const env = process.env;

  const config: CompressionConfig = {
    enabled: envBool('AIPACK_COMPRESSION_ENABLED', true),

    estimator: {
      charsPerTokenAscii: envNum('AIPACK_CHARS_PER_TOKEN_ASCII', 4),
      charsPerTokenCJK: envNum('AIPACK_CHARS_PER_TOKEN_CJK', 1.5),
      imageTokensPerBlock: envNum('AIPACK_IMAGE_TOKENS_PER_BLOCK', 1500),
      cacheCapacity: envNum('AIPACK_ESTIMATOR_CACHE', 1000),
    },

    budget: {
      outputReserveTokens: env.AIPACK_COMPRESSION_OUTPUT_RESERVE !== undefined
        ? envNum('AIPACK_COMPRESSION_OUTPUT_RESERVE', 0)
        : undefined,
      safetyMarginRatio: envNum('AIPACK_COMPRESSION_MARGIN_RATIO', 0.05),
      triggerRatio: envNum('AIPACK_COMPRESSION_TRIGGER_RATIO', 0.80),
      targetRatio: envNum('AIPACK_COMPRESSION_TARGET_RATIO', 0.40),
      precompressRatio: envNum('AIPACK_COMPRESSION_PRECOMPRESS_RATIO', 0.70),
    },

    trim: {
      enabled: envBool('AIPACK_TRIM_ENABLED', true),
      stripThinking: envBool('AIPACK_TRIM_STRIP_THINKING', true),
      trimToolResults: envBool('AIPACK_TRIM_TOOL_RESULTS', true),
      normalizeWhitespace: envBool('AIPACK_TRIM_NORMALIZE_WS', true),
      toolResultMaxTokens: envNum('AIPACK_TRIM_TOOL_MAX_TOKENS', 2000),
      toolResultHeadLines: envNum('AIPACK_TRIM_TOOL_HEAD_LINES', 10),
      toolResultTailLines: envNum('AIPACK_TRIM_TOOL_TAIL_LINES', 10),
      keyLineLimit: envNum('AIPACK_TRIM_KEY_LINE_LIMIT', 5),
    },

    summarize: {
      enabled: envBool('AIPACK_SUMMARIZE_ENABLED', true),
      forkModel: envStr('AIPACK_SUMMARIZE_FORK_MODEL'),
      forkMaxTokens: envNum('AIPACK_SUMMARIZE_FORK_MAX_TOKENS', 2048),
      minResourcesToCompress: envNum('AIPACK_SUMMARIZE_MIN_RESOURCES', 4),
      protectedRecentCount: envNum('AIPACK_SUMMARIZE_PROTECTED_RECENT', 6),
      maxChunkTokens: envNum('AIPACK_SUMMARIZE_MAX_CHUNK_TOKENS', 24000),
      pinnedReSummarizeRatio: envNum('AIPACK_SUMMARIZE_PINNED_RESUMMARY_RATIO', 0.05),
    },

    truncate: {
      enabled: envBool('AIPACK_TRUNCATE_ENABLED', true),
      minWorkingSet: envNum('AIPACK_TRUNCATE_MIN_WORKING_SET', 2),
    },

    lifecycle: {
      enabled: envBool('AIPACK_LIFECYCLE_ENABLED', true),
      forkModel: envStr('AIPACK_LIFECYCLE_FORK_MODEL'),
      forkMaxTokens: envNum('AIPACK_LIFECYCLE_FORK_MAX_TOKENS', 2048),
    },

    safety: {
      maxAttempts: envNum('AIPACK_COMPRESSION_MAX_ATTEMPTS', 5),
      cooldownTurns: envNum('AIPACK_COMPRESSION_COOLDOWN_TURNS', 3),
      forkTimeoutMs: envNum('AIPACK_COMPRESSION_FORK_TIMEOUT', 30_000),
      retry: {
        retries: envNum('AIPACK_FORK_RETRY_COUNT', 2),
        baseMs: envNum('AIPACK_FORK_RETRY_BASE_MS', 500),
        maxMs: envNum('AIPACK_FORK_RETRY_MAX_MS', 4000),
      },
      serializePerSession: envBool('AIPACK_COMPRESSION_SERIALIZE', true),
    },

    dryRun: envBool('AIPACK_COMPRESSION_DRY_RUN', false),

    telemetry: {
      enabled: envBool('AIPACK_COMPRESSION_TELEMETRY', true),
      logTokenDelta: envBool('AIPACK_COMPRESSION_TELEMETRY_LOG_DELTA', true),
      logTriggerReason: envBool('AIPACK_COMPRESSION_TELEMETRY_LOG_REASON', true),
    },
  };

  if (overrides) {
    return deepMerge(config, overrides);
  }
  return config;
}

// ─── 配置校验 ─────────────────────────────────────────────────────

export interface ConfigValidationError {
  path: string;
  message: string;
  severity: 'warn' | 'error';
}

/**
 * 校验压缩配置。
 * - 各比例必须在 (0, 1]
 * - 双水位关系：target < trigger，precompress < trigger
 * - 正数字段必须 > 0
 *
 * 默认仅 warn（不抛错），生产环境配错也能启动；strict=true 时抛出首个 error。
 */
export function validateConfig(
  config: CompressionConfig,
  strict = false,
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  const assertRatio = (path: string, value: number, allowZero = false) => {
    const min = allowZero ? 0 : 0;
    if (!Number.isFinite(value) || value <= min || value > 1) {
      errors.push({
        path,
        message: `${value} 必须在 (${allowZero ? '0' : '0'}, 1] 范围`,
        severity: 'warn',
      });
    }
  };
  const assertPositive = (path: string, value: number) => {
    if (!Number.isFinite(value) || value <= 0) {
      errors.push({ path, message: `${value} 必须 > 0`, severity: 'warn' });
    }
  };
  const assertNonNegative = (path: string, value: number) => {
    if (!Number.isFinite(value) || value < 0) {
      errors.push({ path, message: `${value} 必须 >= 0`, severity: 'warn' });
    }
  };

  assertPositive('estimator.charsPerTokenAscii', config.estimator.charsPerTokenAscii);
  assertPositive('estimator.charsPerTokenCJK', config.estimator.charsPerTokenCJK);
  assertPositive('estimator.imageTokensPerBlock', config.estimator.imageTokensPerBlock);
  assertNonNegative('estimator.cacheCapacity', config.estimator.cacheCapacity);

  if (config.budget.outputReserveTokens !== undefined) {
    assertNonNegative('budget.outputReserveTokens', config.budget.outputReserveTokens);
  }
  assertRatio('budget.safetyMarginRatio', config.budget.safetyMarginRatio, true);
  assertRatio('budget.triggerRatio', config.budget.triggerRatio);
  assertRatio('budget.targetRatio', config.budget.targetRatio);
  assertRatio('budget.precompressRatio', config.budget.precompressRatio);

  // 双水位关系：低水位必须低于高水位，预压缩线必须低于高水位
  if (config.budget.targetRatio >= config.budget.triggerRatio) {
    errors.push({
      path: 'budget.targetRatio',
      message: `targetRatio(${config.budget.targetRatio}) 应小于 triggerRatio(${config.budget.triggerRatio})，否则压缩无摊薄效果`,
      severity: 'warn',
    });
  }
  if (config.budget.precompressRatio >= config.budget.triggerRatio) {
    errors.push({
      path: 'budget.precompressRatio',
      message: `precompressRatio(${config.budget.precompressRatio}) 应小于 triggerRatio(${config.budget.triggerRatio})，否则预压缩永远不会启动`,
      severity: 'warn',
    });
  }

  assertPositive('trim.toolResultMaxTokens', config.trim.toolResultMaxTokens);
  assertNonNegative('trim.toolResultHeadLines', config.trim.toolResultHeadLines);
  assertNonNegative('trim.toolResultTailLines', config.trim.toolResultTailLines);
  assertNonNegative('trim.keyLineLimit', config.trim.keyLineLimit);

  assertPositive('summarize.forkMaxTokens', config.summarize.forkMaxTokens);
  assertPositive('summarize.minResourcesToCompress', config.summarize.minResourcesToCompress);
  assertNonNegative('summarize.protectedRecentCount', config.summarize.protectedRecentCount);
  assertNonNegative('summarize.maxChunkTokens', config.summarize.maxChunkTokens);
  assertRatio('summarize.pinnedReSummarizeRatio', config.summarize.pinnedReSummarizeRatio, true);

  assertNonNegative('truncate.minWorkingSet', config.truncate.minWorkingSet);

  assertPositive('lifecycle.forkMaxTokens', config.lifecycle.forkMaxTokens);

  assertPositive('safety.maxAttempts', config.safety.maxAttempts);
  assertNonNegative('safety.cooldownTurns', config.safety.cooldownTurns);
  assertNonNegative('safety.forkTimeoutMs', config.safety.forkTimeoutMs);
  assertNonNegative('safety.retry.retries', config.safety.retry.retries);
  assertPositive('safety.retry.baseMs', config.safety.retry.baseMs);
  assertPositive('safety.retry.maxMs', config.safety.retry.maxMs);

  if (strict) {
    const firstError = errors.find(e => e.severity === 'error');
    if (firstError) {
      throw new Error(`[aipack-compression] Invalid config at ${firstError.path}: ${firstError.message}`);
    }
  }

  return errors;
}

// ─── 工具函数 ─────────────────────────────────────────────────────

function deepMerge<T>(base: T, overrides: DeepPartial<T>): T {
  const result: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const key of Object.keys(overrides)) {
    const ov = (overrides as any)[key];
    const bv = (base as any)[key];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && bv && typeof bv === 'object') {
      result[key] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      result[key] = ov;
    }
  }
  return result;
}
