/**
 * TokenMeter 单测 - 契约安全缓存、对象 content、图片块、校准闭环
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContextResource } from '@aipack-ai/agent';
import { TokenMeter } from '../src/token-estimator';

function makeResource(
  id: string,
  content: unknown,
  opts: { type?: ContextResource['type']; pinned?: boolean } = {},
): ContextResource {
  return {
    id,
    type: opts.type ?? 'user_message',
    role: 'user',
    content,
    timestamp: 0,
    dependencies: [],
    meta: {},
    pinned: opts.pinned ?? false,
  };
}

test('字符串 content：缓存命中且长度变化即失效', () => {
  const m = new TokenMeter();
  const r = makeResource('r1', 'abcdefgh'); // 8 ascii chars / 4 = 2 tokens

  const first = m.estimate(r);
  assert.equal(first, 2);

  // 同长度同内容：命中缓存（无法从外部观察，但结果一致）
  assert.equal(m.estimate(r), 2);

  // 内容变化（trim 后长度不同）→ 重新估算，无需手动 invalidate
  const trimmed = makeResource('r1', 'abcd');
  assert.equal(m.estimate(trimmed), 1);
});

test('对象 content：不再估为 0（修复 v1 compaction_summary 估算为 0 的缺陷）', () => {
  const m = new TokenMeter();
  const summaryMessage = { role: 'compactionSummary', content: '摘要内容 abcdef', timestamp: 0 };
  const r = makeResource('s1', summaryMessage, { type: 'compaction_summary' });

  assert.ok(m.estimate(r) > 0, '对象 content 应有非零估算');
});

test('Message 对象 content：文本部分按内容估算（JSON 包装开销也计入）', () => {
  const m = new TokenMeter();
  const inner = 'x'.repeat(400); // 100 tokens
  const summaryMessage = { role: 'compactionSummary', content: inner, timestamp: 0 };
  const r = makeResource('s1', summaryMessage, { type: 'compaction_summary' });

  // JSON.stringify 含额外字段名，估算 >= 纯文本估算
  assert.ok(m.estimate(r) >= 100, `估算应不小于纯文本 100，实际 ${m.estimate(r)}`);
});

test('ContentBlock[]：text 块计入，图片块按配置计价', () => {
  const m = new TokenMeter({ imageTokensPerBlock: 100 });
  const blocks = [
    { type: 'text', text: 'abcd' },        // 1 token
    { type: 'image', data: '...', mimeType: 'image/png' },
    { type: 'text', text: 'efgh' },        // 1 token
  ];
  const r = makeResource('r1', blocks);
  // 2 (text) + 100 (image) = 102
  assert.equal(m.estimate(r), 102);

  const m2 = new TokenMeter({ imageTokensPerBlock: 1500 });
  assert.equal(m2.estimate(r), 1502);
});

test('数组/对象 content 引用变化即失效（不可变更新自动正确）', () => {
  const m = new TokenMeter();
  const original = [{ type: 'text', text: 'a'.repeat(400) }];
  const r = makeResource('r1', original);
  const before = m.estimate(r);

  // 不可变更新：新数组引用 → 缓存自动失效
  const updated = [{ type: 'text', text: 'a'.repeat(40) }];
  const r2 = makeResource('r1', updated);
  assert.ok(m.estimate(r2) < before, '更新后估算应下降');
});

test('recordActualUsage：EMA 校准闭环', () => {
  const m = new TokenMeter();
  const r = makeResource('r1', 'x'.repeat(400)); // 估算 100

  const estimated = m.estimate(r);
  assert.equal(estimated, 100);

  // 真实是估算的 2 倍 → 校准比例跳到 2
  m.recordActualUsage(100, 200);
  assert.equal(m.estimate(r), 200);

  // 后续样本 EMA 平滑：ratio = 2*0.7 + 1*0.3 = 1.7
  m.recordActualUsage(100, 100);
  assert.equal(m.estimate(r), Math.ceil(100 * 1.7));
});

test('recordActualUsage：噪声样本被过滤（>5x / <0.2x）', () => {
  const m = new TokenMeter();
  m.recordActualUsage(100, 1000); // 10x 噪声，拒绝
  m.recordActualUsage(100, 10);   // 0.1x 噪声，拒绝
  const r = makeResource('r1', 'x'.repeat(400));
  assert.equal(m.estimate(r), 100, '校准比例应保持 1');
});

test('estimateText：CJK 与 ASCII 分开计价', () => {
  const m = new TokenMeter({ charsPerTokenAscii: 4, charsPerTokenCJK: 1.5 });
  assert.equal(m.estimateText('aaaaaaaa'), 2);  // 8/4
  assert.equal(m.estimateText('中中中'), 2);      // ceil(3/1.5)
});

test('注入 tokenizer 时优先使用', () => {
  const tokenizer = { encode: (text: string) => new Array(text.length).fill(0) };
  const m = new TokenMeter({ tokenizer });
  assert.equal(m.estimateText('abcdef'), 6);
});
