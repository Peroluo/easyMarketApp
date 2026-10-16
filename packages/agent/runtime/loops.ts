/**
 * 对话循环（从 AgentRuntime 拆出）：
 * - _run / _stream：钩子编排、会话恢复、结果构建、错误路径、最终持久化
 * - runLoop / runLoopStream：多回合循环（转换 → 压缩检查 → 模型 → 工具执行 → 实时落盘）
 * - terminate 信号与 maxTurns 耗尽标记传播
 */

import type {
  Compilation,
  Model,
  Request,
  Result,
  ResultChunk,
  RuntimeHooks,
  UserMessage,
} from '../core';
import { ResultBuilder } from '../core';
import type { ToolCallContent } from '../core';
import { extractToolCalls } from '../core';
import type { SessionState, ToolExecutionOutcome } from './shared';
import type { SessionStore } from './session-store';
import type { SessionPersistence } from './session-persistence';
import type { RuntimeTelemetry } from './telemetry';
import type { ToolExecutor } from './tool-executor';
import type { ContextCompactor } from './compactor';
import type { ModelTurnRunner } from './model-turn';

export interface RunLoopDeps {
  hooks: RuntimeHooks;
  telemetry: RuntimeTelemetry;
  store: SessionStore;
  persistence: SessionPersistence;
  tools: ToolExecutor;
  compactor: ContextCompactor;
  modelTurn: ModelTurnRunner;
  getModel: () => Model;
  getMaxTurns: () => number;
  resolveSessionKey: (request: Request) => string;
  /** run/stream 进入会话时回调（同步 ExtensionContext.sessionKey 为真实会话键） */
  onSessionActivated: (sessionKey: string) => void;
  createCompilation: (
    request: Request,
    sessionKey?: string,
    session?: SessionState,
    traceId?: string,
  ) => Compilation;
  buildUserMessage: (request: Request) => UserMessage;
  buildResult: (compilation: Compilation) => Result;
  transformMessages: (compilation: Compilation, sessionKey: string) => Promise<void>;
}

export class RunLoops {
  constructor(private readonly _d: RunLoopDeps) {}

  async run(
    request: Request,
    sessionKey: string,
    session: SessionState,
    traceId: string,
    queuedMs: number,
  ): Promise<Result> {
    const activeStartedAt = Date.now();
    // 同步共享扩展上下文的会话键为本次真实会话（修复：此前恒为创建时刻的 'default'）
    this._d.onSessionActivated(sessionKey);

    // 1. 触发 beforeInitialize / afterInitialize
    await this._d.hooks.beforeInitialize.promise(request);
    await this._d.hooks.afterInitialize.promise(request);

    // 2. beforeRun（waterfall，可修改请求）
    const finalRequest = await this._d.hooks.beforeRun.promise(request);

    // 3. 会话持久化：从存储恢复历史消息（ephemeral 跳过）
    if (!finalRequest.ephemeral) {
      await this._d.persistence.hydrate(sessionKey, session);
    }

    // 4. 创建编译上下文
    const compilation = this._d.createCompilation(finalRequest, sessionKey, session, traceId);

    // 5. 添加用户消息（含媒体附件）
    compilation.messages.push(this._d.buildUserMessage(finalRequest));

    // 6. 运行对话循环
    try {
      await this.runLoop(compilation, finalRequest, session);

      // 7. 构建结果
      const result = this._d.buildResult(compilation);

      // 8. 触发 beforeEmit / afterEmit
      await this._d.hooks.beforeEmit.promise(result);
      await this._d.hooks.afterEmit.promise(result);

      // 9. 触发 done（携带最终 Request，供钩子按会话配对）
      await this._d.hooks.done.promise(result, finalRequest);

      compilation.completed = true;
      await this.emitRunEnd(finalRequest, sessionKey, compilation, result, queuedMs, activeStartedAt);
      return result;
    } catch (err) {
      const error = err as Error;
      // 非 Error 抛出物（字符串/普通对象）归一化：error.message 可能为 undefined
      const message = error?.message ?? String(err);
      // 非中止错误打印栈，便于线上排障（此前 catch 全部静默转 Result.error，丢栈）
      if (error?.name !== 'AbortError') {
        console.error('[Runtime] 运行失败:', error?.stack ?? message);
      }
      await this._d.hooks.failed.promise(error, finalRequest);

      const result = new ResultBuilder()
        .error(message)
        .build();
      await this.emitRunEnd(finalRequest, sessionKey, compilation, result, queuedMs, activeStartedAt);
      return result;
    } finally {
      // 10. 结束前最终保存会话（ephemeral 不持久化；失败不影响运行结果）
      await this._d.persistence.persistSafe(finalRequest, sessionKey);
    }
  }

