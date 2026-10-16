/**
 * packages/runtime - 运行时核心实现（编排层）
 *
 * AgentRuntime 组合各职责模块，仅保留：
 * - 配置与资源管理（模型/工具/扩展/转换器）
 * - run/stream 入口（校验 → 遥测 → 串行化 → 存储锁 → 对话循环）
 * - 公共便捷方法（abort/isBusy/waitForIdle/clearSession/deleteSession/compact）
 *
 * 职责模块（同目录）：
 * - shared.ts             纯函数、常量、SessionState、Result 构建
 * - session-store.ts      多会话状态表（LRU / 串行锁 / waitForIdle）
 * - session-persistence.ts 会话持久化（hydrate / persist / 存储锁）
 * - telemetry.ts          遥测发射器（emit / onRunEnd / runErrorClass）
 * - tool-executor.ts      工具执行（权限裁决 / 审批挂起 / 钩子）
 * - compactor.ts          上下文压缩（摘要 / 截断 / 溢出恢复）
 * - model-turn.ts         模型回合（埋点 / 溢出重试 / Context 构建）
 * - loops.ts              对话循环（runLoop / runLoopStream / _run / _stream）
 */

import type {
  Runtime,
  Compilation,
  RuntimeOptions,
  CompactionOptions,
  Request,
  Result,
  ResultChunk,
  Extension,
  RuntimeHooks,
  ExtensionContext,
  ContextTransformer,
  TransformContext,
  PermissionPolicy,
  ApprovalManager,
} from '../core';
import {
  ExtensionManager,
  ResultBuilder,
  createTaskGraph,
} from '../core';
import { setTapErrorHandler } from '../core/tapable';
import type {
  Model,
  Tool,
  StreamFn,
  Message,
  ThinkingLevel,
} from '../core';
import type { SessionStorage } from '../core';
import type { Telemetry } from '../telemetry';
import { validateRequest, normalizeRequest } from '../request';
import {
  messagesToResources,
  resourcesToMessages,
} from '../context-resource';
import {
  buildUserMessage,
  buildResult,
  type SessionState,
} from './shared';
import { SessionStore } from './session-store';
import { SessionPersistence } from './session-persistence';
import { RuntimeTelemetry } from './telemetry';
import { ToolExecutor } from './tool-executor';
import { ContextCompactor } from './compactor';
import { ModelTurnRunner } from './model-turn';
import { RunLoops } from './loops';

export class AgentRuntime implements Runtime {
  private _config: Record<string, unknown>;
  private _extensions: ExtensionManager;
  private _hooks: RuntimeHooks;
  /** 上下文转换器列表，按数组顺序链式执行（上一个输出作为下一个输入） */
  private _transformers: ContextTransformer[];

  private _model: Model;
  private _streamFn: StreamFn;
  private _systemPrompt: string;
  private _thinkingLevel: ThinkingLevel;
  private _globalTools: Map<string, Tool> = new Map();

  /** 默认会话 key（常量 'default'；请求未指定 sessionKey 时路由到此会话） */
  private _sessionKey: string;
  private _sessionStorage: SessionStorage | undefined;
  /** Extension 应用时的上下文（shared Map 供 ToolCallContext 引用） */
  private _extensionContext?: ExtensionContext;

  private _maxTurns: number;
  private _toolTimeoutMs: number;
  private _parallelToolCalls: boolean;
  private _contextBudgetRatio: number;
  /** 内置摘要压缩配置（未配置 = 保持旧行为，仅硬截断兜底） */
  private _compaction: CompactionOptions | undefined;
  private _telemetry: Telemetry | undefined;
  /** 框架级工具权限策略（未配置 → 默认 fail-closed，见 permissionFailOpen） */
  private _permissionPolicy: PermissionPolicy | undefined;
  /** 未配置策略时是否显式放行工具执行（默认 false = 拒绝，安全姿态） */
  private _permissionFailOpen: boolean;
  /** 审批管理器（pending 决策挂起等待外部批准；未配置 → pending 视为 deny） */
  private _approvals: ApprovalManager | undefined;
  /** 审批等待超时（毫秒） */
  private _approvalTimeoutMs: number;
  /** traceId 生成器（测试可注入确定性 id） */
  private readonly _traceIdGenerator: (() => string) | undefined;
  private readonly _sandbox: import('../core').SandboxOptions | undefined;

