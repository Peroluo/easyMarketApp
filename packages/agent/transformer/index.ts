/**
 * packages/transformer - 上下文转换器
 *
 * 独立实现的 ContextTransformer，不依赖 src/。
 * 提供工具配对修复、状态快照注入、消息截断等内置转换器。
 * 用户可通过 BaseTransformer 实现自定义转换器（如上下文压缩）。
 */

import { BaseTransformer } from '../core';
import type { ContextResource, TransformContext } from '../core';
import type { Message, ToolCallContent, ContentBlock } from '../core';
import { extractToolCalls, estimateTextTokens } from '../core';
import { messagesToResources, resourcesToMessages } from '../context-resource';

// ─── token 估算（单一实现见 core/tokens.ts：约 4 字符/token） ──────

/** 估算单个资源的 token 数（序列化内容后计数） */
function estimateResourceTokens(resource: ContextResource): number {
  const content = resource.content;
  if (typeof content === 'string') return estimateTextTokens(content);
  try {
    return estimateTextTokens(JSON.stringify(content ?? ''));
  } catch {
    return 0;
  }
}

// ─── 工具配对转换器 ───────────────────────────────────────────────

/**
 * 确保上下文中 tool_call 与 tool_result 的配对完整性。
 * 移除孤立的工具调用或工具结果消息。
 *
 * 建议放在 transformers 数组最后（兜底修复）。
 * 必须晚于 TruncationTransformer：截断会丢弃旧资源，可能打破配对
 * （例如丢掉 toolCall 但保留 toolResult，或反之），需要本转换器作为
 * 最终兜底重新修复，否则破坏后的消息序列会导致下一次模型调用 400。
 */
export class ToolPairingTransformer extends BaseTransformer {
  readonly name = 'tool-pairing';

  protected async run(
    resources: ContextResource[],
    _context: TransformContext,
  ): Promise<ContextResource[]> {
    const messages = resourcesToMessages(resources);
    const paired = ensureToolPairing(messages);
    return messagesToResources(paired);
  }
}

/**
 * 确保 tool_call 与 tool_result 配对完整
 */
