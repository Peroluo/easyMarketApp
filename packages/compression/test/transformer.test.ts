/**
 * ContextCompressionTransformer 集成测试
 *
 * 覆盖：双水位调度、策略编排、真互斥、后台预压缩、dryRun、
 *       耗尽事件、遥测上报、配置校验
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextResource, Model, StreamFn, AssistantMessage } from '@aipack-ai/agent';
import {
  createCompressionTransformer,
  loadCompressionConfig,
  validateConfig,
  TELEMETRY_SHARED_KEY,
} from '../index';
import type { CompressionTelemetry, ContextExhaustedEvent } from '../index';
import type { TransformContext } from '@aipack-ai/agent';

// ─── 工具 ─────────────────────────────────────────────────────────

function makeResource(
  id: string,
  type: ContextResource['type'],
  content: unknown,
  opts: { deps?: string[]; pinned?: boolean; role?: string } = {},
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
    meta: {},
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

/** 记录调用的 mock streamFn（可注入延迟以测试并发） */
function streamFnRecorder(
  text: string,
  opts: { delayMs?: number; fail?: boolean; stopReason?: string } = {},
): { fn: StreamFn; calls: string[] } {
  const calls: string[] = [];
  const fn: StreamFn = async function* (_m, _ctx, streamOptions) {
    calls.push(streamOptions?.sessionId ?? 'unknown');
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
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

/** 'x'.repeat(n) 的 user 消息（n/4 token） */
function userMsg(id: string, tokens: number): ContextResource {
  return makeResource(id, 'user_message', 'x'.repeat(tokens * 4));
}

// ─── 构造校验 ─────────────────────────────────────────────────────

test('transformer: contextWindow=0 / NaN 抛错', () => {
  for (const bad of [0, NaN, -1]) {
    assert.throws(() => createCompressionTransformer({
      config: loadCompressionConfig(),
      model: mockModel,
      streamFn: streamFnRecorder('x').fn,
      contextWindow: bad,
    }), /Invalid contextWindow/);
  }
});

test('transformer: 配置非法（target>=trigger）时启动 warn 不抛错', () => {
  // console.warn 捕获由全局处理；此处只验证不抛错 + validateConfig 检出
  const cfg = loadCompressionConfig({
    budget: { targetRatio: 0.9, triggerRatio: 0.8 },
  });
  const errors = validateConfig(cfg);
  assert.ok(errors.some(e => e.path === 'budget.targetRatio'));
  assert.doesNotThrow(() => createCompressionTransformer({
    config: cfg,
    model: mockModel,
    streamFn: streamFnRecorder('x').fn,
    contextWindow: 1000,
  }));
});

// ─── 开关与 dryRun ────────────────────────────────────────────────

test('transformer: enabled=false 原样返回', async () => {
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({ enabled: false }),
    model: mockModel,
    streamFn: streamFnRecorder('x').fn,
    contextWindow: 1000,
  });
  const resources = [userMsg('u1', 900)];
  const out = await transformer.transform(resources, makeCtx('s1', 1));
  assert.equal(out, resources);
});

test('transformer: dryRun 不修改资源，遥测报告将触发的阶段', async () => {
  const reported: CompressionTelemetry[] = [];
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      dryRun: true,
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.05, targetRatio: 0.02 },
    }),
    model: mockModel,
    streamFn: streamFnRecorder('x').fn,
    contextWindow: 1000,
    telemetryReporter: { report: t => reported.push(t) },
  });
  const resources = [userMsg('u1', 100)];
  const out = await transformer.transform(resources, makeCtx('s1', 1));

  assert.equal(out, resources, 'dryRun 不修改');
  assert.ok(reported.some(t => t.stage === 'dry_run'), '应有 dry_run 遥测');
  const dry = reported.find(t => t.stage === 'dry_run')!;
  assert.ok(dry.message?.includes('trim'), '应标注会运行 trim');
});

// ─── 压缩主流程 ───────────────────────────────────────────────────

