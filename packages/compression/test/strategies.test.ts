/**
 * 策略单测 - trim / summarize / truncate
 *
 * 覆盖 v1 的三个关键缺陷修复：
 *   - trim：单行大输出不再绕过（按 token 而非行数）
 *   - summarize：round-trip 契约（Message 对象）、stopReason 校验、map-reduce、pinned 再摘要
 *   - truncate：工具对整体丢弃、不动点阻塞求解
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextResource, ContentBlock, Model, StreamFn, Message, AssistantMessage } from '@aipack-ai/agent';
import { resourcesToMessages } from '@aipack-ai/agent';
import { ContextBudget } from '../src/budget';
import { TokenMeter } from '../src/token-estimator';
import { ForkRunner } from '../src/fork';
import { createSafetyState } from '../src/safety';
import { CompressionSafetyGuard } from '../src/safety';
import { loadCompressionConfig } from '../src/config';
import type { StrategyContext } from '../src/strategy';
import { TrimStrategy } from '../src/strategies/trim';
import { SummarizeStrategy } from '../src/strategies/summarize';
import { TruncateStrategy } from '../src/strategies/truncate';
import type { CompressionConfig } from '../src/config';

// ─── 测试工具 ─────────────────────────────────────────────────────

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

const mockModel: Model = {
  id: 'mock', name: 'mock', provider: 'mock',
  contextWindow: 1000, maxTokens: 2048, reasoning: false,
};

/** 记录 fork 调用的 mock streamFn */
function recordingStreamFn(
  text: string,
  opts: { stopReason?: string; fail?: boolean } = {},
): { fn: StreamFn; calls: { prompt: string }[] } {
  const calls: { prompt: string }[] = [];
  const fn: StreamFn = async function* (model, context) {
    calls.push({ prompt: `${context.systemPrompt}\n${(context.messages[0] as { content: string }).content}` });
    if (opts.fail) {
      yield { type: 'error', message: { role: 'assistant', content: [], errorMessage: 'boom' } as unknown as AssistantMessage };
      return;
    }
    yield { type: 'text_delta', delta: text };
    yield {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: opts.stopReason ?? 'stop',
        usage: { input: 10, output: 5, total: 15 },
      } as AssistantMessage,
    };
  };
  return { fn, calls };
}

/** 常用小预算：effective=1000, target=400, hardLimit=1000 */
function makeBudget(): ContextBudget {
  return new ContextBudget(1000, {
    outputReserveTokens: 0,
    safetyMarginRatio: 0,
    triggerRatio: 0.8,
    targetRatio: 0.4,
    precompressRatio: 0.7,
  });
}

function makeCtx(
  resources: ContextResource[],
  streamFn: StreamFn,
  overrides: Parameters<typeof loadCompressionConfig>[0] = {},
): { ctx: StrategyContext; config: CompressionConfig } {
  const config = loadCompressionConfig({
    // 注意：summarize 合并必须放在 ...overrides 之后，
    // 否则 overrides.summarize 会整体覆盖掉默认合并
    ...overrides,
    summarize: { minResourcesToCompress: 2, protectedRecentCount: 2, ...overrides.summarize },
  });
  const meter = new TokenMeter();
  const fork = new ForkRunner({
    streamFn,
    model: mockModel,
    meter,
    forkMaxTokens: config.summarize.forkMaxTokens,
    forkTimeoutMs: 5000,
    retry: { retries: 0, baseMs: 1, maxMs: 1 },
  });
  const ctx: StrategyContext = {
    resources,
    budget: makeBudget(),
    meter,
    safety: createSafetyState(),
    sessionKey: 'test',
    turn: 1,
    config,
    fork,
  };
  return { ctx, config };
}

// ─── Trim ─────────────────────────────────────────────────────────

