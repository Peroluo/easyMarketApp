/**
 * 工具执行器（从 AgentRuntime 拆出）：
 * - 单个/一组工具调用执行（并行或串行，terminate 信号聚合）
 * - PermissionPolicy 框架级安全裁决 + 审批挂起（Human-in-the-loop）
 * - beforeToolCall / afterToolCall 钩子、工具结果消息构建
 */

import type {
  Tool,
  ToolCallContent,
  ToolResult,
  ToolResultMessage,
  Request,
  RuntimeHooks,
  ToolCallContext,
  BeforeToolCallDecision,
  AfterToolCallDecision,
  PermissionRequest,
  PermissionPolicy,
  ApprovalManager,
} from '../core';
import { createTextContent } from '../core';
import type { ErrorClass } from '../telemetry';
import {
  withTimeoutSignal,
  toolResultStatus,
  errorClassFromMessage,
  newSpanId,
  type ToolExecutionOutcome,
  type SingleToolOutcome,
} from './shared';
import type { RuntimeTelemetry } from './telemetry';

export interface ToolExecutorDeps {
  hooks: RuntimeHooks;
  telemetry: RuntimeTelemetry;
  permissionPolicy: PermissionPolicy | undefined;
  /** 未配置策略时是否显式放行（RuntimeOptions.permissionFailOpen，默认 false = 拒绝） */
  permissionFailOpen: boolean;
  approvals: ApprovalManager | undefined;
  approvalTimeoutMs: number;
  toolTimeoutMs: number;
  parallelToolCalls: boolean;
  defaultSessionKey: string;
  /** 全局工具表（registerTool 动态变更，须以 getter 注入） */
  getTools: () => Map<string, Tool>;
  /** 扩展共享状态（Extension 应用后存在） */
  getShared: () => Map<string, unknown> | undefined;
}

export class ToolExecutor {
  constructor(private readonly _d: ToolExecutorDeps) {}

  /**
   * 执行一组工具调用：parallelToolCalls 为 true 时并行，否则串行。
   * 返回 ToolExecutionOutcome：任一工具请求 terminate 即终止整个 run；
   * 串行模式下 terminate 后剩余工具生成 skipped 结果以保持配对完整。
   */
  async run(
    toolCalls: ToolCallContent[],
    signal: AbortSignal,
    request: Request,
    traceId: string,
  ): Promise<ToolExecutionOutcome> {
    const execute = (tc: ToolCallContent) => this.execute(tc, signal, request, traceId);

    if (this._d.parallelToolCalls && toolCalls.length > 1) {
      // 并行：全部执行，聚合 terminate（取第一个命中的原因）
      const outcomes = await Promise.all(toolCalls.map(execute));
      const terminated = outcomes.find(o => o.terminate);
      return {
        results: outcomes.map(o => o.result),
        terminate: !!terminated,
        terminateReason: terminated?.terminateReason,
      };
    }

    // 串行：依次执行；遇 terminate 后剩余工具跳过执行（生成 skipped 结果保持配对）
    const results: ToolResult[] = [];
    let terminate = false;
    let terminateReason: string | undefined;
    for (const tc of toolCalls) {
      if (terminate) {
        results.push(this.makeSkippedResult(tc));
        continue;
      }
      const outcome = await execute(tc);
      results.push(outcome.result);
      if (outcome.terminate) {
        terminate = true;
        terminateReason = outcome.terminateReason;
      }
    }
    return { results, terminate, terminateReason };
  }

