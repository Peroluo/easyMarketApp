import type {
  Model,
  Context,
  SimpleStreamOptions,
  StreamEvent,
  StreamResult,
  AssistantMessage,
  ContentBlock,
  TextContent,
  ToolCallContent,
  ThinkingContent,
  Usage,
  Message,
} from './types';
import { createEmptyUsage, createEmptyAssistantMessage } from './types';
import { retry, ok, isRetryableHttpStatus } from './retry';
import { resolveApiKey } from './credentials';
import {
  AgentErrorCategory,
  classifyError,
  formatCategoryError,
} from './errors';
import type { ProviderCompat } from './compat';
import { detectCompat } from './compat';
import { sanitizeSurrogates } from './sanitize-unicode';
import { getSyncPartialParser } from './json-parse';
import { extractDataLines } from './sse-parser';
import {
  createErrorEvent,
  buildRequestErrorEvent,
  buildResponseErrorEvent,
  createTimeoutReader,
  createStreamResult,
} from './stream-shared';

// ─── Context -> OpenAI 消息 ────────────────────────────────────────

interface OpenAIUserContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

/**
 * 预处理消息列表，修复可能导致 API 400 的问题：
 *
 * 1. 跳过 stopReason === "error" / "aborted" 的 assistant 消息
 *    （这类消息是失败的 API 响应记录，不应回放到后续请求中）
 * 2. 为孤立的 toolCall 插入合成 toolResult
 *    （当 user 消息插在 tool_calls 和 tool 响应之间时，满足 API 的配对要求）
 *
 * transformMessages 适配函数。
 */
function transformMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let pendingToolCalls: Array<{ id: string; name?: string }> = [];
  let existingToolResultIds = new Set<string>();

  const flushPendingToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    for (const tc of pendingToolCalls) {
      if (!existingToolResultIds.has(tc.id)) {
        result.push({
          role: 'toolResult',
          toolCallId: tc.id,
          toolName: tc.name ?? '',
          content: [{ type: 'text', text: '(tool result not available)' }],
          isError: true,
          timestamp: Date.now(),
        } as Message);
      }
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'assistant') {
      // 在处理新的 assistant 消息之前，先 flush 之前的孤立 tool call
      flushPendingToolCalls();

      // 跳过报错/中止的 assistant 消息
      const assistantMsg = msg as AssistantMessage;
      if (assistantMsg.stopReason === 'error' || assistantMsg.stopReason === 'aborted') {
        continue;
      }

      // 记录此 assistant 消息中的 tool calls
      const toolCalls = msg.content.filter(
        (b): b is ToolCallContent => b.type === 'toolCall',
      );
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls.map((tc) => ({ id: tc.id, name: tc.name }));
        existingToolResultIds = new Set();
      }

      result.push(msg);
    } else if (msg.role === 'toolResult') {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === 'user') {
      // user 消息会打断 tool call 流，为之前的孤立调用插入合成结果
      flushPendingToolCalls();
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  // 如果消息以未完成的 tool calls 结尾，合成结果
  flushPendingToolCalls();

  return result;
}

