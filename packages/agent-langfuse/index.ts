/**
 * @aipack-ai/agent-langfuse - Langfuse 接入扩展
 *
 * 以 Extension 形式接入 aipack Agent Runtime：
 * - apply 阶段通过 ExtensionContext.telemetry 访问器包装底层 Telemetry
 *   （原实现保持转发，对 Runtime 其余模块透明）；
 * - 将 run（chain）/ 模型调用（llm）/ 工具调用（tool）映射为 Langfuse
 *   Trace / Generation / TOOL observation，traceId / spanId 写入 metadata，便于与框架内日志互查。
 *
 * 设计原则：
 * - 上报失败不影响主流程：所有 Langfuse 调用吞错并经 onError 上报（默认限频 warn）
 * - inputs 经 JSON 序列化快照后上报（与运行态对象解引用，避免内存滞留）；
 *   超过 maxInputBytes 截断
 * - 未提供 transport 且无凭据（显式或 LANGFUSE_* 环境变量）时静默降级为 no-op
 *
 * 用法：
 * ```ts
 * import { AgentRuntime } from '@aipack-ai/agent';
 * import { LangfuseExtension } from '@aipack-ai/agent-langfuse';
 *
 * const runtime = AgentRuntime.create({
 *   // ...
 *   extensions: [new LangfuseExtension()],  // 凭据读 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
 * });
 * ```
 * 配置优先级：构造参数 > RuntimeOptions.config.langfuse > LANGFUSE_* 环境变量。
 */

import { randomUUID } from 'node:crypto';
import { Langfuse } from 'langfuse';
import type { LangfuseTraceClient, LangfuseSpanClient, LangfuseGenerationClient } from 'langfuse';
import type {
  Extension,
  ExtensionContext,
  RuntimeHooks,
  Telemetry,
  Context,
  RunStartTelemetryInfo,
  RunTelemetryInfo,
  ToolTelemetryInfo,
  ModelTelemetryInfo,
} from '@aipack-ai/agent';

// ─── 传输层抽象（测试可注入 / 可对接私有部署） ───────────────────

type KVMap = Record<string, unknown>;

/** 后端 run 的最小结构面（Langfuse 及私有部署上报实现均遵循此接口） */
export interface TracedRun {
  readonly id: string;
  /** 首次持久化（创建 run） */
  postRun(excludeChildRuns?: boolean): Promise<unknown>;
  /** 更新 run（outputs / error / end_time） */
  patchRun(options?: { excludeInputs?: boolean }): Promise<unknown>;
  /** 标记结束字段（不落库，配合 patchRun） */
  end(
    outputs?: KVMap,
    error?: string,
    endTime?: number,
    metadata?: KVMap,
  ): Promise<unknown> | unknown;
  /** 创建子 run */
  createChild(config: TracedRunConfig): TracedRun;
}

export interface TracedRunConfig {
  id?: string;
  name: string;
  run_type: 'chain' | 'llm' | 'tool' | 'retriever';
  inputs?: KVMap;
  start_time?: number;
  end_time?: number;
  extra?: KVMap;
}

export interface TraceTransport {
  createRoot(config: TracedRunConfig): TracedRun;
}

// ─── LangfuseTransport ────────────────────────────────────────────
//
// 将扩展的 TracedRun 抽象映射到 Langfuse JS SDK（v3，OTel 底座）：
// - root（chain）       → Langfuse Trace（sessionKey 映射为 sessionId）
// - tool 子 run         → TOOL 类型 observation（v4 tool-create 事件）
// - llm 子 run          → Generation（input_tokens/output_tokens 映射为 usage）

type ObservationClient = LangfuseSpanClient | LangfuseGenerationClient;
type ClientHolder =
  | { kind: 'trace'; id: string; client: LangfuseTraceClient }
  | { kind: 'span' | 'generation'; id: string; client: ObservationClient }
  | {
      /** Langfuse v4 TOOL 类型 observation（经核心 enqueue 直发 tool-create） */
      kind: 'tool';
      id: string;
      /** Langfuse 核心实例（Langfuse 基类；tool-create 经其 protected enqueue 直发） */
      core: object;
      traceId: string;
      parentObservationId: string | null;
      /** 服务端无 tool-update 事件，end() 时一次性上报完整 body */
      pending: { name: string; startTime: Date; input?: KVMap; metadata?: KVMap };
    };

