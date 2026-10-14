/**
 * 策略管道共享类型
 *
 * 三个策略按固定顺序执行，各自尽力把 token 压到目标：
 *   trim（无损）→ summarize（有损）→ truncate（保底）
 *
 * 每个策略：
 *   - 拿到的是"当前"资源列表，返回新的资源列表（不可变更新）
 *   - transformer 在每级之后做 tool pairing 校验，失败仅回滚该策略
 *   - prefixIntact 如实报告"首个被修改/删除资源之前有多少资源未动"
 *     （KV cache 的保持边界，取代 v1 误导性的 cachePreserved 布尔值）
 */

import type { ContextResource } from '@aipack-ai/agent';
import { extractText } from '@aipack-ai/agent';
import type { ContextBudget } from './budget';
import type { TokenEstimator } from './token-estimator';
import type { CompressionSafetyState } from './safety';
import type { ForkRunner } from './fork';
import type { CompressionConfig } from './config';
import type { CompressionTelemetry } from './telemetry';

// ─── 预压缩产物 ───────────────────────────────────────────────────

/** 后台预压缩生成的摘要（precompress 阶段产出，summarize 阶段消费） */
export interface PrecomputedSummary {
  /** 被摘要区域的资源 id（应用时须全部仍存在于当前资源中） */
  sourceIds: string[];
  /** 摘要文本 */
  text: string;
  forkDurationMs: number;
  /** 产出时的 turn（用于过期淘汰） */
  createdAtTurn: number;
}

// ─── 策略接口 ─────────────────────────────────────────────────────

export interface StrategyContext {
  resources: ContextResource[];
  budget: ContextBudget;
  meter: TokenEstimator;
  safety: CompressionSafetyState;
  sessionKey: string;
  turn: number;
  config: CompressionConfig;
  fork: ForkRunner;
  /** 预压缩就绪的摘要（仅 summarize 消费；无效则策略自行 fork） */
  precomputed?: PrecomputedSummary;
}

export interface StrategyResult {
  resources: ContextResource[];
  telemetry: CompressionTelemetry[];
  /** 首个被修改/删除资源之前的资源数（KV cache 保持边界） */
  prefixIntact: number;
  /** summarize 专用：是否消费了 precomputed（避免重复计费） */
  consumedPrecomputed?: boolean;
}

export interface CompressionStrategy {
  readonly name: 'trim' | 'summarize' | 'truncate';
  compress(ctx: StrategyContext): Promise<StrategyResult>;
}

// ─── 共享工具 ─────────────────────────────────────────────────────

/** 无操作结果 */
export function noopResult(resources: ContextResource[]): StrategyResult {
  return { resources, telemetry: [], prefixIntact: resources.length };
}

/**
 * 提取资源的可读文本（用于 transcript 构建）。
 * agent 包的 extractTextFromResource 对对象 content 返回 ''，
 * 此处补充处理：
 *   - ContentBlock[] → 拼接 text 块
 *   - Message 对象（compaction_summary 的 content）→ 取其 content 字符串
 *   - 其他对象 → JSON 近似
 */
export function resourceText(r: ContextResource): string {
  const c = r.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    try {
      return extractText(c);
    } catch {
      return '';
    }
  }
  if (c && typeof c === 'object') {
    const inner = (c as { content?: unknown }).content;
    if (typeof inner === 'string') return inner;
    try {
      return JSON.stringify(c);
    } catch {
      return '';
    }
  }
  return '';
}

/** 格式化资源为摘要输入文本 */
export function formatResourceForTranscript(r: ContextResource): string {
  const text = resourceText(r);
  if (!text) return `[${r.type}]`;
  return `[${r.type}] ${text}`;
}
