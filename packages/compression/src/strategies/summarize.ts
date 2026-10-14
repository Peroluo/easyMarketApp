/**
 * SummarizeStrategy - 有损摘要策略
 *
 * 修复 v1（L2/L3/L4 假合并）的四个问题：
 *
 * 1. round-trip 契约：v1 摘要资源 content 存裸字符串，resourcesToMessages 的
 *    default 分支把字符串当 Message 返回 → buildContext/provider 崩溃。
 *    v2 按 agent 包契约存完整 Message 对象（role='compactionSummary'）。
 * 2. fork 输入预算：v1 把整段 transcript 原样发给 fork 模型（可能超过 fork 自身
 *    窗口 → 永远失败 → 链式误降）。v2 按 fork.inputTokenLimit() 分块 map-reduce。
 * 3. pinned 假合并：v1 compactPinnedHistory 只拼接旧摘要（token 只增不减）。
 *    v2 当旧摘要总量超阈值时并入本次摘要一并再压缩，真正减少 token。
 * 4. 预压缩复用：precompress 阶段后台生成的摘要直接应用，请求路径零 fork。
 *
 * 输出被 forkMaxTokens 截断（stopReason='length'）时由 ForkRunner 判失败，
 * 半截摘要不会进入上下文。
 */

import { randomUUID } from 'node:crypto';
import type { ContextResource, Message } from '@aipack-ai/agent';
import type {
  CompressionStrategy, StrategyContext, StrategyResult, PrecomputedSummary,
} from '../strategy';
import { noopResult, formatResourceForTranscript, resourceText } from '../strategy';
import { buildToolPairMap, isToolPairComplete } from '../safety';
import type { CompressionTelemetry } from '../telemetry';
import { createTelemetry } from '../telemetry';
import type { ForkTextResult } from '../fork';

const MAP_PROMPT = `你是一个上下文压缩代理。
请将下面这段对话历史压缩为一份信息密度高、忠实于事实的摘要。
必须保留：用户意图、关键决策、工具名称及其结果、遇到的错误，
以及所有未解决的问题。保持简洁。仅输出摘要文本本身。`;

const FINAL_PROMPT = `你是一个上下文压缩代理。
请将对话历史压缩为一份简洁、结构化的摘要。
保留继续执行任务所需的全部关键信息。

输出格式：

## 上下文摘要
[核心用户意图与当前任务状态]

## 关键决策
- [决策 1]

## 工具结果
- [工具名称]：[关键结果/结论]

## 待办事项
- [待办 1]`;

const REDUCE_PROMPT = `${FINAL_PROMPT}

对话历史此前已被分段摘要。请将以下各段部分摘要合并为一份最终摘要（不得丢失信息）：`;

export class SummarizeStrategy implements CompressionStrategy {
  readonly name = 'summarize' as const;

  /**
   * 后台预压缩：按当前资源计算可压缩区域并 fork 摘要。
   * 不修改任何资源；失败返回 null。
   * transformer 在低预警线（precompressTokens）调用，结果存入 pending，
   * 高水位压缩时由 compress(ctx.precomputed) 直接应用，请求路径零 fork。
   */
  async precompute(ctx: StrategyContext): Promise<PrecomputedSummary | null> {
    const cfg = ctx.config.summarize;
    if (!cfg.enabled) return null;

    const compressible = this.identifyCompressible(ctx.resources, cfg.protectedRecentCount);
    if (compressible.length < cfg.minResourcesToCompress) return null;

    const transcript = compressible.map(r => formatResourceForTranscript(r)).join('\n\n');
    const out = await this.summarizeTranscript(ctx, transcript, false);
    if (!out.ok || !out.text) return null;

    return {
      sourceIds: compressible.map(r => r.id),
      text: out.text,
      forkDurationMs: out.durationMs,
      createdAtTurn: ctx.turn,
    };
  }