  // ─── 协作模块（构造时组装，职责见文件头注释） ───────────────────

  private readonly _store: SessionStore;
  private readonly _persistence: SessionPersistence;
  private readonly _emitter: RuntimeTelemetry;
  private readonly _tools: ToolExecutor;
  private readonly _compactor: ContextCompactor;
  private readonly _modelTurn: ModelTurnRunner;
  private readonly _loops: RunLoops;

  private constructor(options: RuntimeOptions) {
    this._config = options.config ?? {};
    this._extensions = new ExtensionManager();
    this._hooks = this._extensions.getHooks();
    // 转换器按传入顺序链式执行（上一个输出作为下一个输入）
    this._transformers = [...(options.transformers ?? [])];

    this._model = options.model ?? {
      id: 'unknown',
      name: 'unknown',
      provider: 'unknown',
      contextWindow: 128000,
      maxTokens: 8192,
      reasoning: false,
    };

    this._streamFn = options.streamFn ?? (async function* () {
      throw new Error('streamFn 未设置，请通过 setStreamFn() 或 RuntimeOptions.streamFn 提供');
    });

    this._systemPrompt = options.systemPrompt ?? '';
    this._thinkingLevel = options.thinkingLevel ?? 'off';
    this._sessionStorage = options.sessionStorage;

    this._maxTurns = options.maxTurns ?? 50;
    this._toolTimeoutMs = options.toolTimeoutMs ?? 120_000;
    this._parallelToolCalls = options.parallelToolCalls ?? true;
    this._contextBudgetRatio = options.contextBudgetRatio ?? 0.8;
    this._compaction = options.compaction;
    this._telemetry = options.telemetry;
    this._permissionPolicy = options.permissionPolicy;
    this._permissionFailOpen = options.permissionFailOpen ?? false;
    this._approvals = options.approvals;
    this._approvalTimeoutMs = options.approvalTimeoutMs ?? 300_000;
    this._traceIdGenerator = options.traceIdGenerator;
    this._sandbox = options.sandbox;

    // 注册初始工具
    if (options.tools) {
      for (const tool of options.tools) {
        this._globalTools.set(tool.name, tool);
      }
    }

    this._sessionKey = 'default';

    // ─── 组装协作模块（getter 注入可变状态：setModel/setStreamFn 等生效） ───
    this._emitter = new RuntimeTelemetry(options.telemetry, options.traceIdGenerator);
    // tapable 抛错接线遥测：扩展 tap 失败默认仅告警并继续（策略见 core/tapable.ts），
    // 此处把失败转发到 onHookError 供观测。多 Runtime 实例时后创建者生效。
    setTapErrorHandler(info => {
      void this._emitter.emit('onHookError', {
        sessionKey: this._sessionKey,
        hook: info.hook,
        tap: info.tap,
        error: info.error,
      });
    });
    this._store = new SessionStore(this._sessionKey, options.maxSessions);
    this._persistence = new SessionPersistence(
      this._sessionStorage, () => this._model, this._store,
    );
    this._tools = new ToolExecutor({
      hooks: this._hooks,
      telemetry: this._emitter,
      permissionPolicy: this._permissionPolicy,
      permissionFailOpen: this._permissionFailOpen,
      approvals: this._approvals,
      approvalTimeoutMs: this._approvalTimeoutMs,
      toolTimeoutMs: this._toolTimeoutMs,
      parallelToolCalls: this._parallelToolCalls,
      defaultSessionKey: this._sessionKey,
      getTools: () => this._globalTools,
      getShared: () => this._extensionContext?.shared,
      sandbox: this._sandbox,
      workspace: options.workspace,
    });
    this._compactor = new ContextCompactor({
      telemetry: this._emitter,
      getModel: () => this._model,
      getStreamFn: () => this._streamFn,
      contextBudgetRatio: this._contextBudgetRatio,
      compaction: this._compaction,
    });
    this._modelTurn = new ModelTurnRunner({
      telemetry: this._emitter,
      compactor: this._compactor,
      hooks: this._hooks,
      getModel: () => this._model,
      getStreamFn: () => this._streamFn,
      getSystemPrompt: () => this._systemPrompt,
      getThinkingLevel: () => this._thinkingLevel,
      getTools: () => this._globalTools,
      resolveSessionKey: request => this.resolveSessionKey(request),
    });
    this._loops = new RunLoops({
      hooks: this._hooks,
      telemetry: this._emitter,
      store: this._store,
      persistence: this._persistence,
      tools: this._tools,
      compactor: this._compactor,
      modelTurn: this._modelTurn,
      getModel: () => this._model,
      getMaxTurns: () => this._maxTurns,
      resolveSessionKey: request => this.resolveSessionKey(request),
      onSessionActivated: key => this.syncExtensionSessionKey(key),
      createCompilation: (request, sessionKey, session, traceId) =>
        this.createCompilation(request, sessionKey, session, traceId),
      buildUserMessage,
      buildResult,
      transformMessages: (compilation, sessionKey) =>
        this.transformMessages(compilation, sessionKey),
    });
  }

