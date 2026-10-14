/**
 * 集成测试：压缩策略管道降级链（CLI 组装方式）
 *
 * 验证 builder.ts 的组装逻辑与 runtime 降级链协作：
 *   v2 策略管道 transformer（trim → summarize → truncate）→ runtime 内置摘要压缩 → 硬截断
 *
 * 用 mock StreamFn + 小 contextWindow 模型驱动真实 runtime 循环，
 * 通过 telemetryReporter 观测各阶段触发，不依赖真实 API。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntime,
  createFileSessionStorage,
} from '@aipack-ai/agent';
import type {
  StreamFn,
  StreamEvent,
  AssistantMessage,
  ResultChunk,
  Model,
} from '@aipack-ai/agent';
import {
  createCompressionTransformer,
  loadCompressionConfig,
  type CompressionTelemetry,
} from '@aipack-ai/compression';
import { buildRuntime } from '../src/builder.js';
import type { Args } from '../src/args.js';

// ─── 辅助 ─────────────────────────────────────────────────────────

function baseArgs(overrides: Partial<Args> = {}): Args {
  return {
    messages: [],
    fileArgs: [],
    diagnostics: [],
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'aipack-cli-it-'));
}

const mockModel: Model = {
  id: 'mock', name: 'mock', provider: 'mock',
  contextWindow: 1000, maxTokens: 2048, reasoning: false,
};

/** 固定文本回复的 mock StreamFn（对齐真实 provider：发 text_delta + done） */
function mockStreamFn(text: string): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', delta: text };
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
      usage: { input: 10, output: 5, total: 15 },
      timestamp: Date.now(),
    };
    yield { type: 'done', message: assistant };
  };
}

/** 长文本（400 chars ≈ 100 token，char-heuristic 4:1） */
const LONG_TEXT = Array.from({ length: 10 }, (_, i) => `第${i}行：${'x'.repeat(36)}`).join('\n');

/** 驱动 runtime 跑 n 轮对话 */
async function runTurns(
  runtime: ReturnType<typeof createRuntime>,
  sessionKey: string,
  turns: number,
): Promise<void> {
  for (let i = 0; i < turns; i++) {
    const request = {
      message: `用户消息 ${i}: ${LONG_TEXT}`,
      type: 'message' as const,
      channel: 'cli',
      sessionKey,
      ephemeral: true,
    };
    for await (const _chunk of runtime.stream(request) as AsyncGenerator<ResultChunk>) {
      // 消费完整流（mock 单事件，立即结束）
    }
  }
}

// ─── T1/T2/T3：builder 组装逻辑 ──────────────────────────────────

test('T1: 默认启用压缩 — buildRuntime 返回 compressionTransformer', async () => {
  const dir = await tempDir();
  const built = await buildRuntime({
    args: baseArgs({ sessionDir: path.join(dir, 'sessions') }),
    cwd: dir,
  });
  assert.ok(built.compressionTransformer, '默认应构造压缩 transformer');
  assert.equal(built.runtime.compact === undefined, false, 'runtime 应有 compact 方法');
});

test('T2: --no-compaction — 不建 transformer，compact() 返回 null', async () => {
  const dir = await tempDir();
  const built = await buildRuntime({
    args: baseArgs({ noCompaction: true, sessionDir: path.join(dir, 'sessions') }),
    cwd: dir,
  });
  assert.equal(built.compressionTransformer, undefined, '--no-compaction 不应构造 transformer');
  // 内置摘要压缩同时关闭 → compact 返回 null
  const mode = await built.runtime.compact();
  assert.equal(mode, null);
});

test('T3: --compaction-config 文件覆盖配置；坏文件仅告警不阻塞', async () => {
  const dir = await tempDir();

  // 合法 JSON：enabled=false → transformer 存在但压缩被关闭
  const cfgFile = path.join(dir, 'compaction.json');
  await fs.writeFile(cfgFile, JSON.stringify({ enabled: false }), 'utf8');

  const built = await buildRuntime({
    args: baseArgs({ compactionConfig: cfgFile, sessionDir: path.join(dir, 'sessions') }),
    cwd: dir,
  });
  assert.ok(built.compressionTransformer, 'transformer 仍应被构造（enabled 是运行时开关）');

  // 坏 JSON → 不抛错，回退默认配置
  const badFile = path.join(dir, 'bad.json');
  await fs.writeFile(badFile, '{invalid json', 'utf8');
  const built2 = await buildRuntime({
    args: baseArgs({ compactionConfig: badFile, sessionDir: path.join(dir, 'sessions2') }),
    cwd: dir,
  });
  assert.ok(built2.compressionTransformer, '坏配置文件不应阻塞 transformer 构造');
});

