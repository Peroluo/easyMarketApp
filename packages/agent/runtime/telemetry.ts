/**
 * 遥测发射器（从 AgentRuntime 拆出）：
 * - 统一的 emit（全可选、失败不阻断主流程）
 * - run 级 onRunEnd 组装上报、run 级错误分类
 * - traceId 生成（可注入确定性生成器，供测试）
 */

import type { Compilation, Request, Result, AssistantMessage } from '../core';
import type { Telemetry, ErrorClass } from '../telemetry';
import { newTraceId, errorClassFromMessage } from './shared';

export class RuntimeTelemetry {
  constructor(
    private _telemetry: Telemetry | undefined,
    private readonly _traceIdGenerator?: () => string,
  ) {}

  /** 当前底层 Telemetry（供 Extension 在 apply 阶段读取/包装） */
  getTelemetry(): Telemetry | undefined {
    return this._telemetry;
  }

  /**
   * 替换底层 Telemetry（emitter 实例不变，各协作模块按引用持有的
   * 仍是本 emitter，替换对其透明；后续 emit 流向新实现）。
   */
  setTelemetry(next: Telemetry | undefined): void {
    this._telemetry = next;
  }

  /** traceId 生成：优先用注入的生成器（测试可确定性） */
  newTraceId(): string {
    return this._traceIdGenerator ? this._traceIdGenerator() : newTraceId();
  }

  /**
   * 触发遥测回调。全可选、失败不阻断主流程。
   */
  async emit<E extends keyof Telemetry>(
    event: E,
    info: Parameters<NonNullable<Telemetry[E]>>[0],
  ): Promise<void> {
    const fn = this._telemetry?.[event];
    if (!fn) return;
    try {
      await Promise.resolve((fn as (arg: unknown) => unknown)(info));
    } catch (err) {
      // 遥测失败不应影响主流程
      console.warn(`[aipack] telemetry "${String(event)}" 上报失败:`, err);
    }
  }

  /** 组装并上报 run 级完成事件（run/stream 内部统一调用） */
  async emitRunEnd(
    request: Request,
    sessionKey: string,
    compilation: Compilation,
    result: Result,
    queuedMs: number,
    activeStartedAt: number,
    defaultModelId: string,
  ): Promise<void> {
    const activeMs = Date.now() - activeStartedAt;
    await this.emit('onRunEnd', {
      traceId: compilation.traceId,
      sessionKey,
      // 请求未显式指定 model 时补实际模型（模型排行按 run 级 requests 统计，缺省会落入 'unknown'）
      request: request.model ? request : { ...request, model: defaultModelId },
      durationMs: activeMs + queuedMs,
      activeMs,
      queuedMs,
      turnCount: compilation.turnCount ?? 0,
      result,
      success: result.success,
      errorClass: this.runErrorClass(compilation),
      tokens: {
        input: result.usage.input ?? 0,
        output: result.usage.output ?? 0,
        cacheRead: result.usage.cacheRead,
        cacheWrite: result.usage.cacheWrite,
      },
      ttftMs: compilation.ttftMs,
    });
  }

  /** run 级错误分类：terminate → 'terminated'；否则只看最后一条 assistant 消息（与 buildResult 的 result.success 同口径） */
  runErrorClass(compilation: Compilation): ErrorClass | undefined {
    if (compilation.terminateReason) return 'terminated';
    const messages = compilation.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant') {
        // 最后一条 assistant 无 errorMessage → run 成功（早期轮次失败已被后续轮次恢复，不判错误）
        if (!(m as AssistantMessage).errorMessage) return undefined;
        const cls = errorClassFromMessage((m as AssistantMessage).errorMessage!);
        return (cls as ErrorClass | undefined) ?? 'unknown';
      }
    }
    return undefined;
  }
}
