/**
 * TruncateStrategy - 硬截断保底策略
 *
 * 从最旧开始丢弃非 pinned 资源直到压到硬上限以下：
 *   - 工具对（发起方 + tool_result）作为整体丢弃，绝不产生悬空 tool_call
 *   - protected 最近 minWorkingSet 条非 pinned 资源不丢
 *   - pinned（system_message / compaction_summary 等）永不丢
 *
 * 取代 v1 的 L5 硬截断：truncate 是确定性的、无 fork 依赖的兜底，
 * 压不下去（pinned/保护区本身超限）时由 transformer 发出 lifecycle 耗尽事件。
 */

import type { ContextResource } from '@aipack-ai/agent';
import type { CompressionStrategy, StrategyContext, StrategyResult } from '../strategy';
import { noopResult } from '../strategy';
import { createTelemetry } from '../telemetry';

export class TruncateStrategy implements CompressionStrategy {
  readonly name = 'truncate' as const;

  async compress(ctx: StrategyContext): Promise<StrategyResult> {
    const cfg = ctx.config.truncate;
    if (!cfg.enabled) return noopResult(ctx.resources);

    const hardLimit = ctx.budget.hardLimitTokens;
    const beforeTokens = ctx.meter.estimateAll(ctx.resources);
    if (beforeTokens <= hardLimit) return noopResult(ctx.resources);

    // 受保护边界：最近 minWorkingSet 条非 pinned 资源不丢
    const protectedIdx = new Set<number>();
    let protectedCount = 0;
    for (let i = ctx.resources.length - 1; i >= 0 && protectedCount < cfg.minWorkingSet; i--) {
      if (!ctx.resources[i].pinned) {
        protectedIdx.add(i);
        protectedCount++;
      }
    }

    // 工具对分组：toolCallId → 成员下标集合
    // （assistant_message 的 deps 即 toolCallId，可同时属于多个对）
    const pairMembers = new Map<string, Set<number>>();
    const addToPair = (callId: string | undefined, idx: number) => {
      if (!callId) return;
      if (!pairMembers.has(callId)) pairMembers.set(callId, new Set());
      pairMembers.get(callId)!.add(idx);
    };

    for (let i = 0; i < ctx.resources.length; i++) {
      const r = ctx.resources[i];
      if (r.type === 'tool_result') {
        addToPair((r.meta?.toolCallId as string | undefined) ?? r.dependencies[0], i);
      } else if (r.type === 'tool_call') {
        addToPair((r.meta?.toolCallId as string | undefined) ?? r.id, i);
      } else if (r.type === 'assistant_message') {
        for (const dep of r.dependencies) addToPair(dep, i);
      }
    }

    // 不动点求解"不可丢集合"：pinned/保护 → 直接不可丢；
    // 对内任一成员不可丢 → 整对不可丢（迭代至收敛，无递归死循环）。
    // 一个 assistant_message 可属多个对，链条式阻塞由迭代自然传播。
    const blocked = new Set<number>();
    for (let i = 0; i < ctx.resources.length; i++) {
      const r = ctx.resources[i];
      if (r.pinned || protectedIdx.has(i)) blocked.add(i);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const members of pairMembers.values()) {
        if (!membersHasBlocked(members, blocked)) continue;
        for (const m of members) {
          if (!blocked.has(m)) {
            blocked.add(m);
            changed = true;
          }
        }
      }
    }

    const droppableIdx: number[] = [];
    for (let i = 0; i < ctx.resources.length; i++) {
      if (!blocked.has(i)) droppableIdx.push(i);
    }

    if (droppableIdx.length === 0) {
      return {
        resources: ctx.resources,
        telemetry: [createTelemetry('truncate', 'truncate_oldest', beforeTokens, beforeTokens, {
          sessionKey: ctx.sessionKey,
          turn: ctx.turn,
          failed: true,
          message: 'nothing_droppable_pinned_or_protected_overload',
          prefixIntact: ctx.resources.length,
        })],
        prefixIntact: ctx.resources.length,
      };
    }

    // 从最旧开始丢，直到压到硬限以下
    let tokens = beforeTokens;
    const droppedSet = new Set<number>();
    for (const idx of droppableIdx) {
      if (tokens <= hardLimit) break;
      tokens -= ctx.meter.estimate(ctx.resources[idx]);
      droppedSet.add(idx);
    }

    if (droppedSet.size === 0) return noopResult(ctx.resources);

    const result: ContextResource[] = [];
    for (let i = 0; i < ctx.resources.length; i++) {
      if (!droppedSet.has(i)) result.push(ctx.resources[i]);
    }

    // prefixIntact = 首个被丢资源的下标（之前的资源未动）
    let prefixIntact = ctx.resources.length;
    for (let i = 0; i < ctx.resources.length; i++) {
      if (droppedSet.has(i)) { prefixIntact = i; break; }
    }

    const afterTokens = ctx.meter.estimateAll(result);
    return {
      resources: result,
      telemetry: [createTelemetry('truncate', 'truncate_oldest', beforeTokens, afterTokens, {
        sessionKey: ctx.sessionKey,
        turn: ctx.turn,
        resourcesAffected: droppedSet.size,
        prefixIntact,
        message: afterTokens > hardLimit
          ? `still_over_hard_limit:${Math.round(afterTokens - hardLimit)}`
          : undefined,
      })],
      prefixIntact,
    };
  }
}

function membersHasBlocked(members: Set<number>, blocked: Set<number>): boolean {
  for (const m of members) {
    if (blocked.has(m)) return true;
  }
  return false;
}
