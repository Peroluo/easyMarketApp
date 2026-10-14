/**
 * ContextBudget 单测 - 有效预算推导 + 双水位判定
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextBudget } from '../src/budget';

function makeBudget(overrides: Partial<ConstructorParameters<typeof ContextBudget>[1]> = {}) {
  return new ContextBudget(1000, {
    outputReserveTokens: 200,
    safetyMarginRatio: 0.05,
    triggerRatio: 0.8,
    targetRatio: 0.4,
    precompressRatio: 0.7,
    ...overrides,
  });
}

test('有效预算 = contextWindow - 输出预留 - 安全边距', () => {
  const b = makeBudget();
  // 1000 - 200 - floor(1000*0.05)=50 = 750
  assert.equal(b.effective, 750);
});

test('双水位线正确推导', () => {
  const b = makeBudget();
  assert.equal(b.triggerTokens, 600);      // 750 × 0.8
  assert.equal(b.targetTokens, 300);      // 750 × 0.4
  assert.equal(b.precompressTokens, 525);  // 750 × 0.7
  assert.equal(b.hardLimitTokens, 750);
});

test('shouldPrecompress：仅在 [precompress, trigger) 区间', () => {
  const b = makeBudget();
  assert.equal(b.shouldPrecompress(400), false, '低于预警线');
  assert.equal(b.shouldPrecompress(525), true, '达到预警线');
  assert.equal(b.shouldPrecompress(599), true, '接近高水位');
  assert.equal(b.shouldPrecompress(600), false, '达到高水位后归 compact 管');
  assert.equal(b.shouldPrecompress(700), false);
});

test('shouldCompact / reachedTarget / overHardLimit', () => {
  const b = makeBudget();
  assert.equal(b.shouldCompact(599), false);
  assert.equal(b.shouldCompact(600), true);
  assert.equal(b.reachedTarget(301), false);
  assert.equal(b.reachedTarget(300), true);
  assert.equal(b.overHardLimit(750), false);
  assert.equal(b.overHardLimit(751), true);
});

test('输出预留修复 v1 缺陷：压缩到 95% 窗口时模型仍有输出空间', () => {
  // v1 以整个 contextWindow 为界；v2 扣除输出预留
  const b = makeBudget({ outputReserveTokens: 400 }); // 1000 - 400 - 50 = 550
  assert.equal(b.effective, 550);
  assert.equal(b.overHardLimit(700), true, '700 超过有效预算，即使只占窗口 70%');
});

test('缺省 outputReserveTokens=0：只用安全边距', () => {
  const b = makeBudget({ outputReserveTokens: undefined });
  assert.equal(b.effective, 950); // 1000 - 0 - 50
});

test('无效 contextWindow 抛错', () => {
  assert.throws(() => new ContextBudget(0, {
    safetyMarginRatio: 0.05, triggerRatio: 0.8, targetRatio: 0.4, precompressRatio: 0.7,
  }), /Invalid contextWindow/);
  assert.throws(() => new ContextBudget(NaN, {
    safetyMarginRatio: 0.05, triggerRatio: 0.8, targetRatio: 0.4, precompressRatio: 0.7,
  }), /Invalid contextWindow/);
});

test('预算过小（全被预留吃掉）时保底为 1', () => {
  const b = new ContextBudget(100, {
    outputReserveTokens: 150,
    safetyMarginRatio: 0.1,
    triggerRatio: 0.8, targetRatio: 0.4, precompressRatio: 0.7,
  });
  assert.equal(b.effective, 1);
});
