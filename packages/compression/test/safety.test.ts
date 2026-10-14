/**
 * Safety guard 单测 - 覆盖熔断器状态机、配对验证、AbortController
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompressionSafetyGuard,
  createSafetyState,
  abortSafetyState,
  buildToolPairMap,
  isToolPairComplete,
  createForkAbortController,
  runFork,
} from '../src/safety';
import type { ContextResource } from '@aipack-ai/agent';

function makeResource(
  id: string,
  type: ContextResource['type'],
  deps: string[] = [],
): ContextResource {
  return {
    id,
    type,
    role: 'system',
    content: '',
    timestamp: 0,
    dependencies: deps,
    meta: {},
    pinned: false,
  };
}

test('canCompress: 跨 turn 重置 attemptCount', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 2, cooldownTurns: 5 });
  const state = createSafetyState({ forkTimeoutMs: 0 });

  // turn 1: 允许压缩，累积 2 次后进入冷却
  assert.equal(guard.canCompress(state, 1), true);
  guard.recordAttempt(state);
  assert.equal(guard.canCompress(state, 1), true);
  guard.recordAttempt(state);
  // 第 3 次应被拒（attempt 耗尽）并进入冷却
  assert.equal(guard.canCompress(state, 1), false);
  assert.equal(state.cooldownRemaining, 5);

  // turn 1 内继续调用：仍在冷却，递减
  assert.equal(guard.canCompress(state, 1), false);
  assert.equal(state.cooldownRemaining, 4);

  // turn 2: 跨 turn 重置 attempt，但冷却期内继续拒绝
  assert.equal(guard.canCompress(state, 2), false);
});

test('canCompress: cooldown 耗尽后恢复', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 1, cooldownTurns: 2 });
  const state = createSafetyState({ forkTimeoutMs: 0 });

  // turn 1: 1 次即耗尽
  assert.equal(guard.canCompress(state, 1), true);
  guard.recordAttempt(state);
  assert.equal(guard.canCompress(state, 1), false);
  assert.equal(state.cooldownRemaining, 2);

  // 模拟跨 turn 调用，每次 cooldown 递减
  guard.canCompress(state, 2); // cooldown 2->1
  guard.canCompress(state, 3); // cooldown 1->0，但仍返回 false（在递减分支）
  // 下一次：cooldown 已为 0，恢复允许
  assert.equal(guard.canCompress(state, 4), true);
});

test('canCompress: v2 不再有"永久禁用"——同 turn 内耗尽后拒绝，新 turn 冷却后恢复', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 3, cooldownTurns: 1 });
  const state = createSafetyState({ forkTimeoutMs: 0 });

  for (let i = 0; i < 3; i++) {
    assert.equal(guard.canCompress(state, 10), true, `第 ${i + 1} 次应允许`);
    guard.recordAttempt(state);
  }
  // 耗尽后同 turn 拒绝
  assert.equal(guard.canCompress(state, 10), false);
  // 新 turn：attempt 重置，冷却 1 递减后仍拒绝
  assert.equal(guard.canCompress(state, 11), false);
  // 冷却结束，恢复
  assert.equal(guard.canCompress(state, 12), true);
});

test('createSafetyState: sessionAbortController 总是存在且不自动 abort', () => {
  // P0#1 修复：createSafetyState 不再启动超时 timer（那会导致 30s 后永久 abort 整个 session）。
  // sessionAbortController 仅用于外部主动取消（LRU 淘汰 / 用户中断）。
  const state = createSafetyState({ forkTimeoutMs: 100 });
  assert.ok(state.sessionAbortController, 'sessionAbortController 应被创建');
  assert.equal(state.sessionAbortController?.signal.aborted, false);
  assert.equal(state.inFlightForks, 0);

  // 等待超过 forkTimeoutMs：session 级 controller 不应被自动 abort
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(state.sessionAbortController?.signal.aborted, false, 'session 级不应自动 abort');
      resolve();
    }, 150);
  });
});

test('createForkAbortController: 单次 fork 超时自动 abort', () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  const { signal, cleanup } = createForkAbortController(state, 50);
  assert.ok(signal, '应返回 signal');

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(signal!.aborted, true, '单次 fork 超过 50ms 应被 abort');
      cleanup();
      resolve();
    }, 80);
  });
});

test('createForkAbortController: cleanup 后不再触发 abort', () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  const { signal, cleanup } = createForkAbortController(state, 50);
  assert.equal(signal!.aborted, false);
  cleanup(); // 模拟 fork 正常结束

  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(signal!.aborted, false, 'cleanup 后不应再触发 abort');
      resolve();
    }, 80);
  });
});

test('createForkAbortController: forkTimeoutMs=0 不自动超时', () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  const { signal, cleanup } = createForkAbortController(state, 0);
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(signal!.aborted, false, 'forkTimeoutMs=0 不应自动 abort');
      cleanup();
      resolve();
    }, 50);
  });
});

test('createForkAbortController: session abort 时 fork signal 同步 abort', () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  const { signal, cleanup } = createForkAbortController(state, 5000);
  assert.equal(signal!.aborted, false);
  abortSafetyState(state);
  assert.equal(signal!.aborted, true, 'session abort 后 fork signal 应同步 abort');
  cleanup();
});

test('runFork: 自动管理 inFlightForks 计数', async () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  const result = await runFork(state, 5000, async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(state.inFlightForks, 0, 'fork 结束后 inFlightForks 应归零');
});

test('runFork: fork 抛错时 inFlightForks 仍归零', async () => {
  const state = createSafetyState({ forkTimeoutMs: 0 });
  await assert.rejects(runFork(state, 5000, async () => { throw new Error('boom'); }));
  assert.equal(state.inFlightForks, 0, '异常路径 inFlightForks 也应归零');
});

test('abortSafetyState: 主动 abort session', () => {
  const state = createSafetyState({ forkTimeoutMs: 1000 });
  assert.equal(state.sessionAbortController?.signal.aborted, false);
  abortSafetyState(state);
  assert.equal(state.sessionAbortController?.signal.aborted, true);
});

test('validateToolPairing: 完整配对通过', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResource('a1', 'assistant_message', ['call_1']),
    makeResource('tr1', 'tool_result', ['call_1']),
  ];
  assert.equal(guard.validateToolPairing(resources), true);
});

test('validateToolPairing: 悬空 tool_result 失败', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResource('a1', 'assistant_message', ['call_other']),
    makeResource('tr1', 'tool_result', ['call_1']), // 没有对应 assistant_message
  ];
  assert.equal(guard.validateToolPairing(resources), false);
});

test('validateToolPairing: tool_call 类型资源也能匹配', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResource('tc1', 'tool_call', ['call_1']),
    makeResource('tr1', 'tool_result', ['call_1']),
  ];
  assert.equal(guard.validateToolPairing(resources), true);
});

test('validateToolPairing: 无 tool_result 时通过', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResource('u1', 'user_message'),
    makeResource('a1', 'assistant_message'),
  ];
  assert.equal(guard.validateToolPairing(resources), true);
});

test('buildToolPairMap + isToolPairComplete: 完整对返回 true', () => {
  const resources = [
    makeResource('a1', 'assistant_message', ['call_1']),
    makeResource('tr1', 'tool_result', ['call_1']),
  ];
  const map = buildToolPairMap(resources);
  assert.equal(isToolPairComplete(resources[0], resources, map), true);
  assert.equal(isToolPairComplete(resources[1], resources, map), true);
});

test('isToolPairComplete: assistant_message 无对应 tool_result 返回 false', () => {
  const resources = [
    makeResource('a1', 'assistant_message', ['call_1']),
  ];
  const map = buildToolPairMap(resources);
  assert.equal(isToolPairComplete(resources[0], resources, map), false);
});

// ─── P0#3 双向校验补充 ───────────────────────────────────────────

/** 构造带 meta.toolCallId 的资源（模拟框架权威标记） */
function makeResourceWithMeta(
  id: string,
  type: ContextResource['type'],
  toolCallId: string,
): ContextResource {
  return {
    id,
    type,
    role: 'system',
    content: '',
    timestamp: 0,
    dependencies: [], // 故意留空，验证 meta 权威
    meta: { toolCallId },
    pinned: false,
  };
}