export interface LangfuseTransportOptions {
  /** Langfuse Public Key（缺省读 LANGFUSE_PUBLIC_KEY） */
  publicKey?: string;
  /** Langfuse Secret Key（缺省读 LANGFUSE_SECRET_KEY） */
  secretKey?: string;
  /** Langfuse 地址（缺省读 LANGFUSE_BASEURL，再缺省 http://localhost:3000） */
  baseUrl?: string;
  /** 注入既有 Langfuse 实例（测试 / 复用全局实例；注入后忽略凭据参数） */
  client?: Langfuse;
}

class LangfuseRun implements TracedRun {
  constructor(private readonly holder: ClientHolder) {}

  get id(): string {
    return this.holder.id;
  }

  async postRun(): Promise<void> {
    /* langfuse SDK 内部排队上报，无需显式 create */
  }

  async patchRun(): Promise<void> {
    /* 同上 */
  }

  async end(
    outputs?: KVMap,
    error?: string,
    endTime?: number,
    metadata?: KVMap,
  ): Promise<void> {
    const level = error ? 'ERROR' : undefined;
    const end = endTime ? new Date(endTime) : undefined;

    if (this.holder.kind === 'trace') {
      this.holder.client.update({
        output: outputs,
        metadata,
      });
      return;
    }

    if (this.holder.kind === 'tool') {
      // tool-create：一次性上报完整 TOOL observation（服务端无 tool-update 事件）。
      // SDK v3 未暴露 tool-create，经核心 client 的 protected enqueue 直发（运行时可用）。
      const { core, traceId, parentObservationId, id, pending } = this.holder;
      (core as unknown as { enqueue(type: string, body: unknown): void }).enqueue('tool-create', {
        id,
        traceId,
        parentObservationId: parentObservationId ?? undefined,
        name: pending.name,
        startTime: pending.startTime,
        endTime: end,
        input: pending.input,
        output: outputs,
        level,
        statusMessage: error,
        metadata: { ...(pending.metadata ?? {}), ...(metadata ?? {}) },
      });
      return;
    }

    if (this.holder.kind === 'span') {
      this.holder.client.update({
        output: outputs,
        endTime: end,
        level,
        statusMessage: error,
        metadata,
      });
      return;
    }

    // generation：从 outputs 中提取 token 用量映射为 usage
    let output = outputs;
    let usage: { input?: number; output?: number; total?: number } | undefined;
    if (outputs && typeof outputs === 'object') {
      const { input_tokens, output_tokens, ...rest } = outputs as Record<string, unknown>;
      if (typeof input_tokens === 'number' || typeof output_tokens === 'number') {
        usage = {
          input: input_tokens as number | undefined,
          output: output_tokens as number | undefined,
          total:
            typeof input_tokens === 'number' && typeof output_tokens === 'number'
              ? input_tokens + output_tokens
              : undefined,
        };
        output = rest;
      }
    }
    this.holder.client.update({
      output,
      usage,
      endTime: end,
      level,
      statusMessage: error,
      metadata,
    });
  }

  createChild(config: TracedRunConfig): TracedRun {
    const h = this.holder;
    const id = config.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // tool 子 run → Langfuse v4 TOOL 类型 observation：
    // SDK v3 未暴露 tool-create 事件，经核心 client enqueue 直发（见 end()）。
    if (config.run_type === 'tool') {
      const pending = {
        name: config.name,
        startTime: new Date(config.start_time ?? Date.now()),
        input: config.inputs as KVMap | undefined,
        metadata: (config.extra?.metadata as KVMap) ?? undefined,
      };
      if (h.kind === 'tool') {
        return new LangfuseRun({
          kind: 'tool',
          id,
          core: h.core,
          traceId: h.traceId,
          parentObservationId: h.id,
          pending,
        });
      }
      return new LangfuseRun({
        kind: 'tool',
        id,
        core: h.client.client,
        traceId: h.client.traceId,
        parentObservationId: h.client.observationId,
        pending,
      });
    }

    if (h.kind === 'tool') {
      // TOOL observation 为叶子节点，不支持挂子 run（当前扩展无此场景）
      throw new Error('[langfuse] TOOL observation 不支持创建子 run');
    }

    const body = {
      id,
      name: config.name,
      startTime: config.start_time ? new Date(config.start_time) : undefined,
      input: config.inputs as KVMap | undefined,
      metadata: (config.extra?.metadata as KVMap) ?? undefined,
    };
    if (config.run_type === 'llm') {
      return new LangfuseRun({
        kind: 'generation',
        id,
        client: h.client.generation(body),
      });
    }
    return new LangfuseRun({
      kind: 'span',
      id,
      client: h.client.span(body),
    });
  }
}

