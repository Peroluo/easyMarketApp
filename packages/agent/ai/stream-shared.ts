/**
 * stream 实现共享工具（stream-openai / stream-anthropic 共用）：
 * - createErrorEvent        构造带模型/提供商元数据的 error 流事件
 * - buildRequestErrorEvent  请求阶段失败（abort / HTTP / 网络）归一化为 error 事件
 * - buildResponseErrorEvent 响应 !ok 时消费 body 并构造 error 事件
 * - createTimeoutReader     idle/total 双超时的 reader.read 包装
 * - createStreamResult      StreamResult 公共包装（懒生成器 + result()）
 */

import type {
  Model,
  StreamEvent,
  StreamResult,
  AssistantMessage,
} from './types';
import { createEmptyAssistantMessage } from './types';
import { AgentError, AgentErrorCategory, classifyError, formatCategoryError, formatHttpError } from './errors';
import { normalizeResponseError } from './error-body';

// ─── error 流事件构造 ──────────────────────────────────────────────

/** 构造携带模型元数据的 error 流事件（aborted=true 时 reason 为 'aborted'） */
export function createErrorEvent(model: Model, message: string, aborted = false): StreamEvent {
  const error: AssistantMessage = createEmptyAssistantMessage();
  error.model = model.id;
  error.provider = model.provider;
  error.stopReason = aborted ? 'aborted' : 'error';
  error.errorMessage = message;
  return { type: 'error', reason: aborted ? 'aborted' : 'error', error };
}

/**
 * 请求阶段失败（retry 耗尽后抛出）归一化为 error 事件：
 * - abort（AbortError / signal 已中止）→ 'Request aborted'
 * - HTTP 错误（带数字 status，可能为被 retry 抛出的 Response）：消费 body
 *   文本（避免连接泄漏 + 提供可读信息），失败时退回 statusText
 * - 网络错误 / 超时 / 其他：按 AgentError 分类打前缀
 */
export async function buildRequestErrorEvent(
  model: Model,
  e: unknown,
  signal: AbortSignal | undefined,
  httpErrorLabel?: string,
): Promise<StreamEvent> {
  const aborted = (e as { name?: string } | null)?.name === 'AbortError' || signal?.aborted;
  if (aborted) {
    return createErrorEvent(model, 'Request aborted', true);
  }
  const status = (e as { status?: unknown } | null)?.status;
  if (status && typeof status === 'number') {
    let message: string;
    try {
      message = (await normalizeResponseError(e as Parameters<typeof normalizeResponseError>[0])).message;
    } catch {
      message = (e as { statusText?: string }).statusText || `HTTP ${status}`;
    }
    return createErrorEvent(model, formatHttpError(status, message, httpErrorLabel));
  }
  const category = classifyError(e);
  return createErrorEvent(model, formatCategoryError(category, String((e as Error | null)?.message ?? e)));
}

/** 响应阶段失败（retry 后仍 !res.ok 且状态码不可重试）：消费 body 构造 error 事件 */
export async function buildResponseErrorEvent(
  model: Model,
  response: Response,
  httpErrorLabel?: string,
): Promise<StreamEvent> {
  const normalized = await normalizeResponseError(response);
  return createErrorEvent(model, formatHttpError(response.status, normalized.message, httpErrorLabel));
}

// ─── 双超时 reader 包装 ────────────────────────────────────────────

export type TimeoutReader = () => Promise<{ done: boolean; value: Uint8Array | undefined }>;

/**
 * 包装 reader.read()，取 idle / total 两者中更早到期者：
 * - idleTimeoutMs：两次数据块之间无新数据视为断流（防半开连接永久挂起）
 * - totalTimeoutMs：整个流式响应从开始到结束的硬时限（防"持续有数据但整体超长"）
 *
 * 两者均未配置（idle<=0 且 total<=0）时直接透传 read()；
 * idle 禁用但配置 total 时仍执行 total 硬限。
 */
export function createTimeoutReader(
  reader: { read(): Promise<{ done: boolean; value: Uint8Array | undefined }> },
  idleTimeoutMs: number,
  totalTimeoutMs: number,
): TimeoutReader {
  const hasIdle = idleTimeoutMs > 0;
  const hasTotal = totalTimeoutMs > 0;
  if (!hasIdle && !hasTotal) return () => reader.read();

  const deadline = hasTotal ? Date.now() + totalTimeoutMs : Infinity;
  return async () => {
    const readPromise = reader.read();
    // 总超时优先：剩余时间耗尽则立即失败，无需再等待 idle
    const remaining = hasTotal ? deadline - Date.now() : Infinity;
    if (remaining <= 0) {
      throw new AgentError(
        `Stream total timeout after ${totalTimeoutMs}ms`,
        { category: AgentErrorCategory.TIMEOUT },
      );
    }
    const waitMs = hasIdle ? Math.min(idleTimeoutMs, remaining) : remaining;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        readPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              const isTotal = hasTotal && Date.now() >= deadline;
              reject(new AgentError(
                isTotal
                  ? `Stream total timeout after ${totalTimeoutMs}ms`
                  : `Stream idle timeout after ${idleTimeoutMs}ms`,
                { category: AgentErrorCategory.TIMEOUT },
              ));
            },
            waitMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

// ─── StreamResult 公共包装 ─────────────────────────────────────────

/**
 * 由 runStream 生成器构造公共 StreamResult：懒初始化生成器（首次迭代/
 * result() 才发起请求），result() 消费全部事件并返回最终 assistant 消息
 * （done 或 error 事件的 message/error；无两者时返回空消息兜底）。
 */
export function createStreamResult(
  createGenerator: () => AsyncGenerator<StreamEvent>,
): StreamResult {
  let finalMessage: AssistantMessage = createEmptyAssistantMessage();
  let generator: AsyncGenerator<StreamEvent> | null = null;

  const getGenerator = (): AsyncGenerator<StreamEvent> => {
    if (!generator) {
      generator = createGenerator();
    }
    return generator;
  };

  return {
    [Symbol.asyncIterator]() {
      return getGenerator();
    },
    async result(): Promise<AssistantMessage> {
      for await (const event of getGenerator()) {
        if (event.type === 'done') {
          finalMessage = event.message;
        } else if (event.type === 'error') {
          finalMessage = event.error;
        }
      }
      return finalMessage;
    },
  };
}
