/**
 * Result - 运行结果
 *
 * Result 代表 Agent 一次运行的最终产物，
 * 包含输出内容、使用的工具、元数据、以及资源快照。
 */

import type { ContextResource } from './context-resource';

// ─── 结果接口 ─────────────────────────────────────────────────────

export interface Result {
  /** 输出内容（最终回复文本） */
  readonly content: string;
  /** 使用的工具列表 */
  readonly toolsUsed: string[];
  /** Token 用量统计 */
  readonly usage: Record<string, number>;
  /** 停止原因 */
  readonly stopReason: string;
  /** 元数据 */
  readonly metadata: Record<string, unknown>;
  /** 错误信息（运行失败时） */
  readonly error?: string;
  /** 是否成功 */
  readonly success: boolean;
  /** 资源快照（运行结束时的上下文资源） */
  readonly resources?: ContextResource[];
}

// ─── 结果构建器 ───────────────────────────────────────────────────

export class ResultBuilder {
  private _content: string = '';
  private _toolsUsed: string[] = [];
  private _usage: Record<string, number> = {};
  private _stopReason: string = 'completed';
  private _metadata: Record<string, unknown> = {};
  private _error?: string;
  private _success: boolean = true;
  private _resources?: ContextResource[];

  content(c: string): this {
    this._content = c;
    return this;
  }

  toolsUsed(tools: string[]): this {
    this._toolsUsed = tools;
    return this;
  }

  addTool(tool: string): this {
    if (!this._toolsUsed.includes(tool)) {
      this._toolsUsed.push(tool);
    }
    return this;
  }

  usage(u: Record<string, number>): this {
    this._usage = u;
    return this;
  }

  stopReason(r: string): this {
    this._stopReason = r;
    return this;
  }

  metadata(key: string, value: unknown): this;
  metadata(map: Record<string, unknown>): this;
  metadata(keyOrMap: string | Record<string, unknown>, value?: unknown): this {
    if (typeof keyOrMap === 'string') {
      this._metadata[keyOrMap] = value;
    } else {
      this._metadata = { ...this._metadata, ...keyOrMap };
    }
    return this;
  }

  error(e?: string): this {
    if (e !== undefined) {
      this._error = e;
      this._success = false;
      this._stopReason = 'error';
    }
    return this;
  }

  resources(res: ContextResource[]): this {
    this._resources = res;
    return this;
  }

  build(): Result {
    return {
      content: this._content,
      toolsUsed: this._toolsUsed,
      usage: this._usage,
      stopReason: this._stopReason,
      metadata: this._metadata,
      error: this._error,
      success: this._success,
      resources: this._resources,
    };
  }
}

// ─── 流式事件接口 ─────────────────────────────────────────────────

export interface ResultChunk {
  /** 块类型 */
  type: 'text' | 'tool_start' | 'tool_end' | 'thinking' | 'error' | 'done';
  /** 内容 */
  content?: string;
  /** 工具名称（tool 类型） */
  toolName?: string;
  /** 工具调用 ID */
  toolCallId?: string;
  /** 工具调用参数（tool_start；供前端展示参数摘要，如 bash 命令、文件路径） */
  args?: unknown;
  /** 是否错误 */
  isError?: boolean;
  /** done 类型：最终 Result 摘要（usage / stopReason / toolsUsed 等，供调用方统计展示） */
  result?: Result;
}

// ─── 工厂函数 ─────────────────────────────────────────────────────

export function createResult(content: string, options?: Partial<Result>): Result {
  return {
    content,
    toolsUsed: options?.toolsUsed ?? [],
    usage: options?.usage ?? {},
    stopReason: options?.stopReason ?? 'completed',
    metadata: options?.metadata ?? {},
    error: options?.error,
    success: options?.success ?? !options?.error,
    resources: options?.resources,
  };
}

export function createErrorResult(error: string): Result {
  return new ResultBuilder()
    .error(error)
    .build();
}
