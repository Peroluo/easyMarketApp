/**
 * Extension - 扩展插件系统
 *
 * Extension 通过 Tapable 钩子在 Runtime 生命周期的关键节点注入逻辑，
 * 无需修改 Runtime 核心，实现开闭原则。
 */

import { AsyncSeriesHook, AsyncSeriesWaterfallHook } from './tapable';
import type { Request } from './request';
import type { Result } from './result';
import type { Context } from './types';
import type { ContextResource } from './context-resource';
import type { BeforeToolCallDecision, AfterToolCallDecision } from './tool-hooks';
import type { Runtime } from './runtime';
import type { Telemetry } from './telemetry';

// ─── Runtime 钩子集合 ─────────────────────────────────────────────

export interface RuntimeHooks {
  /** Runtime 初始化前 */
  beforeInitialize: AsyncSeriesHook<[Request]>;
  /** Runtime 初始化后 */
  afterInitialize: AsyncSeriesHook<[Request]>;
  /** 请求处理前（可修改请求） */
  beforeRun: AsyncSeriesWaterfallHook<Request>;
  /** 资源构建后、转换前（可修改资源） */
  beforeTransform: AsyncSeriesWaterfallHook<ContextResource[]>;
  /**
   * 资源转换后、模型调用前（可修改资源）
   */
  afterTransform: AsyncSeriesWaterfallHook<ContextResource[]>;
  /**
   * 模型调用前（waterfall，可修改最终发给模型的 Context：
   * systemPrompt / messages / tools）。
   * 典型用途：插件注入 system prompt 片段或动态附加工具（如 skills 目录注入）。
   * 每次模型调用触发一次；systemPrompt 以 Runtime 持有的基准值为起点，改动不累积。
   */
  beforeModelCall: AsyncSeriesWaterfallHook<Context>;
  /** 模型调用后、结果构建前 */
  beforeEmit: AsyncSeriesHook<[Result]>;
  /** 结果构建后 */
  afterEmit: AsyncSeriesHook<[Result]>;
  /**
   * 运行结束。
   * 第二参数为最终 Request（可选，向后兼容）。
   * 单会话模式下会话标识由 Runtime 持有；多会话场景请创建独立 Runtime 实例。
   */
  done: AsyncSeriesHook<[Result, Request?]>;
  /** 运行失败 */
  failed: AsyncSeriesHook<[Error, Request]>;
  /**
   * 工具执行前（参数校验后）。流转 BeforeToolCallDecision：
   * 任一 tap 设 block 则该工具不执行（生成拒绝结果）；
   * 设 terminate 则终止整个 run（本轮工具结束后停止 runLoop）；
   * 可改写 args。第二参数为 ToolCallContext。
   */
  beforeToolCall: AsyncSeriesWaterfallHook<BeforeToolCallDecision>;
  /**
   * 工具执行后、最终事件发出前。流转 AfterToolCallDecision：
   * 可改写 result（waterfall），设 terminate 终止整个 run。
   * 第二参数为 ToolCallContext。
   */
  afterToolCall: AsyncSeriesWaterfallHook<AfterToolCallDecision>;
}

// ─── Extension 接口 ───────────────────────────────────────────────

export interface Extension {
  /** 扩展名称 */
  readonly name: string;
  /**
   * 应用扩展到 Runtime
   * 通过 hooks.tap 注册回调
   */
  apply(hooks: RuntimeHooks, context: ExtensionContext): void;
}

// ─── 扩展上下文 ───────────────────────────────────────────────────