export class LangfuseTransport implements TraceTransport {
  private readonly client: Langfuse;

  constructor(options: LangfuseTransportOptions = {}) {
    if (options.client) {
      this.client = options.client;
      return;
    }
    const publicKey = options.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = options.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
    if (!publicKey || !secretKey) {
      throw new Error(
        '[langfuse] 缺少凭据：请提供 publicKey/secretKey 或设置 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY',
      );
    }
    this.client = new Langfuse({
      publicKey,
      secretKey,
      baseUrl: options.baseUrl ?? process.env.LANGFUSE_BASEURL ?? 'http://localhost:3000',
    });
  }

  createRoot(config: TracedRunConfig): TracedRun {
    const metadata = (config.extra?.metadata as KVMap) ?? undefined;
    const trace = this.client.trace({
      id: config.id,
      name: config.name,
      input: config.inputs as KVMap | undefined,
      // sessionKey 直接映射 Langfuse Sessions，便于按会话聚合
      sessionId:
        metadata && typeof metadata.sessionKey === 'string'
          ? (metadata.sessionKey as string)
          : undefined,
      timestamp: config.start_time ? new Date(config.start_time) : undefined,
      metadata,
    });
    return new LangfuseRun({
      kind: 'trace',
      id: config.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      client: trace,
    });
  }

  /** 主动刷出队列中的上报（进程退出前调用） */
  async flush(): Promise<void> {
    await this.client.flushAsync();
  }
}

// ─── 配置 ─────────────────────────────────────────────────────────

export interface LangfuseExtensionOptions {
  /** 扩展名（默认 'langfuse'） */
  name?: string;
  /** 显式开关；缺省时按 transport / 凭据 / LANGFUSE_* 环境变量判定 */
  enabled?: boolean;
  /** Langfuse Public Key（缺省读 LANGFUSE_PUBLIC_KEY） */
  publicKey?: string;
  /** Langfuse Secret Key（缺省读 LANGFUSE_SECRET_KEY） */
  secretKey?: string;
  /** Langfuse 地址（缺省读 LANGFUSE_BASEURL） */
  baseUrl?: string;
  /** 根 run 名称（默认 'aipack.agent'） */
  runName?: string;
  /** 自定义传输（测试 / 对接私有部署；注入后视为启用） */
  transport?: TraceTransport;
  /** 上报失败回调（默认限频 console.warn） */
  onError?: (err: unknown, where: string) => void;
  /** 单次 inputs 序列化上限（字符数，默认 65536，超出截断） */
  maxInputBytes?: number;
  /** 活跃根 run 表上限（默认 1000，防泄漏；超出淘汰最旧并补报结束） */
  maxActiveRuns?: number;
}

// ─── LangfuseExtension ────────────────────────────────────────────

interface RootEntry {
  run: TracedRun;
}

const DEFAULT_RUN_NAME = 'aipack.agent';
const DEFAULT_MAX_INPUT_BYTES = 65_536;
const DEFAULT_MAX_ACTIVE_RUNS = 1_000;
const DEFAULT_MAX_CONTEXT_CACHE = 256;

export class LangfuseExtension implements Extension {
  readonly name: string;

  private readonly options: LangfuseExtensionOptions;
  /** traceId → 根 run */
  private readonly roots = new Map<string, RootEntry>();
  /** sessionKey → 最近一次 beforeModelCall 上下文快照（供 onModelCall 补 inputs） */
  private readonly lastContexts = new Map<string, KVMap>();
  /** 错误限频计数 */
  private errorCount = 0;

  constructor(options: LangfuseExtensionOptions = {}) {
    this.name = options.name ?? 'langfuse';
    this.options = options;
  }