function toOpenAIMessages(context: Context, compat?: ProviderCompat): unknown[] {
  const messages: unknown[] = [];
  const { supportsDeveloperRole, requiresToolResultName, requiresAssistantAfterToolResult }
    = compat ?? { supportsDeveloperRole: false, requiresToolResultName: false, requiresAssistantAfterToolResult: false };

  if (context.systemPrompt) {
    const role = supportsDeveloperRole ? 'developer' : 'system';
    messages.push({ role, content: context.systemPrompt });
  }

  // 预处理：修复可能导致 API 400 的消息序列问题
  const transformed = transformMessages(context.messages);

  // requiresAssistantAfterToolResult: 某些 provider（如 DeepSeek）
  // 要求在 tool 消息之后（而非 tool_calls 之后立即）跟一个空的 assistant 消息
  // 作为桥接。如果立即在 tool_calls 之后插入会违反 OpenAI 协议
  // （tool_calls 后面必须紧跟 tool 消息）。
  let pendingAssistantAfterToolResult = false;
  const flushAssistantAfterToolResult = () => {
    if (pendingAssistantAfterToolResult) {
      messages.push({ role: 'assistant', content: null });
      pendingAssistantAfterToolResult = false;
    }
  };

  for (const msg of transformed) {
    if (msg.role === 'user') {
      // user 消息之前如果有待刷新的空 assistant，先刷新
      flushAssistantAfterToolResult();
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content });
      } else {
        const parts: OpenAIUserContentPart[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${block.mimeType};base64,${block.data}` },
            });
          }
        }
        messages.push({ role: 'user', content: parts });
      }
    } else if (msg.role === 'assistant') {
      const textParts: string[] = [];
      const toolCallParts: ToolCallContent[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'toolCall') {
          toolCallParts.push(block);
        }
      }

      // 跳过既没有内容也没有 tool_calls 的 assistant 消息
      // （例如中止了的响应、空的错误消息等）
      const hasText = textParts.some((t) => t.trim().length > 0);
      if (!hasText && toolCallParts.length === 0) {
        continue;
      }

      // 新的 assistant 消息到来前，刷新上一轮的 tool 桥接
      flushAssistantAfterToolResult();

      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: sanitizeSurrogates(textParts.join('')) || null,
      };
      if (toolCallParts.length > 0) {
        entry.tool_calls = toolCallParts.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      messages.push(entry);
    } else if (msg.role === 'toolResult') {
      // 先刷新上轮 tool 的桥接（如果有），再处理本轮的 tool result
      flushAssistantAfterToolResult();

      const text = msg.content
        .filter((b): b is TextContent => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      // requiresToolResultName: 某些 provider（如 DeepSeek）要求在 tool result 中带 name
      const entry: Record<string, unknown> = {
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: text,
      };
      if (requiresToolResultName && msg.toolName) {
        entry.name = msg.toolName;
      }
      messages.push(entry);

      // 当前消息是 tool result，标记本轮 tool 响应结束后需要空 assistant 桥接
      if (requiresAssistantAfterToolResult) {
        pendingAssistantAfterToolResult = true;
      }
    }
  }

  // 如果消息以 tool result 结尾，确保末尾有空 assistant 桥接
  flushAssistantAfterToolResult();

  return messages;
}

function toOpenAITools(context: Context, supportsStrictMode = true): unknown[] | undefined {
  if (!context.tools || context.tools.length === 0) return undefined;
  return context.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(supportsStrictMode ? { strict: false } : {}),
    },
  }));
}

// ─── 用量统计 ──────────────────────────────────────────────────────

function buildUsage(raw: any): Usage {
  const usage = createEmptyUsage();

  const promptTokens = raw?.prompt_tokens ?? 0;
  const cacheReadTokens = raw?.prompt_tokens_details?.cached_tokens
    ?? raw?.prompt_cache_hit_tokens
    ?? 0;
  const cacheWriteTokens = raw?.prompt_tokens_details?.cache_write_tokens ?? 0;

  // input = prompt_tokens - cacheRead - cacheWrite（跟随 OpenAI/OpenRouter 语义）
  usage.input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  usage.output = raw?.completion_tokens ?? 0;
  usage.cacheRead = cacheReadTokens;
  usage.cacheWrite = cacheWriteTokens;
  usage.reasoning = raw?.completion_tokens_details?.reasoning_tokens ?? 0;

  // total 与 totalTokens：runtime 的 sumUsage/buildResult 累加 u.total，
  // 此前此处仅设置 totalTokens 导致 OpenAI 路径 token 统计恒为 0。
  usage.total = usage.input + usage.output + cacheReadTokens + cacheWriteTokens;
  usage.totalTokens = usage.total;

  return usage;
}

// ─── 结束原因映射 ───────────────────────────────────────────────────

function mapFinishReason(reason: string | undefined | null): string {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'toolUse';
    case 'content_filter':
      return 'error';
    default:
      return reason ?? 'stop';
  }
}

// ─── 工具调用累加器 ─────────────────────────────────────────────────

interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  argsRaw: string;
  contentIndex: number;
  started: boolean;
}

// ─── 主流式运行器 ───────────────────────────────────────────────────

async function* runStream(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
): AsyncGenerator<StreamEvent> {
  const compat = detectCompat(model);

  const apiKey = await resolveApiKey(model, options);
  if (!apiKey) {
    yield createErrorEvent(model, formatCategoryError(
      AgentErrorCategory.AUTH,
      `No API key found for provider "${model.provider}" (looked for ${model.provider.toUpperCase()}_API_KEY)`,
    ));
    return;
  }

  const baseUrl = (model.baseUrl || '').replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const messages = toOpenAIMessages(context, compat);
  const tools = toOpenAITools(context, compat.supportsStrictMode);

  // ── 构建请求 body（根据兼容性配置）────────────────────────────────
  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    [compat.maxTokensField]: options.maxTokens ?? model.maxTokens,
  };
  if (tools) body.tools = tools;
  if (options.temperature !== undefined) body.temperature = options.temperature;

  // Thinking/Reasoning 根据 provider 格式
  if (model.reasoning && options.reasoning) {
    const effortMap = model.thinkingLevelMap;
    const effort = effortMap ? effortMap[options.reasoning] : options.reasoning;
    if (effort) {
      switch (compat.thinkingFormat) {
        case 'deepseek':
          body.thinking = { type: 'enabled' };
          body.reasoning_effort = effort;
          break;
        case 'zai':
          body.thinking = { type: 'enabled', clear_thinking: false };
          break;
        case 'qwen':
          body.enable_thinking = true;
          break;
        case 'qwen-chat-template':
          body.chat_template_kwargs = { enable_thinking: true };
          break;
        case 'openrouter':
          body.reasoning = { effort };
          break;
        case 'ant-ling':
          body.reasoning = { effort };
          break;
        case 'together':
          body.reasoning = { enabled: true };
          break;
        case 'chat-template':
          body.chat_template_kwargs = {};
          break;
        case 'openai':
          body.reasoning_effort = effort;
          break;
        default:
          // 默认尝试 reasoning_effort
          if (compat.supportsReasoningEffort) {
            body.reasoning_effort = effort;
          }
          break;
      }
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...(model.headers ?? {}),
    ...(options.headers ?? {}),
  };

  // Session affinity headers（OpenRouter 等）
  if (compat.sendSessionAffinityHeaders && options.sessionId) {
    headers['x-session-id'] = options.sessionId;
  }

  options.onPayload?.(body);

  // ── 带重试的 HTTP 请求 ──────────────────────────────────────────
  let response: Response;
  try {
    response = await retry(async (attempt) => {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });
      if (!res.ok && isRetryableHttpStatus(res.status)) {
        throw res;
      }
      return ok(res);
    }, { onRetryAttempt: options.onRetryAttempt });
  } catch (e: any) {
    // abort / HTTP（含被 retry 抛出的 Response）/ 网络错误统一归一化
    yield await buildRequestErrorEvent(model, e, options.signal);
    return;
  }

  options.onResponse?.(response);

  if (!response.ok) {
    yield await buildResponseErrorEvent(model, response);
    return;
  }

  if (!response.body) {
    yield createErrorEvent(model, 'Response has no body');
    return;
  }

  // 正在构建中的部分助手消息。
  const partial: AssistantMessage = createEmptyAssistantMessage();
  partial.model = model.id;
  partial.provider = model.provider;
  const content: ContentBlock[] = partial.content;

  yield { type: 'start', partial };

  const parser = await getSyncPartialParser();

  // 流式状态
  let currentTextIndex: number | null = null;
  let currentThinkingIndex: number | null = null;
  const toolCalls = new Map<number, ToolCallAccumulator>();
  const toolCallOrder: number[] = [];
  let finishReason: string | undefined;
  let responseId: string | undefined;
  let finalUsage: Usage = createEmptyUsage();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamDone = false;

  // 空闲超时：两次数据块之间超过 idleTimeoutMs 视为断流，避免半开连接永久挂起。
  // 总超时（timeoutMs）：整个流式响应从开始到结束的硬时限，与 idle 互补，
  // 防止"持续有数据但整体超长"的挂起。取两者中更早到期者（见 stream-shared）。
  const readChunk = createTimeoutReader(
    reader,
    options.idleTimeoutMs ?? 60_000,
    options.timeoutMs ?? 0,
  );

  const closeText = function* (): Generator<StreamEvent> {
    if (currentTextIndex !== null) {
      const block = content[currentTextIndex] as TextContent;
      yield {
        type: 'text_end',
        content: block.text,
        contentIndex: currentTextIndex,
      };
      currentTextIndex = null;
    }
  };

  const closeThinking = function* (): Generator<StreamEvent> {
    if (currentThinkingIndex !== null) {
      const block = content[currentThinkingIndex] as ThinkingContent;
      yield {
        type: 'thinking_end',
        content: block.thinking,
        contentIndex: currentThinkingIndex,
      };
      currentThinkingIndex = null;
    }
  };

  try {
    while (!streamDone) {
      const { done, value } = await readChunk();
      if (done) {
        streamDone = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const { lines, rest } = extractDataLines(buffer);
      buffer = rest;

      for (const dataLine of lines) {
        if (dataLine === '[DONE]') {
          streamDone = true;
          break;
        }
        if (!dataLine) continue;

        let chunk: any;
        try {
          chunk = JSON.parse(dataLine);
        } catch {
          continue;
        }

        if (chunk.id && !responseId) responseId = chunk.id;
        if (chunk.usage) {
          finalUsage = buildUsage(chunk.usage);
        }

        const choices = chunk.choices;
        const choice = Array.isArray(choices) && choices.length > 0 ? choices[0] : null;
        if (!choice) continue;

        const delta = choice.delta ?? {};
        const reason = choice.finish_reason;

        // reasoning_content（例如 DeepSeek）-> 思维事件
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          yield* closeText();
          if (currentThinkingIndex === null) {
            currentThinkingIndex = content.length;
            content.push({ type: 'thinking', thinking: '' });
            yield {
              type: 'thinking_start',
              contentIndex: currentThinkingIndex,
            };
          }
          (content[currentThinkingIndex] as ThinkingContent).thinking += delta.reasoning_content;
          yield {
            type: 'thinking_delta',
            delta: delta.reasoning_content,
            contentIndex: currentThinkingIndex,
          };
        }

        // tool_calls（工具调用）
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          yield* closeText();
          yield* closeThinking();
          for (const tc of delta.tool_calls) {
            const idx: number = tc.index ?? 0;
            let acc = toolCalls.get(idx);
            if (!acc) {
              acc = {
                index: idx,
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                argsRaw: '',
                contentIndex: content.length,
                started: false,
              };
              toolCalls.set(idx, acc);
              toolCallOrder.push(idx);
              // 在 content 中预留一个槽位
              content.push({
                type: 'toolCall',
                id: acc.id,
                name: acc.name,
                arguments: {},
              } as ToolCallContent);
            }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            const argsFragment = tc.function?.arguments ?? '';
            if (argsFragment) {
              acc.argsRaw += argsFragment;
            }
            // 更新已预留的 content 块
            const block = content[acc.contentIndex] as ToolCallContent;
            block.id = acc.id;
            block.name = acc.name;
            if (acc.argsRaw) {
              try {
                block.arguments = (parser(acc.argsRaw) as Record<string, unknown>) ?? {};
              } catch {
                // keep previous arguments
              }
            }
            if (!acc.started) {
              acc.started = true;
              yield {
                type: 'toolcall_start',
                contentIndex: acc.contentIndex,
              };
            }
            if (argsFragment) {
              yield {
                type: 'toolcall_delta',
                delta: argsFragment,
                partial,
                contentIndex: acc.contentIndex,
              };
            }
          }
        }

        // content（文本）
        if (typeof delta.content === 'string' && delta.content) {
          yield* closeThinking();
          if (currentTextIndex === null) {
            currentTextIndex = content.length;
            content.push({ type: 'text', text: '' });
            yield {
              type: 'text_start',
              contentIndex: currentTextIndex,
            };
          }
          (content[currentTextIndex] as TextContent).text += delta.content;
          yield {
            type: 'text_delta',
            delta: delta.content,
            contentIndex: currentTextIndex,
          };
        }

        if (reason) {
          finishReason = reason;
        }
      }
    }
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || options.signal?.aborted;
    yield* closeText();
    yield* closeThinking();
    // 最终确定工具调用
    for (const idx of toolCallOrder) {
      const acc = toolCalls.get(idx)!;
      const block = content[acc.contentIndex] as ToolCallContent;
      try {
        block.arguments = (parser(acc.argsRaw) as Record<string, unknown>) ?? {};
      } catch {
        // keep partial
      }
      yield {
        type: 'toolcall_end',
        toolCall: block,
        contentIndex: acc.contentIndex,
      };
    }
    partial.stopReason = aborted ? 'aborted' : 'error';
    partial.errorMessage = aborted
      ? 'Stream aborted'
      : formatCategoryError(classifyError(e), String(e?.message ?? e));
    partial.usage = finalUsage;
    partial.responseId = responseId;
    yield {
      type: 'error',
      reason: aborted ? 'aborted' : 'error',
      error: partial,
    };
    return;
  } finally {
    // 释放 reader：消费者中途 break 时 async generator 会进入 finally，
    // 确保底层 HTTP 连接被释放而非悬挂（配合 idle 超时兜底半开连接）。
    try {
      await reader.cancel();
    } catch {
      /* 已关闭，忽略 */
    }
    try {
      reader.releaseLock();
    } catch {
      /* 已释放，忽略 */
    }
  }

  // 流式正常结束：关闭所有打开的块。
  yield* closeText();
  yield* closeThinking();

  for (const idx of toolCallOrder) {
    const acc = toolCalls.get(idx)!;
    const block = content[acc.contentIndex] as ToolCallContent;
    try {
      block.arguments = (parser(acc.argsRaw) as Record<string, unknown>) ?? {};
    } catch {
      // keep partial
    }
    yield {
      type: 'toolcall_end',
      toolCall: block,
      contentIndex: acc.contentIndex,
    };
  }

  partial.stopReason = mapFinishReason(finishReason);
  partial.usage = finalUsage;
  partial.responseId = responseId;

  yield {
    type: 'done',
    reason: partial.stopReason,
    message: partial,
  };
}

// ─── 公开 API ──────────────────────────────────────────────────────

export function streamOpenAI(
  model: Model,
  context: Context,
  options: SimpleStreamOptions = {},
): StreamResult {
  return createStreamResult(() => runStream(model, context, options));
}
