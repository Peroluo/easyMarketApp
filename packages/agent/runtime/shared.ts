/**
 * runtime 共享基础层：纯函数、常量与内部数据结构。
 *
 * 无类状态，供 runtime 各子模块（session-store / persistence /
 * tool-executor / compactor / model-turn / loops / index）复用。
 */

import type {
  Compilation,
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  ContentBlock,
  ImageContent,
  Request,
  Result,
  ResultChunk,
  ToolResult,
  StreamEvent,
} from '../core';
import {
  extractText,
  createTextContent,
  createEmptyUsage,
  ResultBuilder,
} from '../core';
import { messagesToResources } from '../context-resource';
import { isAgentError } from '../ai';
import { randomUUID } from 'node:crypto';

// ─── traceId / spanId 生成（零新依赖）────────────────────────────

export function newTraceId(): string {
  return `${Date.now().toString(36)}-${randomUUID()}`;
}

export function newSpanId(): string {
  return randomUUID();
}

/** 从流错误消息的 "[category]" 前缀解析错误分类（formatCategoryError 产出） */
export function errorClassFromMessage(message: string): string | undefined {
  const m = message.match(/^\[([^\]]+)\]/);
  return m ? m[1] : undefined;
}

/** 工具结果状态分类：error(执行失败) / ok(正常)。blocked/skipped 不进入 onToolCall */
export function toolResultStatus(result: ToolResult): 'ok' | 'error' | 'blocked' | 'skipped' {
  if (result.details && typeof result.details === 'object' && 'error' in result.details) {
    return 'error';
  }
  const d = result.details as { blocked?: boolean; skipped?: boolean } | undefined;
  if (d?.blocked) return 'blocked';
  if (d?.skipped) return 'skipped';
  return 'ok';
}

