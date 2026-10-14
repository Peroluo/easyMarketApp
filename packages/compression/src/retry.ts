/**
 * Fork 重试与退避
 *
 * 解决 P0#4：旧实现把 429 / 5xx / 网络抖动等瞬时错误和"模型生成失败"混为一谈，
 * 直接 return null 触发降级。生产中这会链式误降到 L5。
 *
 * 设计：
 *  - retryWithBackoff: 通用退避重试（指数退避 + jitter）
 *  - isRetryableStreamError: 判断错误是否值得重试
 *  - runForkWithRetry: 组合 runFork（per-fork AbortController）+ retry
 */

import type { CompressionSafetyState } from './safety';
import { runFork } from './safety';

// ─── 错误类型 ─────────────────────────────────────────────────────

/** fork 流中显式 error 事件 */
export class ForkStreamError extends Error {
  constructor(
    message: string,
    /** 是否可重试（默认 true） */
    public readonly retryable: boolean = true,
    /** 关联的 HTTP status / 错误码（用于精细化重试决策） */
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ForkStreamError';
  }
}

// ─── 重试配置 ─────────────────────────────────────────────────────

export interface RetryConfig {
  /** 重试次数（不含首次执行），默认 2 */
  retries: number;
  /** 首次退避基数（ms），默认 500 */
  baseMs: number;
  /** 退避上限（ms），默认 4000 */
  maxMs: number;
  /** 判断错误是否可重试；默认 isRetryableStreamError */
  isRetryable?: (err: unknown) => boolean;
}

export const DEFAULT_FORK_RETRY: RetryConfig = {
  retries: 2,
  baseMs: 500,
  maxMs: 4000,
  isRetryable: isRetryableStreamError,
};

/**
 * 判断错误是否可重试。
 *  - AbortError（用户/超时取消）：不重试
 *  - ForkStreamError：status 精细化判断优先（429/5xx 重试、4xx 不重试），
 *    无 status 时按 retryable 标志
 *  - 含 status 字段的普通错误：429 / 5xx 重试，其余 4xx 不重试
 *  - 其他 Error：保守重试（默认 retryable=true）
 */
export function isRetryableStreamError(err: unknown): boolean {
  if (err instanceof ForkStreamError) {
    if (typeof err.status === 'number') {
      if (err.status === 429) return true;
      if (err.status >= 500 && err.status < 600) return true;
      if (err.status >= 400 && err.status < 500 && err.status !== 408) return false;
    }
    return err.retryable;
  }

  // AbortError / DOMException: 主动取消不重试
  if (err instanceof Error) {
    const name = (err as Error & { name?: string }).name;
    if (name === 'AbortError') return false;
    if (typeof DOMException !== 'undefined' && err instanceof DOMException && name === 'AbortError') {
      return false;
    }
  }

  // 含 status 字段（自定义错误）的精细化判断
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
  }

  return true;
}

// ─── 退避算法 ─────────────────────────────────────────────────────

/** 计算第 attempt 次重试的延迟（指数退避 + ±30% jitter） */
export function computeBackoffDelay(attempt: number, config: RetryConfig): number {
  const base = Math.min(config.maxMs, config.baseMs * 2 ** attempt);
  const jitter = (Math.random() - 0.5) * 0.6 * base;
  return Math.max(0, Math.round(base + jitter));
}

/**
 * 通用退避重试。
 * - fn 抛出可重试错误 → 等待退避后重试
 * - fn 抛出不可重试错误 → 立即重新抛出
 * - 重试耗尽 → 抛出最后一次错误
 * - 退避等待期间 signal abort → 立即抛 AbortError，不再空等
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  const isRetryable = config.isRetryable ?? isRetryableStreamError;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= config.retries; attempt++) {
    if (signal?.aborted) {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= config.retries) break;
      if (!isRetryable(err)) break;

      const delay = computeBackoffDelay(attempt, config);
      onRetry?.(err, attempt + 1, delay);
      await sleepAbortable(delay, signal);
    }
  }
  throw lastErr;
}

/** 可中断睡眠：signal abort 时提前结束 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(resolve => setTimeout(resolve, ms));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
    };
    if (signal.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── Fork 组合：runFork + retry ───────────────────────────────────

/** runForkWithRetry 的结果 */
export interface ForkResult<T> {
  /** 是否成功 */
  ok: boolean;
  /** 成功时的值 */
  value: T | null;
  /** 实际重试次数（不含首次） */
  retries: number;
  /** 总耗时（ms，含重试间隔） */
  durationMs: number;
  /** fork 调用的 token 用量（从 done 事件捕获） */
  usage?: { input?: number; output?: number; total?: number };
}

/** fork 回调的返回值：值 + 可选用量 */
export interface ForkCallbackResult<T> {
  value: T;
  usage?: { input?: number; output?: number; total?: number };
}

/**
 * 执行一次带重试的 fork 调用。
 *
 * - 每次重试都会创建新的 per-fork AbortController（runFork 内部）
 * - fn 应返回 ForkCallbackResult（值 + 可选 usage）
 * - fn 应在收到 stream error 事件时 throw ForkStreamError
 * - 重试耗尽或遇到不可重试错误 → ok=false
 * - sessionAbortController 触发后（aborted） → 立即返回 ok=false
 * - P2#15: 统计 retries / durationMs / usage 供遥测使用
 */
export async function runForkWithRetry<T>(
  state: CompressionSafetyState,
  forkTimeoutMs: number,
  retry: RetryConfig,
  fn: (signal: AbortSignal | undefined) => Promise<ForkCallbackResult<T>>,
): Promise<ForkResult<T>> {
  // session 已 abort：不再尝试
  if (state.sessionAbortController?.signal.aborted) {
    return { ok: false, value: null, retries: 0, durationMs: 0 };
  }

  const start = Date.now();
  let retries = 0;

  try {
    const result = await retryWithBackoff(
      () => runFork(state, forkTimeoutMs, fn),
      retry,
      (_err, attempt) => { retries = attempt; },
      state.sessionAbortController?.signal,
    );
    return { ok: true, value: result.value, usage: result.usage, retries, durationMs: Date.now() - start };
  } catch {
    return { ok: false, value: null, retries, durationMs: Date.now() - start };
  }
}
