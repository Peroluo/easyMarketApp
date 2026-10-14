/**
 * 会话生命周期 - 上下文耗尽事件
 *
 * v1 的问题：L4（检查点）/L5（交接）作为"压缩级别"混在管道里，
 * 压缩器试图通过 hook 指挥 runtime 切会话；hook 可选且无人强制执行，
 * handoffCompleted=true 后该 session 永久失去压缩保护。
 *
 * v2 的所有权划分：
 *   - 压缩器只负责"尽力压缩 + 如实报告"，压不下去时发出 ContextExhaustedEvent
 *   - 检查点/换会话是 host 的职责：会话本来就持续持久化在 host 的
 *     SessionStorage 里，事件携带交接文档和建议的新会话 id，host 自行决策
 *   - 压缩器自身不再有"永久禁用"状态
 */

import { randomUUID } from 'node:crypto';
import type { ContextResource } from '@aipack-ai/agent';
import type { ForkRunner } from './fork';
import type { CompressionSafetyState } from './safety';
import type { CompressionConfig } from './config';
import { resourceText } from './strategy';
import type { CompressionTelemetry } from './telemetry';
import { createTelemetry } from './telemetry';

// ─── 事件 ─────────────────────────────────────────────────────────

/** 耗尽原因 */
export type ExhaustedReason =
  | 'pinned_overload'      // pinned 资源本身超限（truncate 无可丢）
  | 'protected_overload';  // 保护窗口本身超限

export interface ContextExhaustedEvent {
  sessionKey: string;
  turn: number;
  reason: ExhaustedReason;
  /** 压缩后仍超出的 token 估算值 */
  tokensAfter: number;
  hardLimitTokens: number;
  /** 尽力生成的交接文档（fork 失败/关闭时为确定性 fallback） */
  handoffDocument: string;
  /** handoffDocument 是否为 fallback（fork 未成功） */
  fallback: boolean;
  /** 建议的新会话 id（host 决定是否采用） */
  suggestedSessionId: string;
  timestamp: number;
}

export type ContextExhaustedHandler = (event: ContextExhaustedEvent) => void | Promise<void>;

// ─── 交接文档生成 ─────────────────────────────────────────────────

const HANDOFF_PROMPT = `You are a session handoff agent.
A previous agent session has exhausted its context window after compression attempts.
Generate a concise handoff document that allows a fresh session to continue the task seamlessly.

The handoff document MUST include:
1. **Original Task**: What the user originally asked for
2. **What Was Done**: Summary of completed work and key results
3. **Current State**: Where the task currently stands
4. **What Remains**: Specific next steps to complete the task
5. **Critical Context**: Constraints, decisions, or facts that must be preserved

Be concise but complete. The new session will have NO other context besides this document.`;

/**
 * 生成交接文档（fork 优先，失败则确定性 fallback）。
 * 返回 telemetry 一并上报。
 */
export async function generateHandoffDocument(opts: {
  config: CompressionConfig;
  fork: ForkRunner;
  safety: CompressionSafetyState;
  resources: ContextResource[];
  sessionKey: string;
  turn: number;
  reason: ExhaustedReason;
  tokensAfter: number;
  hardLimitTokens: number;
}): Promise<{ event: ContextExhaustedEvent; telemetry: CompressionTelemetry[] }> {
  const {
    config, fork, safety, resources, sessionKey, turn, reason, tokensAfter, hardLimitTokens,
  } = opts;

  const contextText = collectContext(resources);
  let doc: string | null = null;
  let fallback = false;
  let forkTelemetry: Partial<CompressionTelemetry> = {};

  if (config.lifecycle.enabled) {
    const out = await fork.runText(safety, {
      systemPrompt: HANDOFF_PROMPT,
      userPrompt: `Generate a handoff document for:\n\n${contextText}`,
      sessionKey,
      turn,
      label: 'lifecycle_handoff',
    });
    if (out.ok && out.text) {
      doc = out.text;
      forkTelemetry = {
        forkDurationMs: out.durationMs,
        forkRetries: out.retries,
        forkModelId: fork.resolveModel().id,
      };
    } else {
      fallback = true;
      forkTelemetry = {
        forkDurationMs: out.durationMs,
        forkRetries: out.retries,
        forkModelId: fork.resolveModel().id,
        forkTruncated: out.truncated,
      };
    }
  } else {
    fallback = true;
  }

  if (!doc) doc = fallbackHandoff(resources);

  const now = Date.now();
  const event: ContextExhaustedEvent = {
    sessionKey,
    turn,
    reason,
    tokensAfter,
    hardLimitTokens,
    handoffDocument: doc,
    fallback,
    suggestedSessionId: `${sessionKey}_h${now}_${randomUUID().slice(0, 8)}`,
    timestamp: now,
  };

  const telemetry: CompressionTelemetry[] = [
    createTelemetry('lifecycle', 'context_exhausted', tokensAfter, tokensAfter, {
      sessionKey,
      turn,
      triggerReason: reason,
      failed: fallback,
      message: fallback ? 'used_fallback_handoff_doc' : undefined,
      prefixIntact: 0,
      ...forkTelemetry,
    }),
  ];
  return { event, telemetry };
}

/** 汇集交接素材：历史摘要 + 最近消息 */
function collectContext(resources: ContextResource[]): string {
  const parts: string[] = [];

  const summaries = resources.filter(r => r.type === 'compaction_summary');
  if (summaries.length > 0) {
    parts.push(`## Previous Summaries\n${summaries.map(r => resourceText(r)).join('\n\n')}`);
  }

  const recent = resources.slice(-6);
  if (recent.length > 0) {
    parts.push(`## Recent Context\n${recent.map(r => `[${r.type}] ${resourceText(r)}`).join('\n\n')}`);
  }

  return parts.join('\n\n---\n\n');
}

/** 确定性 fallback 交接文档（fork 不可用时保底） */
function fallbackHandoff(resources: ContextResource[]): string {
  const firstUser = resources.find(r => r.type === 'user_message');
  const lastUser = [...resources].reverse().find(r => r.type === 'user_message');
  const summaries = resources.filter(r => r.type === 'compaction_summary');

  const lines = [
    '## Session Handoff (fallback)',
    '',
    `Original request: ${firstUser ? resourceText(firstUser).slice(0, 500) : 'Unknown'}`,
    '',
  ];
  if (summaries.length > 0) {
    lines.push('Previous summaries:');
    for (const s of summaries) {
      lines.push(`- ${resourceText(s).slice(0, 400)}`);
    }
    lines.push('');
  }
  if (lastUser && lastUser !== firstUser) {
    lines.push(`Latest user message: ${resourceText(lastUser).slice(0, 500)}`, '');
  }
  lines.push('Please continue from where the previous session left off.');
  return lines.join('\n');
}