  apply(hooks: RuntimeHooks, context: ExtensionContext): void {
    const opts = this.resolveOptions(context);

    if (!this.isEnabled(opts)) return;

    const transport =
      opts.transport ??
      new LangfuseTransport({
        publicKey: opts.publicKey,
        secretKey: opts.secretKey,
        baseUrl: opts.baseUrl,
      });
    const runName = opts.runName ?? DEFAULT_RUN_NAME;

    // 捕获模型调用前的上下文快照，供 onModelCall 子 run 的 inputs。
    // 会话标识取 ExtensionContext.sessionKey（进入会话时由 Runtime 更新），
    // 多会话并发时可能错位，错位时仅丢失 inputs，不影响链路结构。
    hooks.beforeModelCall.tapPromise(`${this.name}:capture-context`, async (ctx: Context) => {
      try {
        const snapshot = this.sanitize({ systemPrompt: ctx.systemPrompt, messages: ctx.messages });
        if (snapshot) this.rememberContext(context.sessionKey, snapshot);
      } catch {
        // 快照失败仅丢失 llm inputs，不干预主流程
      }
      return ctx;
    });

    const accessor = context.telemetry;
    if (!accessor) {
      this.reportError(
        'ExtensionContext 未暴露 telemetry 访问器（需 @aipack-ai/agent >= 本扩展版本），扩展未生效',
        'apply',
      );
      return;
    }

    const original = accessor.get();
    accessor.set(this.wrapTelemetry(original, transport, runName));
  }

  // ─── 配置合并 ─────────────────────────────────────────────────────

  private resolveOptions(context: ExtensionContext): LangfuseExtensionOptions {
    const fromConfig = (
      context.config as { langfuse?: Partial<LangfuseExtensionOptions> } | undefined
    )?.langfuse;
    return { ...(fromConfig ?? {}), ...this.options };
  }