export interface ExtensionContext {
  /** Runtime 配置 */
  readonly config: Record<string, unknown>;
  /** 工作区路径 */
  readonly workspace: string;
  /**
   * 会话标识：run/stream 进入会话时由 Runtime 更新为本次真实会话键
   * （此前恒为创建时刻的默认值 'default'）。
   * 注意：跨会话共享单例，多会话并发时为最近激活的会话；
   * 需要精确会话请使用 ToolCallContext.sessionKey / Request.sessionKey。
   */
  sessionKey: string;
  /** 共享状态（Extension 间通信） */
  readonly shared: Map<string, unknown>;
  /**
   * 所属 Runtime 引用（可选）。
   * 供插件在 apply 阶段注册工具等（如 SkillsExtension 注册内置 skill 工具）。
   * 由 AgentRuntime.create 注入；自建 ExtensionContext 时可缺省。
   */
  readonly runtime?: Runtime;
  /**
   * 运行时遥测访问器（可选）。Telemetry 经 RuntimeOptions.telemetry 注入，
   * emitter 在 Runtime 构造期即被各协作模块按引用共享；Extension 若需在
   * apply 阶段包装/替换底层 Telemetry（如接入 Langfuse 等 APM），通过本
   * 访问器读写——emitter 实例不变，替换对所有模块透明。
   * 由 AgentRuntime.create 注入；自建 ExtensionContext 时可缺省。
   */
  readonly telemetry?: {
    /** 当前生效的 Telemetry（RuntimeOptions 未注入时为 undefined） */
    get(): Telemetry | undefined;
    /** 替换底层 Telemetry（后续所有遥测事件流向新实现） */
    set(next: Telemetry | undefined): void;
  };
}

// ─── Extension 管理器 ─────────────────────────────────────────────

export class ExtensionManager {
  private extensions: Extension[] = [];
  private hooks: RuntimeHooks;

  constructor() {
    this.hooks = this.createHooks();
  }

  private createHooks(): RuntimeHooks {
    return {
      beforeInitialize: new AsyncSeriesHook('beforeInitialize'),
      afterInitialize: new AsyncSeriesHook('afterInitialize'),
      beforeRun: new AsyncSeriesWaterfallHook('beforeRun'),
      beforeTransform: new AsyncSeriesWaterfallHook('beforeTransform'),
      afterTransform: new AsyncSeriesWaterfallHook('afterTransform'),
      beforeModelCall: new AsyncSeriesWaterfallHook('beforeModelCall'),
      beforeEmit: new AsyncSeriesHook('beforeEmit'),
      afterEmit: new AsyncSeriesHook('afterEmit'),
      done: new AsyncSeriesHook('done'),
      failed: new AsyncSeriesHook('failed'),
      beforeToolCall: new AsyncSeriesWaterfallHook('beforeToolCall'),
      afterToolCall: new AsyncSeriesWaterfallHook('afterToolCall'),
    };
  }

  /** 注册扩展 */
  register(extension: Extension): this {
    this.extensions.push(extension);
    return this;
  }

  /** 批量注册扩展 */
  registerAll(extensions: Extension[]): this {
    for (const ext of extensions) {
      this.register(ext);
    }
    return this;
  }

  /** 应用所有扩展到钩子 */
  applyAll(context: ExtensionContext): void {
    for (const ext of this.extensions) {
      try {
        ext.apply(this.hooks, context);
      } catch (err) {
        // 单个 Extension 失败不影响其他 Extension，但需可观测
        console.warn(`[Extension] "${ext.name}" apply 失败:`, (err as Error)?.message ?? err);
      }
    }
  }

  /** 获取钩子集合 */
  getHooks(): RuntimeHooks {
    return this.hooks;
  }

  /** 移除扩展 */
  unregister(name: string): boolean {
    const idx = this.extensions.findIndex(e => e.name === name);
    if (idx === -1) return false;
    this.extensions.splice(idx, 1);
    return true;
  }

  /** 获取所有已注册的扩展 */
  getExtensions(): Extension[] {
    return [...this.extensions];
  }

  /** 清空所有扩展 */
  clear(): void {
    this.extensions = [];
  }
}

// ─── 抽象基类 ─────────────────────────────────────────────────────

export abstract class BaseExtension implements Extension {
  abstract readonly name: string;

  apply(hooks: RuntimeHooks, context: ExtensionContext): void {
    this.setup(hooks, context);
  }

  protected abstract setup(hooks: RuntimeHooks, context: ExtensionContext): void;
}