test('transformer: 超高水位触发 trim→summarize，token 下降且遥测上报', async () => {
  const reported: CompressionTelemetry[] = [];
  const { fn, calls } = streamFnRecorder('## Context Summary\nall done');
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.05, targetRatio: 0.02 },
      summarize: { minResourcesToCompress: 2, protectedRecentCount: 2, forkMaxTokens: 100 },
    }),
    model: mockModel,
    streamFn: fn,
    contextWindow: 1000,
    telemetryReporter: { report: t => reported.push(t) },
  });

  // 4 条消息 ~50 token；trigger 50 → 触发；fork 输入预算 1000-100-512=388 → 单块
  const resources = [
    userMsg('u1', 50), userMsg('u2', 50), userMsg('u3', 50), userMsg('u4', 50),
  ];
  const out = await transformer.transform(resources, makeCtx('compact-1', 1));

  const stages = new Set(reported.map(t => t.stage));
  assert.ok(stages.has('summarize'), `应触发 summarize（实际: ${[...stages].join(',')}）`);

  const sumT = reported.find(t => t.stage === 'summarize')!;
  assert.ok(sumT.afterTokens < sumT.beforeTokens, 'token 应净下降');
  assert.ok(out.some(r => r.type === 'compaction_summary'), '产出摘要资源');
  assert.ok(out.some(r => r.id === 'u4'), '保护区资源保留');
  assert.ok(calls.length >= 1, '应有 fork 调用');
  assert.equal(sumT.messageCountBefore, 4);
});

test('transformer: 巨型 tool result 由 trim 按 token 裁剪（请求路径零 fork）', async () => {
  const { fn, calls } = streamFnRecorder('summary');
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.8, targetRatio: 0.4 },
      trim: { toolResultMaxTokens: 100 },
    }),
    model: mockModel,
    streamFn: fn,
    contextWindow: 1000,
  });

  const big = makeResource('tr1', 'tool_result',
    [{ type: 'text', text: `{"data":"${'x'.repeat(8000)}"}` }],
    { deps: ['call_1'] });
  const a1 = makeResource('a1', 'assistant_message',
    [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: {} }], { deps: ['call_1'] });
  const tail = [userMsg('u9', 5), userMsg('u10', 5)];

  const out = await transformer.transform([a1, big, ...tail], makeCtx('trim-only', 1));
  const trimmed = (out.find(r => r.id === 'tr1')!.content as { text: string }[])[0];
  assert.ok(trimmed.text.includes('已截断'), 'trim 应裁剪');
  assert.equal(calls.length, 0, 'trim 达标不应有 fork');
});

// ─── 后台预压缩 ───────────────────────────────────────────────────

test('transformer: 预压缩区间启动后台摘要，高水位应用时零新 fork', async () => {
  const { fn, calls } = streamFnRecorder('precomputed summary');
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.8, targetRatio: 0.4 },
      summarize: { minResourcesToCompress: 2, protectedRecentCount: 2, forkMaxTokens: 200 },
    }),
    model: mockModel,
    streamFn: fn,
    contextWindow: 1000,
  });

  // Run 1: 总量 ~746 token ∈ [700, 800) 预警区间。
  // 可压缩区（13 条小消息）transcript 仅 ~26 token，低于 fork 输入预算（288）→ 单次 fork
  const run1 = [
    ...Array.from({ length: 13 }, (_, i) => userMsg(`u${i}`, 2)),
    userMsg('p1', 360), // 保护窗口（最近 2 条）
    userMsg('p2', 360),
  ];
  const out1 = await transformer.transform(run1, makeCtx('precomp', 1));
  assert.equal(out1, run1, '预警区间不修改资源');

  // 等后台 fork 完成
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls.length, 1, '后台应发生 1 次 fork');

  // Run 2: 追加消息 → 超过高水位 800 → 压缩；summarize 应消费预压缩产物
  const run2 = [...run1, userMsg('u_new', 100)];
  const out2 = await transformer.transform(run2, makeCtx('precomp', 2));

  assert.ok(out2.some(r => r.type === 'compaction_summary'), '应产出摘要');
  assert.equal(calls.length, 1, '高水位应直接应用预压缩产物，不再 fork');
});

// ─── 互斥 ─────────────────────────────────────────────────────────

test('transformer: 同 session 并发 run 真互斥（后到者等待前者完成）', async () => {
  // fork 带 60ms 延迟：若互斥失效，两个 run 的 fork 会交错
  const { fn, calls } = streamFnRecorder('summary', { delayMs: 60 });
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.05, targetRatio: 0.02 },
      summarize: { minResourcesToCompress: 2, protectedRecentCount: 0, forkMaxTokens: 100 },
      safety: { retry: { retries: 0, baseMs: 1, maxMs: 1 } },
    }),
    model: mockModel,
    streamFn: fn,
    contextWindow: 1000,
  });

  const resA = [userMsg('a1', 50), userMsg('a2', 50)];
  const resB = [userMsg('b1', 50), userMsg('b2', 50)];

  // 并发发起；turn 区分两次 run
  const [outA, outB] = await Promise.all([
    transformer.transform(resA, makeCtx('mutex', 1)),
    transformer.transform(resB, makeCtx('mutex', 2)),
  ]);

  assert.equal(calls.length, 2, '两次 run 各一次 fork');
  // 互斥：turn1 的 fork 必须全部先于 turn2 的 fork（sessionId 含 turn 号）
  const turns = calls.map(id => id.match(/#t(\d+)$/)?.[1]);
  assert.ok(turns[0] === '1' && turns[1] === '2',
    `fork 应按 run 顺序串行（实际 ${turns.join(',')}）`);
  assert.ok(outA !== outB);
});