  async execute(
    toolCall: ToolCallContent,
    signal: AbortSignal | undefined,
    request: Request,
    traceId: string,
  ): Promise<SingleToolOutcome> {
    const tool = this._d.getTools().get(toolCall.name);

    if (!tool) {
      return {
        result: {
          content: [createTextContent(`Tool "${toolCall.name}" not found`)],
          details: { error: `Tool "${toolCall.name}" not found` },
        },
        terminate: false,
      };
    }

    // ─── 参数预处理（权限裁决与执行钩子均基于处理后的 args）───
    let args: unknown = toolCall.arguments;
    if (tool.prepareArguments) {
      args = tool.prepareArguments(toolCall.arguments);
    }

    // ─── PermissionPolicy：框架级安全底线，先于扩展钩子裁决 ───
    // 未配置策略 → 默认 fail-closed（拒绝执行，安全姿态）；
    // 显式 opt-in（RuntimeOptions.permissionFailOpen: true）才放行（旧行为）。
    // 配置了策略时：deny / confirm 未批准 → blocked 结果；
    // pending → 挂起等待外部审批（超时 / run abort 均视为拒绝）
    if (!this._d.permissionPolicy) {
      if (!this._d.permissionFailOpen) {
        const reason =
          `no permissionPolicy configured (fail-closed by default). ` +
          `Configure RuntimeOptions.permissionPolicy (e.g. createAllowAllPolicy()) ` +
          `or explicitly set permissionFailOpen: true to allow unrestricted tool execution`;
        await this._d.telemetry.emit('onPermissionDenied', {
          traceId,
          sessionKey: request.sessionKey ?? this._d.defaultSessionKey,
          toolName: toolCall.name,
          permissions: tool.permissions ?? [],
          args,
          reason: `permission denied for tool "${toolCall.name}": ${reason}`,
        });
        return {
          result: this.makeBlockedResult(`permission denied for tool "${toolCall.name}": ${reason}`),
          terminate: false,
        };
      }
    } else {
      const permissionReq: PermissionRequest = {
        toolName: toolCall.name,
        permissions: tool.permissions ?? [],
        args,
        sessionKey: request.sessionKey ?? this._d.defaultSessionKey,
        request,
        shared: this._d.getShared() ?? new Map(),
      };
      const decision = await this._d.permissionPolicy.check(permissionReq);
      let allowed = decision === 'allow';
      if (decision === 'confirm') {
        allowed = this._d.permissionPolicy.confirm
          ? await this._d.permissionPolicy.confirm(permissionReq)
          : false;
      }
      if (decision === 'pending') {
        // 挂起等待外部审批（异步 Human-in-the-loop）；
        // 未配置审批管理器 → 保守拒绝（与 confirm 未提供回调的行为一致）
        if (this._d.approvals) {
          const approval = this._d.approvals.create(permissionReq, {
            timeoutMs: this._d.approvalTimeoutMs,
            signal,
          });
          await this._d.telemetry.emit('onApprovalPending', {
            traceId,
            sessionKey: permissionReq.sessionKey,
            approvalId: approval.id,
            toolName: toolCall.name,
            permissions: permissionReq.permissions,
            args,
            expiresAt: approval.expiresAt,
          });
          const outcome = await this._d.approvals.wait(approval);
          allowed = outcome.status === 'approved';
          await this._d.telemetry.emit('onApprovalResolved', {
            traceId,
            sessionKey: permissionReq.sessionKey,
            approvalId: approval.id,
            toolName: toolCall.name,
            outcome: outcome.status,
            waitedMs: outcome.waitedMs,
          });
        } else {
          allowed = false;
        }
      }
      if (!allowed) {
        const reason = `permission denied by policy for tool "${toolCall.name}"`;
        await this._d.telemetry.emit('onPermissionDenied', {
          traceId,
          sessionKey: permissionReq.sessionKey,
          toolName: toolCall.name,
          permissions: permissionReq.permissions,
          args,
          reason,
        });
        return {
          result: this.makeBlockedResult(reason),
          terminate: false,
        };
      }
    }

    // ─── 工具超时信号：权限裁决（含审批挂起）完成后起表，
    // 审批等待不占用工具执行超时 ───
    const { signal: timedSignal, clear } = withTimeoutSignal(signal, this._d.toolTimeoutMs);
    try {
      // ─── beforeToolCall：参数校验后、执行前（可 block / terminate / 改写 args）───
      const beforeCtx = this.buildToolCallContext(toolCall, tool, args, request, timedSignal);
      const before: BeforeToolCallDecision = await this._d.hooks.beforeToolCall.promise(
        { block: false, terminate: false, args },
        beforeCtx,
      );

      if (before.terminate) {
        const reason = before.reason ?? 'terminated by beforeToolCall';
        return {
          result: this.makeBlockedResult(reason),
          terminate: true,
          terminateReason: reason,
        };
      }
      if (before.block) {
        const reason = before.reason ?? 'blocked by beforeToolCall';
        return {
          result: this.makeBlockedResult(reason),
          terminate: false,
        };
      }
      // 允许 beforeToolCall 改写参数
      args = before.args;

      // ─── 执行工具 ───
      const toolStartedAt = Date.now();
      let result: ToolResult;
      try {
        result = await tool.execute(toolCall.id, args, timedSignal);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        result = {
          content: [createTextContent(message)],
          details: { error: message },
        };
      }

      const status = toolResultStatus(result);
      await this._d.telemetry.emit('onToolCall', {
        traceId,
        spanId: newSpanId(),
        sessionKey: request.sessionKey ?? this._d.defaultSessionKey,
        toolName: toolCall.name,
        args,
        durationMs: Date.now() - toolStartedAt,
        result,
        success: status === 'ok',
        status,
        errorClass:
          status === 'error'
            ? (errorClassFromMessage(String((result.details as { error?: unknown })?.error ?? '')) as ErrorClass | undefined) ?? 'tool_error'
            : undefined,
      });

      // ─── afterToolCall：执行后、事件发出前（可改写 result / terminate）───
      // 用更新后的 args 重建 ctx，让 afterToolCall 看到改写后的参数
      const afterCtx = this.buildToolCallContext(toolCall, tool, args, request, timedSignal);
      const after: AfterToolCallDecision = await this._d.hooks.afterToolCall.promise(
        { result, terminate: false },
        afterCtx,
      );

      return {
        result: after.result,
        terminate: after.terminate,
        terminateReason: after.terminate ? 'terminated by afterToolCall' : undefined,
      };
    } finally {
      clear();
    }
  }