  // ─── 静态工厂 ───────────────────────────────────────────────────

  static create(options: RuntimeOptions = {}): AgentRuntime {
    const runtime = new AgentRuntime(options);

    // 注册扩展
    if (options.extensions) {
      runtime._extensions.registerAll(options.extensions);
    }

    // 应用扩展到钩子
    const ctx: ExtensionContext = {
      config: runtime._config,
      workspace: options.workspace ?? process.cwd(),
      sessionKey: runtime._sessionKey,
      shared: new Map(),
      runtime,
    };
    runtime._extensionContext = ctx;
    runtime._extensions.applyAll(ctx);

    return runtime;
  }

  // ─── Runtime 接口实现 ───────────────────────────────────────────

  get config(): Record<string, unknown> {
    return this._config;
  }

  get extensions(): ExtensionManager {
    return this._extensions;
  }

  get hooks(): RuntimeHooks {
    return this._hooks;
  }

  // ─── 工具/模型/流管理 ───────────────────────────────────────────

  registerTool(tool: Tool): this {
    if (this._globalTools.has(tool.name)) {
      console.warn(`[Runtime] 工具 "${tool.name}" 已存在，将被覆盖`);
    }
    this._globalTools.set(tool.name, tool);
    return this;
  }

  registerTools(tools: Tool[]): this {
    for (const tool of tools) {
      this.registerTool(tool);
    }
    return this;
  }

  unregisterTool(name: string): boolean {
    return this._globalTools.delete(name);
  }

  setModel(model: Model): this {
    this._model = model;
    return this;
  }

  setSystemPrompt(prompt: string): this {
    this._systemPrompt = prompt;
    return this;
  }

  setThinkingLevel(level: ThinkingLevel): this {
    this._thinkingLevel = level;
    return this;
  }

  setStreamFn(fn: StreamFn): this {
    this._streamFn = fn;
    return this;
  }

  registerExtension(extension: Extension): this {
    this._extensions.register(extension);
    return this;
  }

  useTransformer(transformer: ContextTransformer): this {
    this._transformers.push(transformer);
    return this;
  }