  async compress(ctx: StrategyContext): Promise<StrategyResult> {
    const cfg = ctx.config.summarize;
    if (!cfg.enabled) return noopResult(ctx.resources);

    const beforeTokens = ctx.meter.estimateAll(ctx.resources);

    // ── 1. 预压缩产物优先：region 仍完整则直接应用，请求路径零 fork ──
    if (ctx.precomputed) {
      const applied = this.applyPrecomputed(ctx, beforeTokens);
      if (applied) return applied;
    }

    // ── 2. 选择压缩区域 ──
    const compressible = this.identifyCompressible(ctx.resources, cfg.protectedRecentCount);
    if (compressible.length === 0) return noopResult(ctx.resources);

    // ── 3. pinned 历史摘要再摘要判定（修复假合并：真正再压缩，而非拼接） ──
    const oldSummaries = ctx.resources.filter(
      r => r.type === 'compaction_summary' && r.pinned
        && !compressible.some(c => c.id === r.id),
    );
    const oldSummaryTokens = ctx.meter.estimateAll(oldSummaries);
    const reSummarizePinned =
      oldSummaries.length > 0 &&
      oldSummaryTokens > ctx.budget.effective * cfg.pinnedReSummarizeRatio;

    const replaceTargets = [...compressible];
    if (reSummarizePinned) replaceTargets.push(...oldSummaries);

    if (!reSummarizePinned && compressible.length < cfg.minResourcesToCompress) {
      return noopResult(ctx.resources);
    }

    // ── 4. 构建 transcript（旧摘要置前，标注为历史摘要） ──
    const transcriptParts: string[] = [];
    if (reSummarizePinned) {
      transcriptParts.push(...oldSummaries.map(r => `[历史摘要] ${resourceText(r)}`));
    }
    transcriptParts.push(...compressible.map(r => formatResourceForTranscript(r)));
    const transcript = transcriptParts.join('\n\n');

    // ── 5. fork 摘要（超预算时 map-reduce 分块） ──
    const forkOut = await this.summarizeTranscript(ctx, transcript, reSummarizePinned);
    if (!forkOut.ok || !forkOut.text) {
      return {
        resources: ctx.resources,
        telemetry: [createTelemetry('summarize', 'summarize_history', beforeTokens, beforeTokens, {
          sessionKey: ctx.sessionKey,
          turn: ctx.turn,
          failed: true,
          message: `fork_failed:${forkOut.failureReason ?? 'unknown'}`,
          forkDurationMs: forkOut.durationMs,
          forkRetries: forkOut.retries,
          forkModelId: ctx.fork.resolveModel().id,
          forkTruncated: forkOut.truncated,
          prefixIntact: ctx.resources.length,
        })],
        prefixIntact: ctx.resources.length,
      };
    }

    // ── 6. 替换区域为单条摘要资源（content 存完整 Message 对象，round-trip 安全） ──
    const result = this.replaceRegion(ctx.resources, replaceTargets, forkOut.text);

    const afterTokens = ctx.meter.estimateAll(result.resources);
    const telemetry: CompressionTelemetry[] = [
      createTelemetry('summarize', 'summarize_history', beforeTokens, afterTokens, {
        sessionKey: ctx.sessionKey,
        turn: ctx.turn,
        resourcesAffected: replaceTargets.length,
        prefixIntact: result.prefixIntact,
        message: afterTokens <= ctx.budget.targetTokens
          ? undefined
          : `above_target:${Math.round(afterTokens - ctx.budget.targetTokens)}`,
        forkDurationMs: forkOut.durationMs,
        forkRetries: forkOut.retries,
        forkModelId: ctx.fork.resolveModel().id,
      }),
    ];
    return { resources: result.resources, telemetry, prefixIntact: result.prefixIntact };
  }

  // ─── 预压缩产物应用 ─────────────────────────────────────────────