// ─── T4：降级链端到端（策略管道 transformer 在 runtime 循环中触发）───

test('T4: 长会话驱动 summarize 触发，telemetry 记录降级链', async () => {
  const reported: CompressionTelemetry[] = [];
  const reporter = { report: (t: CompressionTelemetry) => { reported.push(t); } };

  // 低水位阈值确保少量轮次即触发；protectedRecentCount=0 验证"全量可压"语义。
  // outputReserveTokens=0：mock 模型 maxTokens(2048) > contextWindow(1000)，不预留
  const config = loadCompressionConfig({
    budget: { outputReserveTokens: 0, safetyMarginRatio: 0, triggerRatio: 0.05, targetRatio: 0.02 },
    summarize: { minResourcesToCompress: 2, protectedRecentCount: 0, forkMaxTokens: 100 },
  });

  const transformer = createCompressionTransformer({
    config,
    model: mockModel,
    streamFn: mockStreamFn('[SUMMARY] 历史对话摘要'),
    contextWindow: 1000,
    telemetryReporter: reporter,
  });

  const runtime = await createRuntime({
    model: mockModel,
    streamFn: mockStreamFn(`回复：${LONG_TEXT}`),
    transformers: [transformer],
    compaction: { enabled: true },
    maxTurns: 10,
  });

  await runTurns(runtime, 'it-l2', 3);

  const stages = new Set(reported.map(t => t.stage));
  assert.ok(stages.has('summarize'),
    `应触发 summarize 摘要（实际: ${[...stages].join(',') || '无'}）`);
  // 摘要后 token 应净下降
  const compressed = reported.filter(t => t.afterTokens < t.beforeTokens);
  assert.ok(compressed.length > 0, '应存在 token 净下降的压缩记录');
});

// ─── T5：runtime 内置摘要压缩兜底（无 transformer 时）────────────

test('T5: 内置摘要压缩兜底 — 超阈值后历史被替换为 compactionSummary', async () => {
  const runtime = await createRuntime({
    model: { ...mockModel, contextWindow: 500 },
    streamFn: mockStreamFn(`回复：${LONG_TEXT}`),
    compaction: { enabled: true, triggerRatio: 0.05, targetRatio: 0.02 },
    maxTurns: 10,
  });

  // 第 2 轮开始时触发摘要压缩（第 3 轮可能因摘要超预算降级为纯截断，故只跑 2 轮）
  await runTurns(runtime, 'it-builtin', 2);

  const messages = runtime.getMessages('it-builtin');
  const hasSummary = messages.some(m => (m as { role: string }).role === 'compactionSummary');
  assert.ok(hasSummary,
    `内置摘要压缩应产生 compactionSummary 消息（实际 roles: ${messages.map(m => m.role).join(',')}）`);
});

// ─── T6：手动压缩（/compact 底层）─────────────────────────────────

test('T6: runtime.compact() 手动压缩并持久化', async () => {
  const dir = await tempDir();
  const sessionDir = path.join(dir, 'sessions');

  const runtime = await createRuntime({
    model: { ...mockModel, contextWindow: 500 },
    streamFn: mockStreamFn(`回复：${LONG_TEXT}`),
    sessionStorage: createFileSessionStorage({ baseDir: sessionDir }),
    // triggerRatio 调高避免自动压缩干扰；手动 compact 应独立工作
    compaction: { enabled: true, triggerRatio: 5, targetRatio: 0.02 },
    maxTurns: 10,
  });

  await runTurns(runtime, 'it-manual', 3);
  const before = runtime.getMessages('it-manual').length;
  assert.ok(before >= 4, '压缩前应有多条消息');

  const mode = await runtime.compact('it-manual');
  assert.ok(mode === 'summary' || mode === 'truncate', `compact 应返回模式（实际: ${mode}）`);

  const after = runtime.getMessages('it-manual').length;
  assert.ok(after < before, `压缩后消息数应下降（${before} → ${after}）`);

  // 持久化验证：存储中的会话已更新
  const stored = await (runtime as unknown as {
    _sessionStorage?: { load(k: string): Promise<{ messages: unknown[] } | null> };
  })._sessionStorage?.load('it-manual');
  assert.ok(stored, '压缩后应已持久化');
  assert.equal(stored!.messages.length, after, '存储中消息数与内存一致');
});