  /**
   * 获取指定会话的消息列表（默认会话；会话不存在返回空数组）。
   * 同步方法：会话被 LRU 淘汰且配置了存储时，后台异步恢复（下次调用可读到），
   * 需确定性读取（如断言/导出）请用 loadMessages()。
   */
  getMessages(sessionKey?: string): Message[] {
    const key = sessionKey ?? this._sessionKey;
    if (this._store.has(key)) {
      return this._store.getMessagesCopy(key);
    }
    // 会话已被 LRU 淘汰（仅内存态丢失，存储仍在）：fire-and-forget 恢复，
    // 避免调用方在会话被淘汰后误以为历史为空（假性清空）
    if (this._sessionStorage) {
      const session = this._store.ensure(key);
      void this._persistence.hydrate(key, session).catch(() => {
        // 恢复失败（存储不可用等）：保持空历史语义，不抛给同步调用方
      });
    }
    return [];
  }

  /** 异步读取指定会话的消息列表：内存未命中（LRU 淘汰）时等待存储恢复后返回 */
  async loadMessages(sessionKey?: string): Promise<Message[]> {
    const key = sessionKey ?? this._sessionKey;
    const existing = this._store.peek(key);
    if (existing && existing.hydrated) {
      return this._store.getMessagesCopy(key);
    }
    const session = existing ?? this._store.ensure(key);
    await this._persistence.hydrate(key, session);
    return this._store.getMessagesCopy(key);
  }

  /**
   * 指定会话消息的只读视图（高频轮询用）：浅拷贝数组、共享消息对象，
   * 避免每次 structuredClone 深拷贝整个会话历史；调用方不得修改内容。
   */
  peekMessages(sessionKey?: string): readonly Message[] {
    return this._store.peekMessages(sessionKey ?? this._sessionKey);
  }

  /**
   * 同步共享扩展上下文的会话键为本次 run/stream 的真实会话。
   * 注意：ExtensionContext 为跨会话共享单例，多会话并发时该值为最近激活的
   * 会话；需精确会话请用 ToolCallContext.sessionKey / Request.sessionKey。
   */
  private syncExtensionSessionKey(sessionKey: string): void {
    if (this._extensionContext && this._extensionContext.sessionKey !== sessionKey) {
      this._extensionContext.sessionKey = sessionKey;
    }
  }

  // ─── 核心运行逻辑 ───────────────────────────────────────────────

  /** 解析请求路由的会话 key：request.sessionKey ?? 默认会话 key */
  private resolveSessionKey(request: Request): string {
    return request.sessionKey ?? this._sessionKey;
  }

  /** 校验失败路径：上报 errorClass='validation' 的 onRunEnd（不进入排队） */
  private async emitValidationFailure(request: Request, result: Result): Promise<void> {
    await this._emitter.emit('onRunEnd', {
      traceId: this._emitter.newTraceId(),
      sessionKey: this.resolveSessionKey(request),
      request,
      durationMs: 0,
      activeMs: 0,
      queuedMs: 0,
      turnCount: 0,
      result,
      success: false,
      errorClass: 'validation',
      tokens: { input: 0, output: 0 },
    });
  }

  /** 当前活跃的会话 key 列表（含默认会话） */
  getSessionKeys(): string[] {
    return this._store.keys();
  }

  /** 某会话是否存在（内存中） */
  hasSession(sessionKey: string): boolean {
    return this._store.has(sessionKey);
  }