/** 从重试错误对象提取 HTTP 状态码（AgentError 或 fetch Response） */
export function statusOfRetryError(error: unknown): number | undefined {
  if (isAgentError(error)) return error.status;
  const s = (error as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

// ─── 会话状态 ─────────────────────────────────────────────────────

export interface SessionState {
  messages: Message[];
  isStreaming: boolean;
  abortController: AbortController | null;
  createdAt: string;   // 会话首次创建时间，持久化时保留
  /** 用户命名（setSessionTitle 设置；hydrate 恢复，persist 写回） */
  title?: string;
  hydrated: boolean;   // 是否已从存储恢复（串行化后无竞态）
  /** 串行队列：同一会话的 run/stream 依次执行，避免消息数组交错与 abort 覆盖 */
  queue: Promise<void>;
  /** 等待空闲的 resolver，isStreaming 变 false 时逐个唤醒 */
  idleResolvers: Array<() => void>;
  /** 是否持有执行锁（acquire 后 → release 前）。LRU 淘汰时保护刚入队未开始运行的会话 */
  lockHeld: boolean;
}

/** 内存会话状态表 LRU 上限（仅清理内存态，不删存储；超限淘汰最久未用） */
export const DEFAULT_MAX_SESSIONS = 256;

export function createSessionState(): SessionState {
  return {
    messages: [],
    isStreaming: false,
    abortController: null,
    createdAt: new Date().toISOString(),
    hydrated: false,
    queue: Promise.resolve(),
    idleResolvers: [],
    lockHeld: false,
  };
}

// ─── 工具超时信号（Node 18 无 AbortSignal.any，手动桥接）─────────

export function withTimeoutSignal(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Tool execution timeout after ${ms}ms`)),
    ms,
  );
  // 保存监听器引用，clear 时移除，避免 parent 长生命周期时未触发的 abort
  // 监听器累积（{ once: true } 仅在触发后清理，不触发则常驻 parent 上）。
  let onAbort: (() => void) | undefined;
  if (parent) {
    if (parent.aborted) {
      controller.abort(parent.reason);
    } else {
      onAbort = () => controller.abort(parent.reason);
      parent.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      if (onAbort && parent) {
        parent.removeEventListener('abort', onAbort);
        onAbort = undefined;
      }
    },
  };
}

// ─── 媒体附件 → ImageContent ──────────────────────────────────────

export function buildImageContent(media: string): ImageContent {
  const dataMatch = media.match(/^data:([^;]+);base64,(.*)$/s);
  if (dataMatch) {
    return { type: 'image', mimeType: dataMatch[1], data: dataMatch[2] };
  }
  // 非 data URI 视为 URL（ImageContent.data 字段同时接受 base64 与 URL）
  return { type: 'image', mimeType: 'image/url', data: media };
}

/** 请求 → user 消息（含媒体附件展开为 image block） */
export function buildUserMessage(request: Request): UserMessage {
  if (request.media && request.media.length > 0) {
    const blocks: ContentBlock[] = [
      createTextContent(request.message),
      ...request.media.filter(Boolean).map(buildImageContent),
    ];
    return {
      role: 'user',
      content: blocks,
      timestamp: Date.now(),
    };
  }
  return {
    role: 'user',
    content: request.message,
    timestamp: Date.now(),
  };
}

// ─── token 估算（单一实现见 core/tokens.ts，此处 re-export 保持模块内消费）──

export { estimateTextTokens, estimateMessageTokens } from '../core';

// ─── 内置摘要压缩：常量与纯函数 ───────────────────────────────────

/** 单回合内溢出恢复重试上限（截断后仍溢出最多再试 2 次，防止死循环） */
export const OVERFLOW_RECOVERY_LIMIT = 2;

/**
 * 摘要请求输入预算：占 contextWindow 的比例。
 * 被压缩段序列化后超过该预算时不再发起摘要请求（请求本身必然超窗），
 * 直接降级硬截断，避免 doomed 调用。
 */
export const COMPACTION_SUMMARY_BUDGET_RATIO = 0.6;

/** 摘要请求单条消息的序列化字符上限（防单条巨型 toolResult 撑爆摘要请求） */
export const COMPACTION_LINE_CLAMP = 4000;

/** 默认摘要指令 */
export const DEFAULT_COMPACTION_PROMPT = [
  '你是对话历史压缩器。请将以下对话历史压缩为一份信息密度高的摘要，供后续对话作为上下文参考。',
  '要求：',
  '1. 保留关键事实、决策、结论与未完成事项；',
  '2. 保留用户明确的偏好与约束；',
  '3. 保留重要工具调用的目的与结果要点（细节可省略）；',
  '4. 丢弃寒暄、重复与无关细节；',
  '5. 直接输出摘要正文，不要任何前后缀说明。',
].join('\n');

/** compactionSummary 消息发给 provider 时转换后的 user 消息前缀 */
export const COMPACTION_USER_PREFIX = '[以下为此前对话历史的压缩摘要，作为上下文参考]';

/** stateSnapshot 消息发给 provider 时转换后的 user 消息前缀 */
export const STATE_SNAPSHOT_USER_PREFIX = '[以下为当前状态快照，作为上下文参考]';

/** 序列化单条消息为摘要输入行；system 等无关角色返回空串 */
export function messageToSummaryLine(msg: Message): string {
  const clamp = (text: string): string =>
    text.length > COMPACTION_LINE_CLAMP
      ? `${text.slice(0, COMPACTION_LINE_CLAMP)}…(已截断)`
      : text;

  switch (msg.role) {
    case 'user': {
      const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
      return `[用户] ${clamp(text)}`;
    }
    case 'assistant': {
      const parts: string[] = [];
      const content = msg.content;
      if (typeof content === 'string') {
        parts.push(content);
      } else {
        for (const block of content) {
          if (block.type === 'text') parts.push(block.text);
          else if (block.type === 'toolCall') {
            parts.push(`调用工具 ${block.name}(${JSON.stringify(block.arguments)})`);
          }
        }
      }
      return `[助手] ${clamp(parts.join('；'))}`;
    }
    case 'toolResult': {
      const m = msg as ToolResultMessage;
      const text = typeof m.content === 'string' ? m.content : extractText(m.content);
      return `[工具结果 ${m.toolName}] ${clamp(text)}`;
    }
    default: {
      // Message union 之外的扩展 role（compactionSummary / stateSnapshot 等）
      const role = (msg as { role: string }).role;
      // 已有的旧摘要/状态快照融入新摘要，避免反复压缩丢失早期信息
      if (role === 'compactionSummary' || role === 'stateSnapshot') {
        const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
        return `[${role === 'compactionSummary' ? '历史摘要' : '状态快照'}] ${clamp(text)}`;
      }
      return '';
    }
  }
}

// ─── 工具执行结果（含 terminate 信号） ─────────────────────────────

/**
 * 单次/一组工具执行的产出。除结果列表外，携带 terminate 信号：
 * beforeToolCall / afterToolCall 可请求终止整个 run，
 * runLoop 检测到后停止循环（本轮工具结果仍写入会话以保持配对完整）。
 */
export interface ToolExecutionOutcome {
  results: ToolResult[];
  /** 是否请求终止整个 run */
  terminate: boolean;
  /** 终止原因（写入 Result.metadata.terminateReason） */
  terminateReason?: string;
}

/** 单个工具执行的产出（含 terminate 信号） */
export interface SingleToolOutcome {
  result: ToolResult;
  terminate: boolean;
  terminateReason?: string;
}

// ─── Result 构建 ──────────────────────────────────────────────────

/** 从 Compilation 组装最终 Result（纯函数） */
export function buildResult(compilation: Compilation): Result {
  const messages = compilation.messages;
  let content = '';
  let stopReason = 'completed';
  let error: string | undefined;
  const toolsUsed: string[] = [];
  const usage: Record<string, number> = {};

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const assistant = msg as AssistantMessage;
      content = extractText(assistant.content);
      stopReason = assistant.stopReason ?? 'completed';
      error = assistant.errorMessage;
      if (assistant.usage) {
        usage.input = (usage.input ?? 0) + assistant.usage.input;
        usage.output = (usage.output ?? 0) + assistant.usage.output;
        usage.total = (usage.total ?? 0) + assistant.usage.total;
        if (assistant.usage.cacheRead) usage.cacheRead = (usage.cacheRead ?? 0) + assistant.usage.cacheRead;
        if (assistant.usage.cacheWrite) usage.cacheWrite = (usage.cacheWrite ?? 0) + assistant.usage.cacheWrite;
      }
    }
    if (msg.role === 'toolResult') {
      const toolMsg = msg as ToolResultMessage;
      if (!toolsUsed.includes(toolMsg.toolName)) {
        toolsUsed.push(toolMsg.toolName);
      }
    }
  }

  // 填充资源快照（此前 Result.resources 永远 undefined）
  const resources = messagesToResources(messages);

  const builder = new ResultBuilder()
    .content(content)
    .toolsUsed(toolsUsed)
    .usage(usage)
    .stopReason(stopReason)
    .error(error)
    .resources(resources)
    .metadata('traceId', compilation.traceId);

  // beforeToolCall/afterToolCall 请求终止：覆盖 stopReason 并记录原因
  if (compilation.terminateReason) {
    builder.stopReason('terminated').metadata('terminateReason', compilation.terminateReason);
  }

  // 回合上限耗尽：调用方据此区分"正常完成"与"被截断"（模型仍想调用工具）
  if (compilation.maxTurnsExhausted) {
    builder.stopReason('max_turns').metadata('maxTurns', true);
  }

  return builder.build();
}

// ─── 流事件 → ResultChunk 映射 ────────────────────────────────────

export function streamEventToChunk(event: StreamEvent): ResultChunk | null {
  switch (event.type) {
    case 'text_delta':
      return { type: 'text', content: event.delta };
    case 'thinking_delta':
      return { type: 'thinking', content: event.delta };
    case 'error':
      // 模型调用错误（无 API Key / 鉴权失败 / 网络错误 / HTTP 4xx-5xx 等）
      // 以 error 事件流入，errorMessage 已由 stream-openai/anthropic 填好。
      return {
        type: 'error',
        content: event.message.errorMessage || '模型调用出错',
      };
    default:
      return null;
  }
}
