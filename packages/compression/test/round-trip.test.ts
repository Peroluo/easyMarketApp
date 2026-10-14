/**
 * Round-trip 契约测试 - v1 最严重缺陷的回归防线
 *
 * v1 的 L2/L3/L4 产出 type='compaction_summary'/'custom' 的资源，
 * resourceToMessage 的 default 分支把裸字符串/无 role 对象当 Message 返回，
 * 消息数组混入字符串后 buildContext/provider 崩溃。
 * v1 的测试直接调 compress() 绕过了这条路径，所以从未暴露。
 *
 * 本测试驱动 transformer 全流程后，把输出过 resourcesToMessages：
 *   1. 每条消息必须是对象且 role 为已知合法值
 *   2. 摘要资源必须还原为 role='compactionSummary' 的消息（content 为字符串）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextResource, Model, StreamFn, AssistantMessage } from '@aipack-ai/agent';
import { resourcesToMessages } from '@aipack-ai/agent';
import {
  createCompressionTransformer,
  loadCompressionConfig,
} from '../index';
import type { TransformContext } from '@aipack-ai/agent';

// ─── 工具 ─────────────────────────────────────────────────────────

function makeResource(
  id: string,
  type: ContextResource['type'],
  content: unknown,
  opts: { deps?: string[]; pinned?: boolean; role?: string; meta?: Record<string, unknown> } = {},
): ContextResource {
  return {
    id,
    type,
    role: opts.role ?? (
      type === 'assistant_message' ? 'assistant'
      : type === 'user_message' ? 'user'
      : type === 'tool_result' ? 'toolResult'
      : 'system'
    ),
    content,
    timestamp: Date.now() + Math.random(),
    dependencies: opts.deps ?? [],
    meta: opts.meta ?? {},
    pinned: opts.pinned ?? false,
  };
}

function makeCtx(sessionKey: string, turn: number): TransformContext {
  return {
    graph: {} as any,
    runtime: { sessionKey, turn },
  };
}

const mockModel: Model = {
  id: 'mock', name: 'mock', provider: 'mock',
  contextWindow: 1000, maxTokens: 2048, reasoning: false,
};

const streamFn: StreamFn = async function* () {
  yield { type: 'text_delta', delta: '## Context Summary\n用户要求构建计算器，已完成加减模块。' };
  yield {
    type: 'done',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'summary' }],
      stopReason: 'stop',
      usage: { input: 10, output: 5, total: 15 },
    } as AssistantMessage,
  };
};

/** agent 运行时合法的消息 role 集合（含内部扩展 role） */
const KNOWN_ROLES = new Set(['user', 'assistant', 'toolResult', 'system', 'compactionSummary', 'stateSnapshot']);

function assertRoundTripSafe(resources: ContextResource[]): void {
  const messages = resourcesToMessages(resources);
  for (const m of messages) {
    assert.ok(m && typeof m === 'object',
      `消息必须是对象（v1 会混入裸字符串）：${JSON.stringify(m)?.slice(0, 80)}`);
    const role = (m as { role?: unknown }).role;
    assert.ok(typeof role === 'string',
      `消息必须有字符串 role：${JSON.stringify(m)?.slice(0, 80)}`);
    assert.ok(KNOWN_ROLES.has(role),
      `role 必须是已知值（实际 "${role}"）——未知 role 会原样透传给 provider`);
    assert.ok('content' in m, '消息必须有 content 字段');
  }
}

// ─── 端到端：压缩后的资源必须能安全回程 ───────────────────────────