  async run(request: Request): Promise<Result> {
    // 0. 校验请求
    const validation = validateRequest(request);
    if (!validation.valid) {
      const invalidResult = new ResultBuilder()
        .error(`请求校验失败: ${validation.errors.join('; ')}`)
        .build();
      // 校验失败也要可观测（errorClass='validation'），不进入排队
      await this.emitValidationFailure(request, invalidResult);
      return invalidResult;
    }
    const finalRequest = normalizeRequest(request);
    const sessionKey = this.resolveSessionKey(finalRequest);
    const traceId = this._emitter.newTraceId();
    const queuedAt = Date.now();

    // 1. 入队前：onRunStart（配合 onRunEnd 求排队时长 queuedMs）
    await this._emitter.emit('onRunStart', {
      traceId,
      sessionKey,
      request: finalRequest,
      queuedAt,
    });

    // 2. 串行化：同一会话的请求依次执行
    const session = this._store.ensure(sessionKey);
    const release = await this._store.acquire(session);
    const queuedMs = Date.now() - queuedAt;

    try {
      return await this._persistence.withStorageLock(finalRequest, sessionKey, () =>
        this._loops.run(finalRequest, sessionKey, session, traceId, queuedMs),
      );
    } finally {
      release();
    }
  }

  async *stream(request: Request): AsyncGenerator<ResultChunk> {
    // 0. 校验请求
    const validation = validateRequest(request);
    if (!validation.valid) {
      const message = `请求校验失败: ${validation.errors.join('; ')}`;
      // 校验失败也要可观测（errorClass='validation'），不进入排队
      await this.emitValidationFailure(request, new ResultBuilder().error(message).build());
      yield { type: 'error', content: message };
      yield { type: 'done' };
      return;
    }
    const finalRequest = normalizeRequest(request);
    const sessionKey = this.resolveSessionKey(finalRequest);
    const traceId = this._emitter.newTraceId();
    const queuedAt = Date.now();

    await this._emitter.emit('onRunStart', {
      traceId,
      sessionKey,
      request: finalRequest,
      queuedAt,
    });

    // 1. 串行化
    const session = this._store.ensure(sessionKey);
    const release = await this._store.acquire(session);
    const queuedMs = Date.now() - queuedAt;

    try {
      yield* this._persistence.streamWithStorageLock(finalRequest, sessionKey, () =>
        this._loops.stream(finalRequest, sessionKey, session, traceId, queuedMs),
      );
    } finally {
      release();
    }
  }

  createCompilation(request: Request, sessionKey?: string, session?: SessionState, traceId?: string): Compilation {
    return {
      request,
      graph: createTaskGraph(),
      resources: [],
      messages: (session ?? this._store.ensure(sessionKey ?? this._sessionKey)).messages,
      completed: false,
      traceId: traceId ?? this._emitter.newTraceId(),
    };
  }

  async close(): Promise<void> {
    // 等待所有会话的在途任务完成，再清理
    await this._store.drainAndClear();
    this._extensions.clear();
    this._transformers = [];
  }

  // ─── 上下文转换（链式执行，原地替换保持 session 引用） ──────────

  /** 链式执行上下文转换器（按数组顺序，上一个输出作为下一个输入） */
  private async transformMessages(
    compilation: Compilation,
    sessionKey: string,
  ): Promise<void> {
    if (this._transformers.length === 0) {
      return;
    }

    let resources = messagesToResources(compilation.messages);
    const originalResources = resources;
    const context: TransformContext = {
      graph: compilation.graph,
      runtime: {
        sessionKey,
        turn: compilation.messages.length,
        contextWindow: this._model.contextWindow,
        maxTokens: this._model.maxTokens,
        contextBudgetRatio: this._contextBudgetRatio,
      },
    };

    for (const transformer of this._transformers) {
      try {
        const next = await transformer.transform(resources, context);
        // 仅当转换器返回新数组引用时才视为改写（no-op 转换器返回原引用）
        if (next !== resources) resources = next;
      } catch (err) {
        // 单个转换器失败时跳过，保持当前资源不变，但需可观测
        console.warn(
          `[Runtime] 转换器 "${transformer.name}" 失败，已跳过:`,
          (err as Error)?.message ?? err,
        );
      }
    }

    // 全部转换器均为 no-op（返回原引用）：跳过 resourcesToMessages 全量映射
    // 与 splice 重建（长会话每轮 O(n) 两次全量映射的放大开销由此消除）
    if (resources === originalResources) {
      return;
    }

    const messages = resourcesToMessages(resources);
    // 原地替换而非重新赋值：createCompilation 将 session.messages 按引用共享，
    // 重新赋值会导致后续 push 的 assistant/tool 消息脱离会话（持久化丢失）
    compilation.messages.splice(0, compilation.messages.length, ...messages);
  }

