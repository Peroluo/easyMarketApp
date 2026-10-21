/**
 * packages/core/types.ts - 核心类型定义
 *
 * 这是整个框架的类型基础，不依赖任何外部实现。
 * 所有消息、内容块、模型、工具等类型都在此定义。
 */

// ─── 内容块类型 ───────────────────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string;       // base64 或 URL
  mimeType: string;
}

export interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: unknown;
}

export interface ThinkingContent {
  type: 'thinking';
  text: string;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ToolCallContent
  | ThinkingContent;

// ─── 消息类型 ─────────────────────────────────────────────────────

export interface BaseMessage {
  role: string;
  content: string | ContentBlock[];
  timestamp: number;
  [key: string]: unknown;
}

export interface UserMessage extends BaseMessage {
  role: 'user';
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  model?: string;
  provider?: string;
  stopReason?: string;
  usage?: Usage;
  errorMessage?: string;
  responseId?: string;
}

export interface ToolResultMessage extends BaseMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  isError: boolean;
}

export interface SystemMessage extends BaseMessage {
  role: 'system';
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage | SystemMessage;

// ─── Token 用量 ───────────────────────────────────────────────────

/**
 * 用量与费用。与 aipack/ai 的 Usage 结构对齐：
 * cacheRead/cacheWrite/reasoning 为可选字段，旧消费者无需感知。
 */
export interface Usage {
  input: number;
  output: number;
  total: number;
  /** 命中缓存读取的 token 数（不计入 input） */
  cacheRead?: number;
  /** 写入缓存的 token 数 */
  cacheWrite?: number;
  /** 推理 token 数（completion 的子集） */
  reasoning?: number;
  /** 还原后的原始 token 总数（input + output + cacheRead + cacheWrite） */
  totalTokens?: number;
}

// ─── 模型定义 ─────────────────────────────────────────────────────

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  [key: string]: unknown;
}

// ─── 工具定义 ─────────────────────────────────────────────────────

export interface ToolResult {
  content: ContentBlock[];
  details: unknown;
  usage?: Usage;
}

export interface Tool {
  name: string;
  description: string;
  parameters: unknown;  // JSON Schema 或 TypeBox schema
  /**
   * 所需权限能力声明（如 'shell:exec' / 'fs:write' / 'memory:write' / 'network:fetch'）。
   * 供框架级 PermissionPolicy 裁决使用；未声明视为安全工具。
   */
  permissions?: string[];
  execute: (
    toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  prepareArguments?: (args: unknown) => unknown;
}

// ─── 上下文 ───────────────────────────────────────────────────────

export interface Context {
  systemPrompt: string;
  messages: Message[];
  tools?: Tool[];
}

// ─── 流式事件 ─────────────────────────────────────────────────────

export interface StreamOptions {
  signal?: AbortSignal;
  reasoning?: string;
  sessionId?: string;
  /** 重试回调：provider 内 retry() 真正退避重试时调用（可观测/埋点用） */
  onRetryAttempt?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

export type StreamEvent =
  | { type: 'start'; partial: { content: ContentBlock[] } }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; delta: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'done'; message: AssistantMessage }
  | { type: 'error'; message: AssistantMessage };

export type StreamResult = AsyncIterable<StreamEvent>;

/**
 * 流式函数类型 - 模型提供者需实现此接口
 *
 * 是一个可替换的核心能力。
 * 用户通过提供不同的 streamFn 来接入不同的 LLM 提供商。
 */
export type StreamFn = (
  model: Model,
  context: Context,
  options?: StreamOptions,
) => StreamResult;

// ─── Agent 状态 ───────────────────────────────────────────────────

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max';

export interface AgentState {
  systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  tools: Tool[];
  messages: Message[];
  isStreaming: boolean;
  streamingMessage?: Message;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
}

// ─── 工具函数 ─────────────────────────────────────────────────────

export function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((c): c is TextContent => c.type === 'text')
    .map(c => c.text)
    .join('');
}

export function extractToolCalls(content: string | ContentBlock[]): ToolCallContent[] {
  if (typeof content === 'string') return [];
  return content.filter((c): c is ToolCallContent => c.type === 'toolCall');
}

export function createTextContent(text: string): TextContent {
  return { type: 'text', text };
}

export function createEmptyUsage(): Usage {
  return { input: 0, output: 0, total: 0 };
}
