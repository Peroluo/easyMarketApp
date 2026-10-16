/**
 * builder.ts 会话列表单测：标题提取、相对时间、列表排序与回退 key
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySessionStorage } from '@aipack-ai/agent';
import type { StoredSession } from '@aipack-ai/agent';
import {
  extractSessionTitle,
  formatRelativeTime,
  listSessionInfos,
  listSessionsByRecency,
} from '../src/builder.js';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    key: 's-test',
    version: 1,
    messages: [],
    model: null,
    usage: { input: 0, output: 0, total: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── extractSessionTitle ─────────────────────────────────────────

test('标题：string content 的首条 user 消息', () => {
  const s = makeSession({
    messages: [
      { role: 'system', content: '系统提示', timestamp: 1 },
      { role: 'user', content: '帮我修复登录超时问题', timestamp: 2 },
    ],
  });
  assert.equal(extractSessionTitle(s), '帮我修复登录超时问题');
});

test('标题：ContentBlock[] content 提取 text 块拼接', () => {
  const s = makeSession({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '分析这个' },
        { type: 'image', data: '...', mimeType: 'image/png' },
        { type: 'text', text: '依赖树' },
      ],
      timestamp: 1,
    }],
  });
  assert.equal(extractSessionTitle(s), '分析这个 依赖树');
});

test('标题：超过 40 字符截断加省略号；换行折叠为空格', () => {
  const long = 'a'.repeat(50);
  const s = makeSession({ messages: [{ role: 'user', content: long, timestamp: 1 }] });
  assert.equal(extractSessionTitle(s), `${'a'.repeat(40)}…`);
  const multi = makeSession({
    messages: [{ role: 'user', content: '第一行\n第二行\n\n第三行', timestamp: 1 }],
  });
  assert.equal(extractSessionTitle(multi), '第一行 第二行 第三行');
});

test('标题：无 user 消息 / 空消息 → 空串（回退 key 展示）', () => {
  assert.equal(extractSessionTitle(makeSession()), '');
  const onlyAssistant = makeSession({
    messages: [{ role: 'assistant', content: '回复', timestamp: 1 }],
  });
  assert.equal(extractSessionTitle(onlyAssistant), '');
});

// ─── formatRelativeTime ──────────────────────────────────────────

test('相对时间：分钟 / 小时档位', () => {
  const now = Date.parse('2026-10-16T12:00:00');
  assert.equal(formatRelativeTime(new Date(now - 30_000).toISOString(), now), '刚刚');
  assert.equal(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now), '5 分钟前');
  assert.equal(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now), '3 小时前');
});

test('相对时间：昨天带时分 / 当年月日 / 跨年日期', () => {
  const now = Date.parse('2026-10-16T12:00:00');
  // 昨天 10:00（日历意义上的前一天，且时差超过 24 小时档位）
  assert.equal(formatRelativeTime('2026-10-15T10:00:00', now), '昨天 10:00');
  // 当年更早：N月D日
  assert.equal(formatRelativeTime('2026-03-02T10:00:00', now), '3月2日');
  // 跨年：完整日期
  assert.equal(formatRelativeTime('2025-12-31T10:00:00', now), '2025-12-31');
  // 非法输入 → 空串
  assert.equal(formatRelativeTime('not-a-date', now), '');
});

// ─── listSessionInfos / listSessionsByRecency ────────────────────

test('listSessionInfos：按 updatedAt 降序 + 标题提取；旧接口返回 key 数组', async () => {
  const storage = createMemorySessionStorage();
  await storage.save('s-old', makeSession({
    key: 's-old',
    messages: [{ role: 'user', content: '旧会话问题', timestamp: 1 }],
    updatedAt: '2026-10-14T10:00:00',
  }));
  await storage.save('s-new', makeSession({
    key: 's-new',
    messages: [{ role: 'user', content: '新会话问题', timestamp: 1 }],
    updatedAt: '2026-10-16T10:00:00',
  }));
  await storage.save('s-empty', makeSession({ key: 's-empty', updatedAt: '2026-10-15T10:00:00' }));

  const infos = await listSessionInfos(storage);
  assert.deepEqual(infos.map(i => i.key), ['s-new', 's-empty', 's-old']);
  assert.equal(infos[0].title, '新会话问题');
  assert.equal(infos[1].title, ''); // 无 user 消息 → 空标题（展示回退 key）

  const keys = await listSessionsByRecency(storage);
  assert.deepEqual(keys, ['s-new', 's-empty', 's-old']);
});