test('trim: 单行巨型 tool result（minified JSON）被按 token 裁剪（v1 行数判定缺陷）', async () => {
  // v1: lines.length=1 <= 50 → 完全绕过。v2 按 token 预算裁。
  const giantJson = `{"data":"${'x'.repeat(20000)}","error":"disk full"}`;
  const tr = makeResource('tr1', 'tool_result',
    [{ type: 'text', text: giantJson }],
    { deps: ['call_1'], meta: { toolCallId: 'call_1' } });
  const a1 = makeResource('a1', 'assistant_message',
    [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: {} } as ContentBlock],
    { deps: ['call_1'] });
  const resources = [a1, tr];

  const { ctx } = makeCtx(resources, recordingStreamFn('x').fn, {
    trim: { toolResultMaxTokens: 100 },
  });
  const result = await new TrimStrategy().compress(ctx);

  const trimmed = result.resources.find(r => r.id === 'tr1')!;
  const text = (trimmed.content as ContentBlock[])[0] as { type: string; text: string };
  assert.ok(text.text.includes('已截断'), '应含截断标记');
  assert.ok(ctx.meter.estimateText(text.text) <= 100, `裁剪后应 <= 100 token，实际 ${ctx.meter.estimateText(text.text)}`);
  assert.ok(result.telemetry[0].afterTokens < result.telemetry[0].beforeTokens);
});