// ─── 上下文耗尽事件 ───────────────────────────────────────────────

test('transformer: pinned 全量超限 → truncate 无可丢 → 发出耗尽事件（不永久禁用）', async () => {
  const events: ContextExhaustedEvent[] = [];
  const { fn, calls } = streamFnRecorder('HANDOFF: continue the task');
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.8, targetRatio: 0.4 },
    }),
    model: mockModel,
    streamFn: fn,
    contextWindow: 1000,
  });
  transformer.onContextExhausted(e => { events.push(e); });

  const resources = [
    makeResource('sys1', 'system_message', 'y'.repeat(4000), { pinned: true }),
    makeResource('sys2', 'system_message', 'z'.repeat(4000), { pinned: true }),
  ];
  const out = await transformer.transform(resources, makeCtx('exhaust', 1));

  assert.equal(events.length, 1, '应发出一次耗尽事件');
  const ev = events[0];
  assert.equal(ev.reason, 'pinned_overload');
  assert.ok(ev.suggestedSessionId.startsWith('exhaust_h'), '应有建议新会话 id');
  assert.equal(ev.fallback, false, 'fork 成功 → 非 fallback');
  assert.ok(ev.handoffDocument.includes('HANDOFF'), '交接文档来自 fork');
  assert.ok(ev.tokensAfter > ev.hardLimitTokens);

  // v2 语义：不永久禁用 —— 后续 turn 仍可尝试压缩（这里验证不抛错、资源可返回）
  const out2 = await transformer.transform(resources, makeCtx('exhaust', 5));
  assert.ok(Array.isArray(out2));
  // lifecycle fork 也应被调用（生成交接文档）
  assert.ok(calls.some(id => id.includes('lifecycle_handoff')), '应调用 lifecycle fork');
});

test('transformer: lifecycle fork 失败 → fallback 交接文档仍发出', async () => {
  const events: ContextExhaustedEvent[] = [];
  const { fn } = streamFnRecorder('', { fail: true });
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.8, targetRatio: 0.4 },
      safety: { retry: { retries: 0, baseMs: 1, maxMs: 1 } },
    }),
    model: mockModel,
    streamFn: fn,
    contextWindow: 1000,
  });
  transformer.onContextExhausted(e => { events.push(e); });

  // 1200 token > hardLimit 1000 才触发耗尽（1000 token 不大于 hardLimit，不触发）
  const resources = [
    makeResource('sys1', 'system_message', 'y'.repeat(4800), { pinned: true }),
  ];
  await transformer.transform(resources, makeCtx('exhaust2', 1));

  assert.equal(events.length, 1);
  assert.equal(events[0].fallback, true, 'fork 失败应标记 fallback');
  assert.ok(events[0].handoffDocument.length > 0, 'fallback 文档非空');
});

// ─── 遥测通道 ─────────────────────────────────────────────────────

test('transformer: 通过 sharedMap 写入遥测', async () => {
  const sharedMap = new Map<string, unknown>();
  const transformer = createCompressionTransformer({
    config: loadCompressionConfig({
      budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.05, targetRatio: 0.02 },
      summarize: { minResourcesToCompress: 2, protectedRecentCount: 2, forkMaxTokens: 100 },
    }),
    model: mockModel,
    streamFn: streamFnRecorder('summary').fn,
    contextWindow: 1000,
    sharedMap,
  });

  await transformer.transform(
    [userMsg('u1', 50), userMsg('u2', 50), userMsg('u3', 50), userMsg('u4', 50)],
    makeCtx('shared', 1),
  );

  const telemetry = sharedMap.get(TELEMETRY_SHARED_KEY) as CompressionTelemetry[] | undefined;
  assert.ok(telemetry && telemetry.length >= 1, 'sharedMap 应有遥测');
  assert.ok(telemetry!.every(t => typeof t.stage === 'string'));
});
