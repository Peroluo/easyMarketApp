/**
 * ForkRunner - 统一的 fork（旁路模型调用）执行器
 *
 * 修复旧 L2/L3/L5 各自为战的 fork 代码的三个问题：
 *
 * 1. 输出截断静默当成功：旧实现累积 text_delta 从不看 stopReason，
 *    摘要被 forkMaxTokens 截断成半截时照样替换进上下文。
 *    现在捕获 done 事件的 stopReason，'length' 截断即判失败。
 * 2. 输入无预算：旧实现把整段 transcript 原样发给 fork 模型，
 *    上下文快满时 transcript 可能超过 fork 模型自身窗口 → fork 永远失败。
 *    现在暴露 inputTokenLimit()，调用方（summarize 策略）按预算分块 map-reduce。
 * 3. 校准断链：fork 已采集 usage 却从不回填估算器。
 *    现在每次 fork 用真实 usage.input 自动 recordActualUsage。
 */

import type { Model, Context, Message, StreamFn } from '@aipack-ai/agent';
import type { TokenEstimator } from './token-estimator';
import type { CompressionSafetyState } from './safety';
import {
  runForkWithRetry,
  ForkStreamError,
  type RetryConfig,
} from './retry';

// ─── 类型 ─────────────────────────────────────────────────────────

export interface ForkTextCall {
  systemPrompt: string;
  userPrompt: string;
  /** 遥测/会话隔离用 */
  sessionKey: string;
  turn: number;
  /** 遥测 label（如 'summarize_map' / 'lifecycle_handoff'） */
  label: string;
}

export interface ForkTextResult {
  ok: boolean;
  text: string | null;
  /** 输出被 max_tokens 截断（stopReason === 'length'） */
  truncated: boolean;
  retries: number;
  durationMs: number;
  usage?: { input?: number; output?: number; total?: number };
  /** fork 失败原因（truncated / empty / error / aborted） */
  failureReason?: string;
}

export interface ForkRunnerOptions {
  streamFn: StreamFn;
  model: Model;
  meter: TokenEstimator;
  forkModel?: string;
  forkMaxTokens: number;
  forkTimeoutMs: number;
  retry: RetryConfig;
}

/** fork 输入的额外边距（prompt 模板 + 估算误差） */
const FORK_INPUT_MARGIN_TOKENS = 512;

// ─── 实现 ─────────────────────────────────────────────────────────

export class ForkRunner {
  constructor(private opts: ForkRunnerOptions) {}

  /** fork 实际使用的模型（forkModel 覆盖 id、forkMaxTokens 覆盖输出上限） */
  resolveModel(): Model {
    const { forkModel, forkMaxTokens, model } = this.opts;
    if (!forkModel && !forkMaxTokens) return model;
    return {
      ...model,
      ...(forkModel ? { id: forkModel, name: forkModel } : {}),
      maxTokens: forkMaxTokens || model.maxTokens,
    };
  }

  /**
   * fork 输入 token 预算：fork 模型窗口 - 输出上限 - 边距。
   * 调用方构建 prompt 时必须保证 estimateText(transcript) 不超过此值，
   * 超过则分块（map-reduce）。
   */
  inputTokenLimit(): number {
    const m = this.resolveModel();
    return Math.max(1, m.contextWindow - m.maxTokens - FORK_INPUT_MARGIN_TOKENS);
  }

  /**
   * 执行一次 fork 文本生成。
   * - stopReason === 'length'（输出被截断）→ 判失败，不返回半截文本
   * - 空输出 → 判失败
   * - 成功且带 usage.input → 自动回填估算器校准
   */
  async runText(safety: CompressionSafetyState, call: ForkTextCall): Promise<ForkTextResult> {
    if (safety.sessionAbortController?.signal.aborted) {
      return { ok: false, text: null, truncated: false, retries: 0, durationMs: 0, failureReason: 'aborted' };
    }

    const forkModel = this.resolveModel();
    const context: Context = {
      systemPrompt: call.systemPrompt,
      messages: [{
        role: 'user',
        content: call.userPrompt,
        timestamp: Date.now(),
      }],
    };
    const forkSessionId = `${call.sessionKey}#fork#${call.label}#t${call.turn}`;

    // 用于校准的输入估算（systemPrompt + userPrompt）
    const estimatedInput = this.opts.meter.estimateText(
      `${call.systemPrompt}\n${call.userPrompt}`,
    );

    let truncated = false;
    let usage: ForkTextResult['usage'] | undefined;
    let stopReason: string | undefined;

    const out = await runForkWithRetry(
      safety,
      this.opts.forkTimeoutMs,
      this.opts.retry,
      async (signal) => {
        let text = '';
        for await (const event of this.opts.streamFn(forkModel, context, {
          signal,
          sessionId: forkSessionId,
        })) {
          if (event.type === 'text_delta') text += event.delta;
          if (event.type === 'done') {
            const msg = event.message as Message & {
              stopReason?: string;
              usage?: { input?: number; output?: number; total?: number };
            };
            stopReason = msg.stopReason;
            if (msg.usage) {
              usage = {
                input: msg.usage.input,
                output: msg.usage.output,
                total: msg.usage.total,
              };
            }
          }
          if (event.type === 'error') {
            const errMsg = event.message as { errorMessage?: string; status?: number } | undefined;
            throw new ForkStreamError(
              errMsg?.errorMessage ?? 'stream_error',
              /* retryable */ true,
              errMsg?.status,
            );
          }
        }
        return { value: text, usage };
      },
    );

    if (!out.ok) {
      return {
        ok: false,
        text: null,
        truncated: false,
        retries: out.retries,
        durationMs: out.durationMs,
        usage: out.usage,
        failureReason: safety.sessionAbortController?.signal.aborted ? 'aborted' : 'error',
      };
    }

    // 校准闭环：真实 usage.input 回填估算器
    if (usage?.input && usage.input > 0) {
      this.opts.meter.recordActualUsage?.(estimatedInput, usage.input);
    }

    // 输出被 max_tokens 截断：半截摘要/交接文档不可信，判失败
    if (stopReason === 'length') {
      truncated = true;
      return {
        ok: false,
        text: null,
        truncated,
        retries: out.retries,
        durationMs: out.durationMs,
        usage,
        failureReason: 'truncated',
      };
    }

    if (!out.value) {
      return {
        ok: false,
        text: null,
        truncated: false,
        retries: out.retries,
        durationMs: out.durationMs,
        usage,
        failureReason: 'empty',
      };
    }

    return {
      ok: true,
      text: out.value,
      truncated: false,
      retries: out.retries,
      durationMs: out.durationMs,
      usage,
    };
  }
}