  async *stream(
    request: Request,
    sessionKey: string,
    session: SessionState,
    traceId: string,
    queuedMs: number,
  ): AsyncGenerator<ResultChunk> {
    const activeStartedAt = Date.now();
    // 同步共享扩展上下文的会话键为本次真实会话（修复：此前恒为创建时刻的 'default'）
    this._d.onSessionActivated(sessionKey);

    // 1. 钩子
    await this._d.hooks.beforeInitialize.promise(request);
    await this._d.hooks.afterInitialize.promise(request);
    const finalRequest = await this._d.hooks.beforeRun.promise(request);

    // 2. 会话持久化：从存储恢复历史消息（ephemeral 跳过）
    if (!finalRequest.ephemeral) {
      await this._d.persistence.hydrate(sessionKey, session);
    }

    // 3. 创建编译上下文
    const compilation = this._d.createCompilation(finalRequest, sessionKey, session, traceId);

    // 4. 添加用户消息（含媒体附件）
    compilation.messages.push(this._d.buildUserMessage(finalRequest));

    // 5. 流式对话循环
    try {
      for await (const chunk of this.runLoopStream(compilation, finalRequest, session)) {
        yield chunk;
      }

      // 6. 构建并触发结果钩子
      const result = this._d.buildResult(compilation);
      await this._d.hooks.beforeEmit.promise(result);
      await this._d.hooks.afterEmit.promise(result);
      await this._d.hooks.done.promise(result, finalRequest);

      yield { type: 'done', result };
      await this.emitRunEnd(finalRequest, sessionKey, compilation, result, queuedMs, activeStartedAt);
    } catch (err) {
      const error = err as Error;
      // 非 Error 抛出物（字符串/普通对象）归一化：error.message 可能为 undefined
      const message = error?.message ?? String(err);
      if (error?.name !== 'AbortError') {
        console.error('[Runtime] 流式运行失败:', error?.stack ?? message);
      }
      await this._d.hooks.failed.promise(error, finalRequest);
      const result = new ResultBuilder().error(message).build();
      yield { type: 'error', content: message };
      yield { type: 'done', result };
      await this.emitRunEnd(finalRequest, sessionKey, compilation, result, queuedMs, activeStartedAt);
    } finally {
      await this._d.persistence.persistSafe(finalRequest, sessionKey);
    }
  }

  // ─── 对话循环（同步） ───────────────────────────────────────────

  private async runLoop(
    compilation: Compilation,
    request: Request,
    session: SessionState,
  ): Promise<void> {
    session.isStreaming = true;
    session.abortController = new AbortController();
    // 多会话路由：本次循环所属会话（请求携带的 sessionKey 优先）
    const sessionKey = this._d.resolveSessionKey(request);

    try {
      let maxTurns = this._d.getMaxTurns();
      let turnCount = 0; // step 长度：实际对话轮数（与 maxTurns 上限解耦）

      while (maxTurns-- > 0) {
        turnCount += 1;

        // 1. 链式转换上下文（原地替换，保持 session 引用）
        await this._d.transformMessages(compilation, sessionKey);

        // 1.5 阈值触发内置摘要压缩（估算 token 超窗口比例时，先摘要后截断兜底）
        await this._d.compactor.maybeCompactByThreshold(
          compilation, sessionKey, session.abortController!.signal,
        );

        // 2. 调用模型（streamModel 内部走统一埋点 streamModelEvents，
        //    含溢出自动恢复：检测 → 截断历史 → 同回合重试）
        const assistantMessage = await this._d.modelTurn.streamModel(
          compilation,
          session.abortController!.signal,
          sessionKey,
        );

        compilation.messages.push(assistantMessage);
        // 3.1 实时持久化：assistant 回复完成即落盘（运行中可查看最新会话）
        await this._d.persistence.persistSafe(request, sessionKey);

        // 4. 检查工具调用
        const toolCalls = extractToolCalls(assistantMessage.content);

        if (toolCalls.length === 0) {
          break;  // 无工具调用，结束循环
        }

        // 5. 执行工具（可选并行）
        const outcome = await this.executeToolCalls(
          compilation,
          toolCalls,
          session.abortController!.signal,
        );
        // 5.1 实时持久化：工具结果落盘
        await this._d.persistence.persistSafe(request, sessionKey);
        // 5.2 beforeToolCall/afterToolCall 请求终止：停止循环
        if (outcome.terminate) {
          compilation.terminateReason = outcome.terminateReason ?? 'terminated';
          break;
        }
      }

      // 回合上限耗尽（循环条件失效而非 break 退出，maxTurns 已减至 -1）：
      // 模型仍请求工具调用但被截断，标记供 buildResult 输出 'max_turns'
      if (maxTurns < 0) compilation.maxTurnsExhausted = true;
      compilation.turnCount = turnCount;
    } finally {
      this._d.store.markIdle(session);
    }
  }