test('validateToolPairing: assistant_message 有 toolCallId 依赖但无 tool_result 失败（悬空 tool_call）', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResource('a1', 'assistant_message', ['call_1']), // 发起方，但无对应 tool_result
  ];
  assert.equal(guard.validateToolPairing(resources), false);
});

test('validateToolPairing: meta.toolCallId 权威标记 - 完整配对通过', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  // assistant_message 与 tool_result 都用 meta.toolCallId 标记同一 call
  const resources = [
    makeResourceWithMeta('a1', 'assistant_message', 'call_1'),
    makeResourceWithMeta('tr1', 'tool_result', 'call_1'),
  ];
  assert.equal(guard.validateToolPairing(resources), true);
});

test('validateToolPairing: meta.toolCallId 权威标记 - tool_result 无发起方失败', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResourceWithMeta('tr1', 'tool_result', 'call_1'), // tool_result 无对应发起方
  ];
  assert.equal(guard.validateToolPairing(resources), false);
});

test('validateToolPairing: meta.toolCallId 权威标记 - 悬空发起方失败', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResourceWithMeta('a1', 'assistant_message', 'call_1'), // 发起方无 tool_result
  ];
  assert.equal(guard.validateToolPairing(resources), false);
});

test('validateToolPairing: assistant_message 纯文本（无 toolCallId）通过', () => {
  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  const resources = [
    makeResource('u1', 'user_message'),
    makeResource('a1', 'assistant_message'), // 纯文本回复
  ];
  assert.equal(guard.validateToolPairing(resources), true);
});