  private applyPrecomputed(
    ctx: StrategyContext,
    beforeTokens: number,
  ): StrategyResult | null {
    const pre = ctx.precomputed!;
    // 有效性：sourceIds 全部仍在当前资源中
    const idSet = new Set(ctx.resources.map(r => r.id));
    if (!pre.sourceIds.every(id => idSet.has(id))) return null;

    const targets = ctx.resources.filter(r => pre.sourceIds.includes(r.id));
    if (targets.length !== pre.sourceIds.length) return null;

    const result = this.replaceRegion(ctx.resources, targets, pre.text);
    const afterTokens = ctx.meter.estimateAll(result.resources);

    return {
      resources: result.resources,
      telemetry: [createTelemetry('summarize', 'summarize_apply_precomputed', beforeTokens, afterTokens, {
        sessionKey: ctx.sessionKey,
        turn: ctx.turn,
        resourcesAffected: targets.length,
        prefixIntact: result.prefixIntact,
        forkDurationMs: pre.forkDurationMs,
        message: 'applied_background_precomputed_summary',
      })],
      prefixIntact: result.prefixIntact,
      consumedPrecomputed: true,
    };
  }

  // ─── 区域选择 ───────────────────────────────────────────────────

  /** 可压缩资源：非 pinned、不在保护区、类型可压、工具对完整 */
  private identifyCompressible(
    resources: ContextResource[],
    protectedRecentCount: number,
  ): ContextResource[] {
    // protectedRecentCount=0 语义为"不保护"，slice(-0) 会返回整个数组，需特判
    const recent = protectedRecentCount > 0
      ? resources.slice(-protectedRecentCount)
      : [];
    const recentIds = new Set(recent.map(r => r.id));
    const pairMap = buildToolPairMap(resources);

    return resources.filter(r => {
      if (r.pinned) return false;
      if (recentIds.has(r.id)) return false;
      if (r.type === 'compaction_summary') return false;
      if (r.type === 'system_message' || r.type === 'state_snapshot') return false;
      if (!isToolPairComplete(r, resources, pairMap)) return false;
      return true;
    });
  }

  // ─── transcript 摘要（单发或 map-reduce） ────────────────────────

  private async summarizeTranscript(
    ctx: StrategyContext,
    transcript: string,
    reSummarizePinned: boolean,
  ): Promise<ForkTextResult & { failureReason?: string }> {
    const cfg = ctx.config.summarize;
    const inputLimit = ctx.fork.inputTokenLimit();
    const chunkBudget = cfg.maxChunkTokens > 0
      ? Math.min(cfg.maxChunkTokens, inputLimit)
      : inputLimit;

    const transcriptTokens = ctx.meter.estimateText(transcript);

    // 单块放得下：一次 fork 出最终摘要
    if (transcriptTokens <= chunkBudget) {
      const systemPrompt = reSummarizePinned ? REDUCE_PROMPT : FINAL_PROMPT;
      return ctx.fork.runText(ctx.safety, {
        systemPrompt,
        userPrompt: `请对以下对话历史进行摘要：\n\n${transcript}`,
        sessionKey: ctx.sessionKey,
        turn: ctx.turn,
        label: 'summarize',
      });
    }

    // 超预算：按资源粒度分块 map-reduce。
    // 此处 transcript 由资源文本拼接而成，按字符近似还原资源边界分块。
    const chunks = this.splitTranscript(ctx, transcript, chunkBudget);
    if (chunks.length === 1) {
      // 单块仍超（单资源就超预算）：交给 fork 模型尽力而为（其自身会截断输入）
      return ctx.fork.runText(ctx.safety, {
        systemPrompt: FINAL_PROMPT,
        userPrompt: `请对以下对话历史进行摘要：\n\n${transcript}`,
        sessionKey: ctx.sessionKey,
        turn: ctx.turn,
        label: 'summarize',
      });
    }

    // map：每块一次 fork
    const partialSummaries: string[] = [];
    let totalDurationMs = 0;
    let totalRetries = 0;
    for (let i = 0; i < chunks.length; i++) {
      const out = await ctx.fork.runText(ctx.safety, {
        systemPrompt: MAP_PROMPT,
        userPrompt: `请对以下第 ${i + 1}/${chunks.length} 部分对话历史进行摘要：\n\n${chunks[i]}`,
        sessionKey: ctx.sessionKey,
        turn: ctx.turn,
        label: `summarize_map_${i}`,
      });
      if (!out.ok || !out.text) return out;
      partialSummaries.push(out.text);
      totalDurationMs += out.durationMs;
      totalRetries += out.retries;
    }

    // reduce：合并部分摘要为最终摘要
    const reduced = await ctx.fork.runText(ctx.safety, {
      systemPrompt: REDUCE_PROMPT,
      userPrompt: partialSummaries.map((s, i) => `## 第 ${i + 1} 部分\n${s}`).join('\n\n'),
      sessionKey: ctx.sessionKey,
      turn: ctx.turn,
      label: 'summarize_reduce',
    });
    if (!reduced.ok || !reduced.text) return reduced;

    return {
      ...reduced,
      durationMs: reduced.durationMs + totalDurationMs,
      retries: reduced.retries + totalRetries,
    };
  }