  // ─── 对话循环（流式） ───────────────────────────────────────────

  private async *runLoopStream(
    compilation: Compilation,
    request: Request,
    session: SessionState,
  ): AsyncGenerator<ResultChunk> {
    session.isStreaming = true;
    session.abortController = new AbortController();
    // 多会话路由：本次流式循环所属会话
    const sessionKey = this._d.resolveSessionKey(request);

    try {
      let maxTurns = this._d.getMaxTurns();
      let turnCount = 0; // step 长度：实际对话轮数（与 maxTurns 上限解耦）

      while (maxTurns-- > 0) {
        turnCount += 1;

        // 1. 链式转换上下文（原地替换，保持 session 引用）
        await this._d.transformMessages(compilation, sessionKey);

        // 1.5 阈值触发内置摘要压缩（估算 token 超窗口比例时，先摘要后截断兜底）
        await this._d.compactor.maybeCompactByThreshold(
          compilation, sessionKey, session.abortController!.signal,
        );

        // 2. 流式调用模型（统一埋点 + 溢出自动恢复：可恢复的溢出错误
        //    吞掉 error chunk，截断历史后同回合重试）
        const turn = this._d.modelTurn.modelTurnWithRecovery(
          compilation,
          session.abortController!.signal,
          sessionKey,
          true, // stream 模式：同时统计首 token 延迟
        );
        let turnResult = await turn.next();
        while (!turnResult.done) {
          yield turnResult.value;
          turnResult = await turn.next();
        }
        const assistantMessage = turnResult.value;

        if (!assistantMessage) break;
        compilation.messages.push(assistantMessage);
        // 3.1 实时持久化：assistant 回复完成即落盘（运行中可查看最新会话）
        await this._d.persistence.persistSafe(request, sessionKey);

        // 4. 检查工具调用
        const toolCalls = extractToolCalls(assistantMessage.content);

        if (toolCalls.length === 0) {
          break;
        }

        // 5. 执行工具
        for (const toolCall of toolCalls) {
          yield {
            type: 'tool_start',
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            args: toolCall.arguments,
          };
        }

        const outcome = await this.executeToolCalls(
          compilation,
          toolCalls,
          session.abortController!.signal,
        );
        // 5.1 实时持久化：工具结果落盘
        await this._d.persistence.persistSafe(request, sessionKey);

        // 5.2 yield tool_end（block 的工具也产出事件，便于前端展示被拒调用）
        for (let i = 0; i < toolCalls.length; i++) {
          yield {
            type: 'tool_end',
            toolName: toolCalls[i].name,
            toolCallId: toolCalls[i].id,
            isError: this._d.tools.isErrorResult(outcome.results[i]),
          };
        }

        // 5.3 beforeToolCall/afterToolCall 请求终止：tool_end 之后再停止循环
        if (outcome.terminate) {
          compilation.terminateReason = outcome.terminateReason ?? 'terminated';
          break;
        }
      }

      // 回合上限耗尽（循环条件失效而非 break 退出，maxTurns 已减至 -1）：
      // 模型仍请求工具调用但被截断，标记供 buildResult 输出 'max_turns'
      if (maxTurns < 0) compilation.maxTurnsExhausted = true;
      compilation.turnCount = turnCount;
    } finally {
      this._d.store.markIdle(session);
    }
  }

  /** 同步循环：执行工具调用并将结果消息按原顺序追加 */
  private async executeToolCalls(
    compilation: Compilation,
    toolCalls: ToolCallContent[],
    signal: AbortSignal,
  ): Promise<ToolExecutionOutcome> {
    const outcome = await this._d.tools.run(
      toolCalls, signal, compilation.request, compilation.traceId,
    );
    for (let i = 0; i < toolCalls.length; i++) {
      compilation.messages.push(
        this._d.tools.buildResultMessage(toolCalls[i], outcome.results[i]),
      );
    }
    return outcome;
  }

  /** run 级完成事件上报（补充默认模型 id） */
  private async emitRunEnd(
    request: Request,
    sessionKey: string,
    compilation: Compilation,
    result: Result,
    queuedMs: number,
    activeStartedAt: number,
  ): Promise<void> {
    await this._d.telemetry.emitRunEnd(
      request, sessionKey, compilation, result, queuedMs, activeStartedAt,
      this._d.getModel().id,
    );
  }
}