  isErrorResult(result: ToolResult): boolean {
    return toolResultStatus(result) === 'error';
  }

  /** beforeToolCall 阻断/终止时生成拒绝结果（非执行错误，isError=false） */
  private makeBlockedResult(reason: string): ToolResult {
    return {
      content: [createTextContent(`[blocked] ${reason}`)],
      details: { blocked: true, reason },
    };
  }

  /** 串行模式下前序工具 terminate 后，剩余工具生成 skipped 结果保持配对 */
  private makeSkippedResult(toolCall: ToolCallContent): ToolResult {
    return {
      content: [createTextContent(`[skipped] run terminated by prior tool: ${toolCall.name}`)],
      details: { skipped: true, toolName: toolCall.name },
    };
  }

  /** 构建 ToolCallContext：beforeToolCall/afterToolCall 的调用上下文 */
  private buildToolCallContext(
    toolCall: ToolCallContent,
    tool: Tool,
    args: unknown,
    request: Request,
    signal: AbortSignal,
  ): ToolCallContext {
    return {
      toolCall,
      tool,
      args,
      sessionKey: request.sessionKey ?? this._d.defaultSessionKey,
      request,
      shared: this._d.getShared() ?? new Map(),
      signal,
    };
  }

  /** 工具结果 → toolResult 消息（写入会话历史） */
  buildResultMessage(
    toolCall: ToolCallContent,
    result: ToolResult,
  ): ToolResultMessage {
    return {
      role: 'toolResult',
      content: result.content,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      isError: this.isErrorResult(result),
      timestamp: Date.now(),
    };
  }
}
