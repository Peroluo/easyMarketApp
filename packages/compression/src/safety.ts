/**
 * 安全守卫 - 配对验证、尝试限流、AbortController 管理
 *
 * v2 变化：
 *   - 移除 handoffCompleted"永久禁用压缩"语义（会话耗尽改由 lifecycle 事件交还 host，
 *     压缩器不再自我熔断到死）
 *   - 移除 compressionDepth / checkpointId 等级别瀑布遗留状态
 *   - canCompress 仅做：每 turn 尝试限流 + 失败后的短冷却退避
 */

import type { ContextResource } from '@aipack-ai/agent';
import type { CompressionTelemetry } from './telemetry';

// ─── 安全状态 ─────────────────────────────────────────────────────

export interface CompressionSafetyState {
  /** 当前 turn 内累计压缩尝试次数（跨策略累加，跨 turn 重置） */
  attemptCount: number;
  /** 上次执行压缩的 turn（用于跨 turn 时重置 attemptCount） */
  lastTurn: number;
  /** 冷却剩余 turn 数（尝试耗尽后的失败退避） */
  cooldownRemaining: number;
  /**
   * Session 级 AbortController（仅用于外部主动取消整个 session，
   * 例如 LRU 淘汰 / 用户中断）。单次 fork 超时由 createForkAbortController 管理。
   */
  sessionAbortController?: AbortController;
  /** 当前是否有 in-flight fork（用于并发安全与 LRU 淘汰保护） */
  inFlightForks: number;
  /** 遥测历史（带容量上限，见 MAX_TELEMETRY_HISTORY） */
  telemetryHistory: CompressionTelemetry[];
}

export interface CreateSafetyStateOptions {
  /** 单次 fork 调用超时（ms），默认 30000；0 表示不自动超时 */
  forkTimeoutMs?: number;
}

export function createSafetyState(
  options?: CreateSafetyStateOptions,
): CompressionSafetyState {
  void options; // forkTimeoutMs 由 ForkRunner per-fork 管理，此处仅保留接口兼容
  let sessionAbortController: AbortController | undefined;
  try {
    sessionAbortController = new AbortController();
  } catch {
    // 极老环境无 AbortController；fork 将退化到无 signal
  }

  return {
    attemptCount: 0,
    lastTurn: -1,
    cooldownRemaining: 0,
    sessionAbortController,
    inFlightForks: 0,
    telemetryHistory: [],
  };
}

/**
 * 创建一次 fork 调用的 AbortController。
 *
 * 每次 fork 独立 controller + 局部 setTimeout，结束时 clearTimeout。
 * 若 state 上有 sessionAbortController 则组合：session 级 abort 也能取消 fork。
 * 返回的 cleanup 必须在 finally 中调用。
 */
export function createForkAbortController(
  state: CompressionSafetyState,
  forkTimeoutMs: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  const sessionSignal = state.sessionAbortController?.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forkController: AbortController | undefined;

  try {
    if (sessionSignal?.aborted) {
      return { signal: sessionSignal, cleanup: () => {} };
    }

    forkController = new AbortController();

    if (forkTimeoutMs > 0) {
      timer = setTimeout(() => forkController?.abort(), forkTimeoutMs);
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
    }

    // 组合 session 与 fork 两个 signal：任一 abort 即触发
    const anyFn = (AbortSignal as any).any;
    if (anyFn && sessionSignal) {
      const combined = anyFn([sessionSignal, forkController.signal]);
      return {
        signal: combined as AbortSignal,
        cleanup: () => { if (timer) clearTimeout(timer); },
      };
    }
    if (sessionSignal) {
      // 退化路径：session abort 时同步 abort fork
      const onSessionAbort = () => forkController?.abort();
      sessionSignal.addEventListener('abort', onSessionAbort, { once: true });
      return {
        signal: forkController.signal,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          sessionSignal.removeEventListener('abort', onSessionAbort);
        },
      };
    }
    return {
      signal: forkController.signal,
      cleanup: () => { if (timer) clearTimeout(timer); },
    };
  } catch {
    return { signal: sessionSignal, cleanup: () => { if (timer) clearTimeout(timer); } };
  }
}

/**
 * 执行一次 fork 调用，自动管理 AbortController 生命周期与 in-flight 计数。
 */
export async function runFork<T>(
  state: CompressionSafetyState,
  forkTimeoutMs: number,
  fn: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  const { signal, cleanup } = createForkAbortController(state, forkTimeoutMs);
  state.inFlightForks++;
  try {
    return await fn(signal);
  } finally {
    cleanup();
    state.inFlightForks = Math.max(0, state.inFlightForks - 1);
  }
}

/** 取消整个 session（LRU 淘汰 / 用户主动中断时调用） */
export function abortSafetyState(state: CompressionSafetyState): void {
  state.sessionAbortController?.abort();
}