  // ─── 手动压缩（交互命令 /compact 等） ───────────────────────────

  /**
   * 手动压缩指定会话：跳过阈值判断，直接将历史压缩至 targetRatio
   * 保留量（复用 compactor 的保留段计算与 compactOrTruncate 执行路径），
   * 压缩后持久化。返回压缩模式；compaction 未启用或无可压缩段时返回 null。
   */
  async compact(sessionKey?: string): Promise<'summary' | 'truncate' | null> {
    if (!this._compaction || this._compaction.enabled === false) return null;
    const key = sessionKey ?? this._sessionKey;
    const session = this._store.ensure(key);
    const messages = session.messages;
    if (messages.length === 0) return null;

    const contextWindow = this._model.contextWindow;
    if (!contextWindow || contextWindow <= 0) return null;

    const split = this._compactor.computeKeepSplit(messages, contextWindow);
    // 无可压缩段（最新消息已占满保留预算）
    if (split <= 0 || split >= messages.length) return null;

    const mode = await this._compactor.compactOrTruncate(
      messages, split, key, `manual-${Date.now().toString(36)}`,
      new AbortController().signal, 'threshold',
    );
    try {
      await this._persistence.persist(key, session);
    } catch (err) {
      console.warn('[Runtime] 手动压缩后持久化失败:', (err as Error)?.message);
    }
    return mode;
  }

  // ─── 便捷方法 ───────────────────────────────────────────────────

  /** 终止指定会话的运行（默认会话；会话不存在为 no-op） */
  abort(sessionKey?: string): void {
    this._store.peek(sessionKey ?? this._sessionKey)?.abortController?.abort();
  }

  /** 检查指定会话是否正在运行（默认会话；会话不存在返回 false） */
  isBusy(sessionKey?: string): boolean {
    return this._store.peek(sessionKey ?? this._sessionKey)?.isStreaming ?? false;
  }

  /** 等待指定会话空闲（默认会话；基于 promise，无轮询） */
  async waitForIdle(sessionKey?: string, timeoutMs?: number): Promise<void> {
    await this._store.waitForIdle(sessionKey ?? this._sessionKey, timeoutMs);
  }

  /** 清除指定会话消息（仅内存；下次 run 会从存储恢复） */
  clearSession(sessionKey?: string): void {
    this._store.clearMessages(sessionKey ?? this._sessionKey);
  }

  /**
   * 设置指定会话的标题并持久化（/rename 类操作）。
   * 会话不在内存时先从存储恢复既有内容再写回，不丢失消息。
   */
  async setSessionTitle(sessionKey: string, title: string): Promise<void> {
    const session = this._store.ensure(sessionKey);
    if (!session.hydrated) await this._persistence.hydrate(sessionKey, session);
    session.title = title;
    if (this._sessionStorage) await this._persistence.persist(sessionKey, session);
  }

  /** 删除指定会话（内存 + 存储），返回是否删除成功 */
  async deleteSession(sessionKey?: string): Promise<boolean> {
    const key = sessionKey ?? this._sessionKey;
    // 等待在途任务完成后再清理（内存态）
    await this._store.remove(key);
    const storage = this._sessionStorage;
    if (!storage) return true;
    if (!storage.withLock) return storage.delete(key);
    // 删除同样持存储锁，避免与另一进程的写入竞争
    return storage.withLock(key, () => storage.delete(key));
  }
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

export function createRuntime(options?: RuntimeOptions): Runtime {
  return AgentRuntime.create(options);
}