  private isEnabled(opts: LangfuseExtensionOptions): boolean {
    if (opts.enabled !== undefined) return opts.enabled;
    return Boolean(
      opts.transport ??
        (opts.publicKey && opts.secretKey) ??
        (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
    );
  }

  // ─── Telemetry 包装 ───────────────────────────────────────────────

  private wrapTelemetry(
    original: Telemetry | undefined,
    transport: TraceTransport,
    runName: string,
  ): Telemetry {
    const safe = <T>(where: string, fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (err) {
        this.reportError(err, where);
        return fallback;
      }
    };

    return {
      onRunStart: async (info: RunStartTelemetryInfo) => {
        safe('onRunStart', () => this.handleRunStart(info, transport, runName), undefined);
        await original?.onRunStart?.(info);
      },
      onRunEnd: async (info: RunTelemetryInfo) => {
        safe('onRunEnd', () => this.handleRunEnd(info), undefined);
        await original?.onRunEnd?.(info);
      },
      onToolCall: async (info: ToolTelemetryInfo) => {
        safe('onToolCall', () => this.handleToolCall(info), undefined);
        await original?.onToolCall?.(info);
      },
      onModelCall: async (info: ModelTelemetryInfo) => {
        safe('onModelCall', () => this.handleModelCall(info), undefined);
        await original?.onModelCall?.(info);
      },
      // 其余事件仅转发（Langfuse 链路不消费）
      onRetry: (info) => original?.onRetry?.(info),
      onCompaction: (info) => original?.onCompaction?.(info),
      onPermissionDenied: (info) => original?.onPermissionDenied?.(info),
      onApprovalPending: (info) => original?.onApprovalPending?.(info),
      onApprovalResolved: (info) => original?.onApprovalResolved?.(info),
      onHookError: (info) => original?.onHookError?.(info),
    };
  }

  // ─── 事件处理 ─────────────────────────────────────────────────────

  private handleRunStart(
    info: RunStartTelemetryInfo,
    transport: TraceTransport,
    runName: string,
  ): void {
    const run = transport.createRoot({
      id: this.newId(),
      name: runName,
      run_type: 'chain',
      inputs: this.sanitize({
        message: info.request.message,
        type: info.request.type,
        sessionKey: info.sessionKey,
        model: info.request.model,
        media: info.request.media,
        metadata: info.request.metadata,
      }),
      start_time: info.queuedAt || Date.now(),
      extra: {
        metadata: {
          traceId: info.traceId,
          sessionKey: info.sessionKey,
          requestType: info.request.type,
        },
      },
    });
    this.rememberRun(info.traceId, run);
    this.fire(run.postRun(true), 'onRunStart.postRun');
  }

  private handleRunEnd(info: RunTelemetryInfo): void {
    const entry = this.roots.get(info.traceId);
    this.roots.delete(info.traceId);
    if (!entry) return;

    const result = info.result;
    const error =
      info.success ? undefined : (result.error ?? info.errorClass ?? 'run failed');
    entry.run.end(
      this.sanitize({ output: result.content }) as KVMap,
      error,
      Date.now(),
      { tokens: info.tokens, turnCount: info.turnCount, stopReason: result.stopReason },
    );
    this.fire(entry.run.patchRun(), 'onRunEnd.patchRun');
  }

  private handleToolCall(info: ToolTelemetryInfo): void {
    const root = this.roots.get(info.traceId);
    if (!root) return;

    const endTime = Date.now();
    const child = root.run.createChild({
      id: this.newId(),
      name: info.toolName,
      run_type: 'tool',
      inputs: this.sanitize(info.args) as KVMap,
      start_time: Math.max(0, endTime - info.durationMs),
      end_time: endTime,
      extra: {
        metadata: {
          spanId: info.spanId,
          status: info.status,
          errorClass: info.errorClass,
        },
      },
    });
    child.end(
      this.sanitize(info.result) as KVMap,
      info.success ? undefined : (info.errorClass ?? info.status),
      endTime,
    );
    this.fire(child.postRun(true), 'onToolCall.postRun');
    this.fire(child.patchRun(), 'onToolCall.patchRun');
  }

  private handleModelCall(info: ModelTelemetryInfo): void {
    const root = this.roots.get(info.traceId);
    if (!root) return;

    const inputs = this.lastContexts.get(info.sessionKey) ?? { model: info.modelId };
    this.lastContexts.delete(info.sessionKey);

    const endTime = Date.now();
    const child = root.run.createChild({
      id: this.newId(),
      name: info.modelId,
      run_type: 'llm',
      inputs,
      start_time: Math.max(0, endTime - info.durationMs),
      end_time: endTime,
      extra: {
        metadata: {
          spanId: info.spanId,
          attempts: info.attempts,
          stream: info.stream,
          cacheRead: info.cacheRead,
          cacheWrite: info.cacheWrite,
          errorClass: info.errorClass,
        },
      },
    });
    child.end(
      {
        input_tokens: info.inputTokens,
        output_tokens: info.outputTokens,
        cache_read: info.cacheRead,
        cache_write: info.cacheWrite,
      },
      info.errorClass,
      endTime,
    );
    this.fire(child.postRun(true), 'onModelCall.postRun');
    this.fire(child.patchRun(), 'onModelCall.patchRun');
  }

  // ─── 内部工具 ─────────────────────────────────────────────────────

  private newId(): string {
    return randomUUID();
  }

  private fire(p: unknown, where: string): void {
    Promise.resolve(p).catch(err => this.reportError(err, where));
  }

  /**
   * 深拷贝快照（JSON 往返）：与运行态对象解引用，防止上报持有
   * 消息数组等大对象导致内存滞留；超出上限截断。
   */
  private sanitize(value: unknown): KVMap | undefined {
    const cap = this.options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
    if (value === undefined) return undefined;
    try {
      const s = JSON.stringify(value);
      if (s === undefined) return { value: String(value) };
      if (s.length <= cap) return JSON.parse(s) as KVMap;
      return { truncated: true, preview: s.slice(0, cap) };
    } catch {
      return { unserializable: true };
    }
  }

  private rememberRun(traceId: string, run: TracedRun): void {
    const cap = this.options.maxActiveRuns ?? DEFAULT_MAX_ACTIVE_RUNS;
    while (this.roots.size >= cap) {
      const oldest = this.roots.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.roots.get(oldest)!;
      this.roots.delete(oldest);
      // 尽力补报结束，避免 Langfuse 侧悬空 run
      try {
        evicted.run.end({ output: '[evicted] maxActiveRuns exceeded' }, undefined, Date.now());
        this.fire(evicted.run.patchRun(), 'rememberRun.evict');
      } catch {
        // 忽略
      }
    }
    this.roots.set(traceId, { run });
  }

  private rememberContext(sessionKey: string, snapshot: KVMap): void {
    const cap = DEFAULT_MAX_CONTEXT_CACHE;
    if (this.lastContexts.size >= cap) {
      const oldest = this.lastContexts.keys().next().value;
      if (oldest !== undefined) this.lastContexts.delete(oldest);
    }
    // 重新插入以刷新淘汰顺序（Map 按 first-insert 序）
    this.lastContexts.delete(sessionKey);
    this.lastContexts.set(sessionKey, snapshot);
  }

  private reportError(err: unknown, where: string): void {
    if (this.options.onError) {
      try {
        this.options.onError(err, where);
      } catch {
        // 忽略回调自身错误
      }
      return;
    }
    this.errorCount += 1;
    if (this.errorCount <= 5 || this.errorCount % 100 === 0) {
      console.warn(`[langfuse] 上报失败(${where}):`, (err as Error)?.message ?? err);
    }
  }
}