  /** 按字符预算把 transcript 切成多块（块间无资源边界信息，字符级即可） */
  private splitTranscript(ctx: StrategyContext, transcript: string, chunkBudget: number): string[] {
    // 换算字符预算：token 预算 × 平均字符/token（用估算器实测校准）
    const totalTokens = ctx.meter.estimateText(transcript);
    if (totalTokens <= 0) return [transcript];
    const charsPerToken = transcript.length / totalTokens;
    const chunkChars = Math.max(200, Math.floor(chunkBudget * charsPerToken));

    const chunks: string[] = [];
    let pos = 0;
    while (pos < transcript.length) {
      let end = Math.min(transcript.length, pos + chunkChars);
      // 尽量在换行处断块
      if (end < transcript.length) {
        const nl = transcript.lastIndexOf('\n', end);
        if (nl > pos + chunkChars * 0.5) end = nl;
      }
      chunks.push(transcript.slice(pos, end));
      pos = end;
    }
    return chunks;
  }

  // ─── 区域替换 ───────────────────────────────────────────────────

  /**
   * 把 targets 覆盖的区间替换为单条 compaction_summary 资源：
   * - content 存完整 Message 对象 { role: 'compactionSummary', content: text }
   *   （agent 包 round-trip 契约：resourceToMessage default 分支原样取出）
   * - 区间内未入选的资源（system_message 等不可压项）原样保留
   * - 摘要插入在区间起点，KV cache 前缀保持到该点
   */
  private replaceRegion(
    resources: ContextResource[],
    targets: ContextResource[],
    summaryText: string,
  ): { resources: ContextResource[]; prefixIntact: number } {
    const targetIds = new Set(targets.map(r => r.id));

    let firstIdx = -1;
    let lastIdx = -1;
    for (let i = 0; i < resources.length; i++) {
      if (targetIds.has(resources[i].id)) {
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      }
    }
    if (firstIdx === -1) return { resources, prefixIntact: resources.length };

    const now = Date.now();
    // round-trip 契约：content 必须是完整 Message 对象
    const summaryMessage = {
      role: 'compactionSummary',
      content: summaryText,
      timestamp: now,
    } as unknown as Message;

    const summaryResource: ContextResource = {
      id: `compaction_${randomUUID()}`,
      type: 'compaction_summary',
      role: 'compactionSummary',
      content: summaryMessage,
      timestamp: now,
      dependencies: [],
      meta: {
        _stage: 'summarize',
        _sourceIds: [...targetIds],
        _sourceCount: targets.length,
      },
      pinned: true,
    };

    const before = resources.slice(0, firstIdx);
    const middle = resources
      .slice(firstIdx, lastIdx + 1)
      .filter(r => !targetIds.has(r.id));
    const after = resources.slice(lastIdx + 1);

    return {
      resources: [...before, summaryResource, ...middle, ...after],
      prefixIntact: firstIdx,
    };
  }
}