export function ensureToolPairing(messages: Message[]): Message[] {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  // 收集所有 tool_call ID
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const tc of extractToolCalls(content)) {
          toolCallIds.add(tc.id);
        }
      }
    }
    if (msg.role === 'toolResult') {
      toolResultIds.add((msg as any).toolCallId);
    }
  }

  // 找出孤立的 tool_call（无对应 result）和孤立的 tool_result（无对应 call）
  const orphanedCalls = new Set<string>();
  const orphanedResults = new Set<string>();

  for (const id of toolCallIds) {
    if (!toolResultIds.has(id)) orphanedCalls.add(id);
  }
  for (const id of toolResultIds) {
    if (!toolCallIds.has(id)) orphanedResults.add(id);
  }

  if (orphanedCalls.size === 0 && orphanedResults.size === 0) {
    return messages;
  }

  // 过滤消息
  const result: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const content = msg.content;
      if (Array.isArray(content)) {
        // 移除孤立的 tool_call
        const filteredContent = content.filter(block => {
          if (block.type === 'toolCall') {
            return !orphanedCalls.has((block as ToolCallContent).id);
          }
          return true;
        });
        // 如果所有内容都被移除，跳过这条消息
        if (filteredContent.length === 0 && content.length > 0) continue;
        result.push({ ...msg, content: filteredContent });
      } else {
        result.push(msg);
      }
    } else if (msg.role === 'toolResult') {
      // 移除孤立的 tool_result
      if (!orphanedResults.has((msg as any).toolCallId)) {
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  return result;
}

// ─── 状态快照注入转换器 ───────────────────────────────────────────

/**
 * 在上下文开头注入状态快照。
 */
export class StateSnapshotTransformer extends BaseTransformer {
  readonly name = 'state-snapshot';

  constructor(private getStateSnapshot: () => string | null) {
    super();
  }

  protected async run(
    resources: ContextResource[],
    _context: TransformContext,
  ): Promise<ContextResource[]> {
    const snapshot = this.getStateSnapshot();
    if (!snapshot) return resources;

    const snapshotResource: ContextResource = {
      id: `snapshot_${Date.now()}`,
      type: 'state_snapshot',
      role: 'system',
      content: snapshot,
      timestamp: Date.now(),
      dependencies: [],
      meta: { injected: true },
      pinned: true,
    };

    return [snapshotResource, ...resources];
  }
}

// ─── 消息截断转换器 ───────────────────────────────────────────────

/**
 * 当资源总数超过限制时，移除最旧的非关键资源。
 *
 * 截断按"配对组"丢弃：丢弃一个带 toolCall 的 assistant 资源时，会一并丢弃
 * 对应的 toolResult 资源，避免留下孤立结果（孤立结果虽会被 ToolPairingTransformer
 * 兜底清理，但会浪费保留预算）。
 */
export class TruncationTransformer extends BaseTransformer {
  readonly name = 'truncation';

  constructor(private maxResources: number = 200) {
    super();
  }

  protected async run(
    resources: ContextResource[],
    _context: TransformContext,
  ): Promise<ContextResource[]> {
    if (resources.length <= this.maxResources) return resources;

    const pinned = resources.filter(r => r.pinned);
    const unpinned = resources.filter(r => !r.pinned);
    const keepCount = this.maxResources - pinned.length;

    if (keepCount <= 0) return pinned;

    // 保留最新的 keepCount 个，但需按"配对组"整体丢弃头部。
    // 从尾部回溯收集要保留的资源，遇到 assistant(toolCall) 时把对应的
    // toolResult 也纳入保留集合（即便它位于 keepCount 边界之外）。
    const keep = new Set<number>();
    const toolCallIdsInRange = new Set<string>();

    for (let i = unpinned.length - 1; i >= 0 && keep.size < keepCount; i--) {
      const res = unpinned[i];
      keep.add(i);
      if (res.type === 'assistant_message') {
        for (const dep of res.dependencies) toolCallIdsInRange.add(dep);
      }
      if (res.type === 'tool_result') {
        const tcId = (res.meta as { toolCallId?: string } | undefined)?.toolCallId;
        if (tcId) toolCallIdsInRange.add(tcId);
      }
    }

    // 二次扫描：把与已保留 toolCall 配对的 toolResult（或反之）一并保留，
    // 防止截断打破配对。
    for (let i = 0; i < unpinned.length; i++) {
      if (keep.has(i)) continue;
      const res = unpinned[i];
      if (res.type === 'tool_result') {
        const tcId = (res.meta as { toolCallId?: string } | undefined)?.toolCallId;
        if (tcId && toolCallIdsInRange.has(tcId)) keep.add(i);
      }
    }

    const kept = unpinned.filter((_, i) => keep.has(i));
    return [...pinned, ...kept].sort((a, b) => a.timestamp - b.timestamp);
  }
}

// ─── Token 预算截断转换器 ─────────────────────────────────────────

/**
 * 按模型 contextWindow 的 token 预算截断上下文。
 *
 * 条数截断（TruncationTransformer）无法防止 token 溢出：200 条消息可能远超
 * 模型上下文窗口。本转换器按 token 估算从最旧的非关键
 * 资源开始丢弃，直到总 token 低于预算（默认 contextWindow * 0.8，预留输出空间）。
 */
export class TokenBudgetTransformer extends BaseTransformer {
  readonly name = 'token-budget';

  constructor(private ratio: number = 0.8) {
    super();
  }

  protected async run(
    resources: ContextResource[],
    context: TransformContext,
  ): Promise<ContextResource[]> {
    const contextWindow = context.runtime.contextWindow;
    if (!contextWindow || contextWindow <= 0) return resources;

    const ratio = context.runtime.contextBudgetRatio ?? this.ratio ?? 0.8;
    const budget = Math.floor(contextWindow * ratio);

    const pinned = resources.filter(r => r.pinned);
    const unpinned = resources.filter(r => !r.pinned); // 按时间顺序：旧在前

    let total = pinned.reduce((sum, r) => sum + estimateResourceTokens(r), 0)
      + unpinned.reduce((sum, r) => sum + estimateResourceTokens(r), 0);
    if (total <= budget) return resources;

    // 从头部（最旧）开始丢弃，直到总 token <= 预算。
    // 配对组感知：丢弃 assistant(toolCall) 时记录其 toolCallId，
    // 后续对应的 toolResult 也一并丢弃。
    const droppedToolCallIds = new Set<string>();
    let i = 0;
    while (i < unpinned.length && total > budget) {
      const res = unpinned[i];
      total -= estimateResourceTokens(res);
      if (res.type === 'assistant_message') {
        for (const dep of res.dependencies) droppedToolCallIds.add(dep);
      }
      i++;
    }

    // 保留未丢弃部分，并移除与已丢弃 toolCall 配对的 toolResult
    const kept = unpinned.slice(i).filter(res => {
      if (res.type === 'tool_result') {
        const tcId = (res.meta as { toolCallId?: string } | undefined)?.toolCallId;
        if (tcId && droppedToolCallIds.has(tcId)) return false;
      }
      return true;
    });

    return [...pinned, ...kept].sort((a, b) => a.timestamp - b.timestamp);
  }
}

// ─── 系统消息清理转换器 ───────────────────────────────────────────

/**
 * 移除重复的系统消息，只保留最后一条。
 */
export class SystemMessageCleanerTransformer extends BaseTransformer {
  readonly name = 'system-message-cleaner';

  protected async run(
    resources: ContextResource[],
    _context: TransformContext,
  ): Promise<ContextResource[]> {
    const systemMessages = resources.filter(r => r.type === 'system_message');
    if (systemMessages.length <= 1) return resources;

    // 保留最后一条系统消息
    const lastSystem = systemMessages[systemMessages.length - 1];
    return resources.filter(r => r.type !== 'system_message' || r === lastSystem);
  }
}

// ─── 转换器工厂 ───────────────────────────────────────────────────

export function createDefaultTransformers(options?: {
  getStateSnapshot?: () => string | null;
  maxResources?: number;
  contextBudgetRatio?: number;
}): import('../core').ContextTransformer[] {
  const transformers: import('../core').ContextTransformer[] = [
    new SystemMessageCleanerTransformer(),
    new TruncationTransformer(options?.maxResources ?? 200),
    new TokenBudgetTransformer(options?.contextBudgetRatio ?? 0.8),
    new ToolPairingTransformer(),  // 放在最后，兜底修复配对
  ];

  if (options?.getStateSnapshot) {
    transformers.push(new StateSnapshotTransformer(options.getStateSnapshot));
  }

  return transformers;
}