test('trim: 多行 tool result 保留 head/tail 与关键 error 行', async () => {
  // 300 行 × 40 字符 ≈ 3000 token，超过 target(400) 触发 trim
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(36)}`);
  lines[150] = 'ERROR: something failed';
  const tr = makeResource('tr1', 'tool_result', [{ type: 'text', text: lines.join('\n') }],
    { deps: ['call_1'], meta: { toolCallId: 'call_1' } });
  const a1 = makeResource('a1', 'assistant_message',
    [{ type: 'toolCall', id: 'call_1', name: 'sh', arguments: {} } as ContentBlock],
    { deps: ['call_1'] });

  const { ctx } = makeCtx([a1, tr], recordingStreamFn('x').fn, {
    trim: { toolResultHeadLines: 3, toolResultTailLines: 2, keyLineLimit: 2 },
  });
  const result = await new TrimStrategy().compress(ctx);
  const text = ((result.resources.find(r => r.id === 'tr1')!.content as ContentBlock[])[0] as { text: string }).text;

  assert.ok(text.includes('line 0'), '保留头');
  assert.ok(text.includes('line 299'), '保留尾');
  assert.ok(text.includes('ERROR: something failed'), '保留关键行');
  assert.ok(text.includes('已截断 295 行'), '含省略标记');
});

test('trim: tail-first 扫描 + 释放够即停 → 前缀资源原引用保留（KV cache 友好）', async () => {
  // 总量 ~2000 token、target 400：裁一个大结果（~1000→100）释放不够，
  // 需裁两个尾部大结果；最老前缀（u1/a1）不被触及，原引用保留
  const small = makeResource('u1', 'user_message', 'small');
  const a1 = makeResource('a1', 'assistant_message',
    [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: {} } as ContentBlock],
    { deps: ['call_1'] });
  const big1 = makeResource('tr1', 'tool_result', [{ type: 'text', text: 'x'.repeat(4000) }],
    { deps: ['call_1'], meta: { toolCallId: 'call_1' } });
  const a2 = makeResource('a2', 'assistant_message',
    [{ type: 'toolCall', id: 'call_2', name: 'read', arguments: {} } as ContentBlock],
    { deps: ['call_2'] });
  const big2 = makeResource('tr2', 'tool_result', [{ type: 'text', text: 'x'.repeat(4000) }],
    { deps: ['call_2'], meta: { toolCallId: 'call_2' } });
  const resources = [small, a1, big1, a2, big2];

  const { ctx } = makeCtx(resources, recordingStreamFn('x').fn, {
    trim: { toolResultMaxTokens: 100 },
  });
  const result = await new TrimStrategy().compress(ctx);

  // 前缀（small/a1）原引用保留；首个被修改的是 big1（下标 2）
  assert.equal(result.resources[0], small, '前缀资源原引用保留');
  assert.equal(result.resources[1], a1, '前缀资源原引用保留');
  assert.equal(result.prefixIntact, 2);
  // 两个尾部大结果均被裁剪（只裁一个释放不足，验证"释放够即停"不打碎前缀）
  assert.ok((result.resources[2]!.meta as { _trimmed?: boolean })._trimmed, 'big1 应被裁剪');
  assert.ok((result.resources[4]!.meta as { _trimmed?: boolean })._trimmed, 'big2 应被裁剪');
});

test('trim: pinned tool_result 不裁剪', async () => {
  const big = makeResource('tr1', 'tool_result', [{ type: 'text', text: 'y'.repeat(8000) }],
    { deps: ['call_1'], meta: { toolCallId: 'call_1' }, pinned: true });
  const a1 = makeResource('a1', 'assistant_message',
    [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: {} } as ContentBlock],
    { deps: ['call_1'] });
  const { ctx } = makeCtx([a1, big], recordingStreamFn('x').fn);
  const result = await new TrimStrategy().compress(ctx);
  assert.equal(result.telemetry.length, 0, 'pinned 不可裁 → 无操作');
  assert.equal(result.resources, ctx.resources);
});

test('trim: thinking 块剥离', async () => {
  const assistant = makeResource('a1', 'assistant_message', [
    { type: 'thinking', text: 't'.repeat(3000) },
    { type: 'text', text: 'answer' },
  ]);
  const filler = makeResource('u1', 'user_message', 'q'.repeat(1000));
  const { ctx } = makeCtx([filler, assistant], recordingStreamFn('x').fn);
  const result = await new TrimStrategy().compress(ctx);

  const blocks = result.resources.find(r => r.id === 'a1')!.content as ContentBlock[];
  assert.equal(blocks.some(b => b.type === 'thinking'), false, 'thinking 应被剥离');
  assert.equal(blocks.some(b => b.type === 'text'), true);
});

test('trim: 裁剪后 tool pairing 仍完整', async () => {
  const tr = makeResource('tr1', 'tool_result', [{ type: 'text', text: 'y'.repeat(8000) }],
    { deps: ['call_1'], meta: { toolCallId: 'call_1' } });
  const a1 = makeResource('a1', 'assistant_message',
    [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: {} } as ContentBlock],
    { deps: ['call_1'] });
  const { ctx } = makeCtx([a1, tr], recordingStreamFn('x').fn);
  const result = await new TrimStrategy().compress(ctx);

  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  assert.equal(guard.validateToolPairing(result.resources), true);
});

// ─── Summarize ────────────────────────────────────────────────────

test('summarize: round-trip 契约 - content 为完整 Message 对象，可还原 compactionSummary', async () => {
  const resources = [
    makeResource('u1', 'user_message', 'task: build calculator'),
    makeResource('a1', 'assistant_message', [{ type: 'text', text: 'ok' }]),
    makeResource('u2', 'user_message', 'step 2'),
    makeResource('a2', 'assistant_message', [{ type: 'text', text: 'done' }]),
  ];
  const { fn } = recordingStreamFn('## Context Summary\nbuilt calculator');
  const { ctx } = makeCtx(resources, fn);
  const result = await new SummarizeStrategy().compress(ctx);

  // 资源层：type/role/content
  const summaryRes = result.resources.find(r => r.type === 'compaction_summary')!;
  assert.ok(summaryRes, '应产生 compaction_summary 资源');
  assert.equal(summaryRes.role, 'compactionSummary');
  const msgObj = summaryRes.content as Message;
  assert.equal(typeof msgObj, 'object');
  assert.equal((msgObj as { role: string }).role, 'compactionSummary');
  assert.equal(typeof (msgObj as { content: string }).content, 'string');

  // round-trip：resourcesToMessages → buildContext 可消费的消息
  const messages = resourcesToMessages(result.resources);
  const summaryMsg = messages.find(m => (m as { role: string }).role === 'compactionSummary');
  assert.ok(summaryMsg, '消息层应还原出 compactionSummary role');
  assert.equal(typeof (summaryMsg as { content: string }).content, 'string', '消息 content 应为字符串');

  // v1 缺陷回归：消息数组不允许出现裸字符串/无 role 对象
  for (const m of messages) {
    assert.ok(m && typeof m === 'object', '消息必须是对象');
    assert.equal(typeof (m as { role: string }).role, 'string', '消息必须有 role');
  }
});

test('summarize: 保护区内的资源不参与摘要', async () => {
  const resources = [
    makeResource('u1', 'user_message', 'old task'),
    makeResource('a1', 'assistant_message', [{ type: 'text', text: 'old reply' }]),
    makeResource('u2', 'user_message', 'recent question'),
    makeResource('a2', 'assistant_message', [{ type: 'text', text: 'recent answer' }]),
  ];
  const { fn } = recordingStreamFn('SUMMARY');
  const { ctx } = makeCtx(resources, fn);
  const result = await new SummarizeStrategy().compress(ctx);

  const ids = result.resources.map(r => r.id);
  assert.ok(ids.includes('u2') && ids.includes('a2'), '保护区资源保留');
  assert.ok(!ids.includes('u1') && !ids.includes('a1'), '旧资源被摘要替换');
});

test('summarize: 区间内不可压资源（system_message）原样保留', async () => {
  const resources = [
    makeResource('u1', 'user_message', 'old task'),
    makeResource('sys1', 'system_message', 'important invariant', { pinned: true }),
    makeResource('a1', 'assistant_message', [{ type: 'text', text: 'old reply' }]),
    makeResource('u2', 'user_message', 'recent'),
    makeResource('a2', 'assistant_message', [{ type: 'text', text: 'recent reply' }]),
  ];
  const { fn } = recordingStreamFn('SUMMARY');
  const { ctx } = makeCtx(resources, fn);
  const result = await new SummarizeStrategy().compress(ctx);

  assert.ok(result.resources.some(r => r.id === 'sys1'), 'system_message 保留');
});

test('summarize: fork 失败 → 资源不变，记失败遥测', async () => {
  const resources = [
    makeResource('u1', 'user_message', 'a'.repeat(200)),
    makeResource('a1', 'assistant_message', [{ type: 'text', text: 'b'.repeat(200) }]),
    makeResource('u2', 'user_message', 'c'.repeat(200)),
    makeResource('a2', 'assistant_message', [{ type: 'text', text: 'd'.repeat(200) }]),
  ];
  const { fn } = recordingStreamFn('', { fail: true });
  const { ctx } = makeCtx(resources, fn);
  const result = await new SummarizeStrategy().compress(ctx);

  assert.equal(result.resources, ctx.resources, '失败不修改资源');
  assert.equal(result.telemetry[0].failed, true);
});

test('summarize: stopReason=length（输出被截断）判失败（v1 静默半截摘要缺陷）', async () => {
  const resources = [
    makeResource('u1', 'user_message', 'a'.repeat(200)),
    makeResource('a1', 'assistant_message', [{ type: 'text', text: 'b'.repeat(200) }]),
    makeResource('u2', 'user_message', 'c'.repeat(200)),
    makeResource('a2', 'assistant_message', [{ type: 'text', text: 'd'.repeat(200) }]),
  ];
  const { fn } = recordingStreamFn('half summary...', { stopReason: 'length' });
  const { ctx } = makeCtx(resources, fn);
  const result = await new SummarizeStrategy().compress(ctx);

  assert.equal(result.resources, ctx.resources, '截断的摘要不得进入上下文');
  assert.equal(result.telemetry[0].failed, true);
  assert.equal(result.telemetry[0].forkTruncated, true);
});

test('summarize: transcript 超块预算 → map-reduce 多次 fork', async () => {
  const resources: ContextResource[] = [];
  for (let i = 0; i < 8; i++) {
    resources.push(makeResource(`u${i}`, 'user_message', 'x'.repeat(400))); // ~100 token each
  }
  const { fn, calls } = recordingStreamFn('partial');
  const { ctx } = makeCtx(resources, fn, {
    summarize: { maxChunkTokens: 250 }, // 每块 ~2.5 条消息 → 4 块 → 4 map + 1 reduce
  });
  const result = await new SummarizeStrategy().compress(ctx);

  assert.ok(result.resources.some(r => r.type === 'compaction_summary'), '应产出摘要');
  assert.ok(calls.length >= 4, `应发生多次 fork（map+reduce），实际 ${calls.length}`);
});

test('summarize: pinned 旧摘要超阈值 → 并入再摘要并移除（v1 假合并只拼接不减 token）', async () => {
  const oldSummary = (id: string, text: string): ContextResource => makeResource(
    id, 'compaction_summary',
    { role: 'compactionSummary', content: text, timestamp: 0 },
    { pinned: true, role: 'compactionSummary' },
  );
  const resources = [
    oldSummary('s1', 'first summary '.repeat(50)),
    oldSummary('s2', 'second summary '.repeat(50)),
    makeResource('u1', 'user_message', 'new task'),
    makeResource('a1', 'assistant_message', [{ type: 'text', text: 'reply' }]),
    makeResource('u2', 'user_message', 'recent'),
    makeResource('a2', 'assistant_message', [{ type: 'text', text: 'recent reply' }]),
  ];
  const { fn, calls } = recordingStreamFn('merged summary');
  const { ctx } = makeCtx(resources, fn, {
    summarize: { pinnedReSummarizeRatio: 0.01 }, // 阈值 10 token，旧摘要必然超过
  });
  const result = await new SummarizeStrategy().compress(ctx);

  // 旧摘要应被合并移除，只剩一条新摘要
  const summaries = result.resources.filter(r => r.type === 'compaction_summary');
  assert.equal(summaries.length, 1, `应只剩 1 条摘要，实际 ${summaries.length}`);
  assert.ok(!result.resources.some(r => r.id === 's1' || r.id === 's2'), '旧摘要应被移除');
  // transcript 应包含旧摘要文本（置前标注）
  assert.ok(calls.some(c => c.prompt.includes('历史摘要')), 'fork 输入应包含旧摘要');
  // token 应净减少（真合并）
  assert.ok(result.telemetry[0].afterTokens < result.telemetry[0].beforeTokens);
});

test('summarize: 预压缩产物直接应用，零 fork', async () => {
  const resources = [
    makeResource('u1', 'user_message', 'old task'),
    makeResource('a1', 'assistant_message', [{ type: 'text', text: 'old reply' }]),
    makeResource('u2', 'user_message', 'recent'),
    makeResource('a2', 'assistant_message', [{ type: 'text', text: 'recent reply' }]),
  ];
  const { fn, calls } = recordingStreamFn('fresh fork');
  const { ctx } = makeCtx(resources, fn);

  ctx.precomputed = {
    sourceIds: ['u1', 'a1'],
    text: 'precomputed summary',
    forkDurationMs: 50,
    createdAtTurn: 0,
  };
  const result = await new SummarizeStrategy().compress(ctx);

  assert.equal(calls.length, 0, '不应有新 fork');
  assert.equal(result.consumedPrecomputed, true);
  const summary = result.resources.find(r => r.type === 'compaction_summary')!;
  const msg = summary.content as Message;
  assert.equal((msg as { content: string }).content, 'precomputed summary');
  assert.equal(result.telemetry[0].action, 'summarize_apply_precomputed');
});

test('summarize: precomputed sourceIds 失效 → 回退新 fork', async () => {
  const resources = [
    makeResource('u1', 'user_message', 'old task'),
    makeResource('a1', 'assistant_message', [{ type: 'text', text: 'old reply' }]),
    makeResource('u2', 'user_message', 'recent'),
    makeResource('a2', 'assistant_message', [{ type: 'text', text: 'recent reply' }]),
  ];
  const { fn, calls } = recordingStreamFn('fresh summary');
  const { ctx } = makeCtx(resources, fn);

  ctx.precomputed = {
    sourceIds: ['u1', 'a1', 'nonexistent'],
    text: 'stale summary',
    forkDurationMs: 50,
    createdAtTurn: 0,
  };
  const result = await new SummarizeStrategy().compress(ctx);

  assert.ok(calls.length >= 1, 'sourceIds 失效应触发新 fork');
  const summary = result.resources.find(r => r.type === 'compaction_summary')!;
  assert.equal(((summary.content as Message) as { content: string }).content, 'fresh summary');
});

// ─── Truncate ─────────────────────────────────────────────────────

test('truncate: 从最旧丢弃非 pinned，保留 pinned 与保护窗口', async () => {
  const resources = [
    makeResource('u1', 'user_message', 'a'.repeat(2400)), // 600 token
    makeResource('sys1', 'system_message', 'rules', { pinned: true }),
    makeResource('u2', 'user_message', 'b'.repeat(2400)), // 600 token
    makeResource('u3', 'user_message', 'c'.repeat(10)),
    makeResource('u4', 'user_message', 'd'.repeat(10)),
  ];
  const { ctx } = makeCtx(resources, recordingStreamFn('x').fn, {
    truncate: { minWorkingSet: 2 },
  });
  const result = await new TruncateStrategy().compress(ctx);

  const ids = result.resources.map(r => r.id);
  assert.ok(!ids.includes('u1'), '最旧超限资源被丢');
  assert.ok(ids.includes('sys1'), 'pinned 保留');
  assert.ok(ids.includes('u3') && ids.includes('u4'), '保护窗口（最近 2 条非 pinned）保留');
  assert.ok(result.telemetry[0].afterTokens <= 1000);
  assert.equal(result.prefixIntact, 0, '从头部丢弃 → 前缀保持 0');
});

test('truncate: 工具对整体丢弃，无悬空 tool_call', async () => {
  const pairA = [
    makeResource('a1', 'assistant_message',
      [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: {} } as ContentBlock],
      { deps: ['call_1'] }),
    makeResource('tr1', 'tool_result', [{ type: 'text', text: 'x'.repeat(2400) }],
      { deps: ['call_1'], meta: { toolCallId: 'call_1' } }),
  ];
  const pairB = [
    makeResource('a2', 'assistant_message',
      [{ type: 'toolCall', id: 'call_2', name: 'read', arguments: {} } as ContentBlock],
      { deps: ['call_2'] }),
    makeResource('tr2', 'tool_result', [{ type: 'text', text: 'y'.repeat(2400) }],
      { deps: ['call_2'], meta: { toolCallId: 'call_2' } }),
  ];
  const tail = [
    makeResource('u9', 'user_message', 'protected 1'),
    makeResource('u10', 'user_message', 'protected 2'),
  ];
  const resources = [...pairA, ...pairB, ...tail];
  const { ctx } = makeCtx(resources, recordingStreamFn('x').fn, {
    truncate: { minWorkingSet: 2 },
  });
  const result = await new TruncateStrategy().compress(ctx);

  const guard = new CompressionSafetyGuard({ maxAttempts: 5, cooldownTurns: 1 });
  assert.equal(guard.validateToolPairing(result.resources), true, '丢弃后配对必须完整');

  const ids = result.resources.map(r => r.id);
  // pairA 整体丢弃：a1 和 tr1 同进同退
  const a1Gone = !ids.includes('a1');
  const tr1Gone = !ids.includes('tr1');
  assert.equal(a1Gone, tr1Gone, 'tool 对必须同进同退');
});

test('truncate: 保护区内 tool_result 对应的发起方也不可丢（不动点阻塞传播）', async () => {
  // call_1 的 tool_result 在保护窗口内 → 整对（含发起 assistant）都不可丢
  const a1 = makeResource('a1', 'assistant_message',
    [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: {} } as ContentBlock],
    { deps: ['call_1'] });
  // 1200 token > hardLimit 1000 才会触发 truncate（500 token 不触发）
  const tr1 = makeResource('tr1', 'tool_result', [{ type: 'text', text: 'x'.repeat(4800) }],
    { deps: ['call_1'], meta: { toolCallId: 'call_1' } });
  const resources = [a1, tr1]; // tr1 是最后一条非 pinned → 在保护窗口内

  const { ctx } = makeCtx(resources, recordingStreamFn('x').fn, {
    truncate: { minWorkingSet: 2 },
  });
  const result = await new TruncateStrategy().compress(ctx);

  // 保护窗口吞掉 tr1 → a1 被阻塞 → 无可丢 → 失败遥测
  assert.equal(result.telemetry[0].failed, true);
  assert.equal(result.resources, ctx.resources);
});