/** 该 session 是否有进行中的 fork（LRU 淘汰前检查） */
export function hasInFlightForks(state: CompressionSafetyState): boolean {
  return state.inFlightForks > 0;
}

// ─── 安全守卫 ─────────────────────────────────────────────────────

export interface SafetyConfig {
  /** 单 turn 内最大压缩尝试次数 */
  maxAttempts: number;
  /** 尝试耗尽后冷却 turn 数 */
  cooldownTurns: number;
  /** fork 调用超时（ms） */
  forkTimeoutMs?: number;
}

export class CompressionSafetyGuard {
  constructor(private config: SafetyConfig) {}

  /**
   * 是否允许执行压缩。
   * - 跨 turn 重置尝试计数
   * - 冷却期间拒绝；冷却结束后恢复
   * - 单 turn 尝试耗尽 → 进入冷却
   *
   * 注意：不再有"永久禁用"。会话级兜底由 lifecycle 耗尽事件交还 host 处理。
   */
  canCompress(state: CompressionSafetyState, turn: number): boolean {
    // 跨 turn 边界：重置本 turn 的尝试计数
    if (state.lastTurn !== turn) {
      state.lastTurn = turn;
      state.attemptCount = 0;
    }

    if (state.cooldownRemaining > 0) {
      state.cooldownRemaining--;
      return false;
    }

    if (state.attemptCount >= this.config.maxAttempts) {
      state.cooldownRemaining = this.config.cooldownTurns;
      return false;
    }

    return true;
  }

  /** 记录一次尝试 */
  recordAttempt(state: CompressionSafetyState): void {
    state.attemptCount++;
  }

  /**
   * 验证 tool_call / tool_result 配对完整性（双向）：
   *  1. 每个 tool_result 的 toolCallId 必须有对应发起方
   *  2. 每个发起方 toolCallId 必须有对应 tool_result（否则悬空 tool_call）
   *
   * 权威标记：`meta.toolCallId`；回退标记：`dependencies`。
   */
  validateToolPairing(resources: ContextResource[]): boolean {
    const initiatorCallIds = new Set<string>();
    const resultCallIds = new Set<string>();

    for (const r of resources) {
      const metaCallId = r.meta?.toolCallId as string | undefined;

      if (r.type === 'tool_result') {
        const callId = metaCallId ?? r.dependencies[0];
        if (callId) resultCallIds.add(callId);
      } else if (r.type === 'tool_call') {
        const callId = metaCallId ?? r.dependencies[0] ?? r.id;
        if (callId) initiatorCallIds.add(callId);
      } else if (r.type === 'assistant_message') {
        if (metaCallId) initiatorCallIds.add(metaCallId);
        for (const dep of r.dependencies) initiatorCallIds.add(dep);
        for (const id of extractToolCallIdsFromContent(r.content)) initiatorCallIds.add(id);
      }
    }

    // 规则 1：每个 tool_result 必须有发起方
    for (const callId of resultCallIds) {
      if (!initiatorCallIds.has(callId)) return false;
    }

    // 规则 2：每个发起方必须有 tool_result
    for (const callId of initiatorCallIds) {
      if (!resultCallIds.has(callId)) return false;
    }

    return true;
  }
}

// ─── 工具配对辅助 ─────────────────────────────────────────────────

/** 构建 toolCallId -> tool_result ids 映射 */
export function buildToolPairMap(resources: ContextResource[]): Map<string, string[]> {
  const pairs = new Map<string, string[]>();

  for (const r of resources) {
    if (r.type === 'tool_result') {
      for (const dep of r.dependencies) {
        if (!pairs.has(dep)) pairs.set(dep, []);
        pairs.get(dep)!.push(r.id);
      }
    }
  }

  return pairs;
}

/** 检查资源是否属于完整的工具对 */
export function isToolPairComplete(
  resource: ContextResource,
  resources: ContextResource[],
  pairMap: Map<string, string[]>,
): boolean {
  if (resource.type === 'assistant_message') {
    // assistant_message 的 dependencies 是 toolCallId，须有对应 tool_result
    return resource.dependencies.every(depId => pairMap.has(depId));
  }
  if (resource.type === 'tool_result') {
    // tool_result 须有发起方（assistant_message 或 tool_call 引用该 toolCallId）
    return resource.dependencies.every(depId =>
      resources.some(r =>
        (r.type === 'assistant_message' || r.type === 'tool_call')
        && r.dependencies.includes(depId),
      ),
    );
  }
  return true;
}

/**
 * 从 assistant_message.content 中提取 ToolCallContent 的 id。
 */
function extractToolCallIdsFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: unknown; id?: unknown };
      if (b.type === 'toolCall' && typeof b.id === 'string') {
        ids.push(b.id);
      }
    }
  }
  return ids;
}