test('round-trip: summarize 压缩后的资源可安全 resourcesToMessages（v1 P0 回归）', async () => {
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.05, targetRatio: 0.02 },
      summarize: { minResourcesToCompress: 2, protectedRecentCount: 2, forkMaxTokens: 100 },
    }),
    model: mockModel,
    streamFn,
    contextWindow: 1000,
  });

  const resources = [
    makeResource('u1', 'user_message', 'task: build calculator'),
    makeResource('a1', 'assistant_message', [
      { type: 'thinking', text: 't'.repeat(200) },
      { type: 'text', text: 'starting' },
    ]),
    makeResource('tc1', 'tool_call', { toolName: 'read', args: {} }, { deps: ['call_1'] }),
    makeResource('tr1', 'tool_result', [{ type: 'text', text: 'file content '.repeat(20) }],
      { deps: ['call_1'], meta: { toolCallId: 'call_1' } }),
    makeResource('sys1', 'system_message', 'invariant rules', { pinned: true }),
    makeResource('u2', 'user_message', 'continue'),
    makeResource('a2', 'assistant_message', [{ type: 'text', text: 'reply' }]),
  ];
  const out = await transformer.transform(resources, makeCtx('rt-summarize', 1));

  // 压缩确实发生了（存在摘要资源）
  assert.ok(out.some(r => r.type === 'compaction_summary'), '应产出 compaction_summary');
  // round-trip 安全
  assertRoundTripSafe(out);

  // 摘要消息还原验证
  const messages = resourcesToMessages(out);
  const summaryMsg = messages.find(m => (m as { role: string }).role === 'compactionSummary');
  assert.ok(summaryMsg, '应还原出 compactionSummary 消息');
  assert.equal(typeof (summaryMsg as { content: unknown }).content, 'string');
});

test('round-trip: trim 压缩后的资源可安全回程', async () => {
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.8, targetRatio: 0.4 },
      trim: { toolResultMaxTokens: 50 },
    }),
    model: mockModel,
    streamFn,
    contextWindow: 1000,
  });

  const resources = [
    makeResource('a1', 'assistant_message',
      [{ type: 'toolCall', id: 'call_1', name: 'sh', arguments: {} }], { deps: ['call_1'] }),
    makeResource('tr1', 'tool_result',
      // 500 行 ≈ 1060 token > 800 触发线（300 行 ≈ 675 token 不触发）
      [{ type: 'text', text: Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') }],
      { deps: ['call_1'], meta: { toolCallId: 'call_1' } }),
    makeResource('u9', 'user_message', 'recent'),
    makeResource('u10', 'user_message', 'latest'),
  ];
  const out = await transformer.transform(resources, makeCtx('rt-trim', 1));

  const trimmed = out.find(r => r.id === 'tr1')!;
  assert.ok((trimmed.meta as { _trimmed?: boolean })._trimmed, 'trim 应已裁剪');
  assertRoundTripSafe(out);
});

test('round-trip: truncate 后的资源可安全回程且配对完整', async () => {
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.8, targetRatio: 0.4 },
    }),
    model: mockModel,
    streamFn,
    contextWindow: 1000,
  });

  const pair = (n: number) => ([
    makeResource(`a${n}`, 'assistant_message',
      [{ type: 'toolCall', id: `call_${n}`, name: 'read', arguments: {} }], { deps: [`call_${n}`] }),
    makeResource(`tr${n}`, 'tool_result', [{ type: 'text', text: 'x'.repeat(2400) }],
      { deps: [`call_${n}`], meta: { toolCallId: `call_${n}` } }),
  ]);
  const resources = [
    ...pair(1), ...pair(2),
    makeResource('u9', 'user_message', 'protected 1'),
    makeResource('u10', 'user_message', 'protected 2'),
  ];
  const out = await transformer.transform(resources, makeCtx('rt-truncate', 1));

  assert.ok(out.length < resources.length, 'truncate 应丢弃资源');
  assertRoundTripSafe(out);

  // toolResult 消息的 toolCallId 仍指向存在的发起方
  const messages = resourcesToMessages(out);
  const toolResults = messages.filter(m => (m as { role: string }).role === 'toolResult') as
    Array<{ role: 'toolResult'; toolCallId: string }>;
  const initiatorIds = new Set(
    out.filter(r => r.type === 'assistant_message' || r.type === 'tool_call')
      .flatMap(r => [r.meta?.toolCallId as string | undefined ?? r.id, ...r.dependencies]),
  );
  for (const tr of toolResults) {
    assert.ok(initiatorIds.has(tr.toolCallId), `toolCallId ${tr.toolCallId} 必须有发起方`);
  }
});
