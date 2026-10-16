/**
 * errors.ts / did-you-mean 单测：错误翻译、debug 分级、相似建议
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, suggestSimilar } from '../src/args.js';
import {
  isDebugMode,
  translateApiError,
  errorMessage,
  formatErrorForUser,
} from '../src/errors.js';

// ─── translateApiError ───────────────────────────────────────────

test('错误翻译：API Key / 限流 / 模型不存在', () => {
  assert.match(translateApiError('Request failed with status code 401')!, /API Key/);
  assert.match(translateApiError('invalid api key provided')!, /API Key/);
  assert.match(translateApiError('Error 429: Too Many Requests')!, /频率或额度/);
  assert.match(translateApiError('model gpt-x not found')!, /模型不存在/);
});

test('错误翻译：网络 / 服务端 / 上下文超限', () => {
  assert.match(translateApiError('fetch failed: ETIMEDOUT')!, /网络/);
  assert.match(translateApiError('Internal server error (500)')!, /服务端/);
  assert.match(translateApiError('context length exceeded maximum')!, /上下文超限/);
});

test('错误翻译：未命中返回 null；数字需词边界（401 不误匹配 4012）', () => {
  assert.equal(translateApiError('读取了 4012 个文件'), null);
  assert.equal(translateApiError('随便一句话'), null);
});

// ─── isDebugMode / formatErrorForUser ─────────────────────────────

test('isDebugMode：--debug 参数或 AIPACK_DEBUG 环境变量', () => {
  assert.equal(isDebugMode(['node', 'aipack']), false);
  assert.equal(isDebugMode(['node', 'aipack', '--debug']), true);
  const prev = process.env.AIPACK_DEBUG;
  try {
    process.env.AIPACK_DEBUG = '1';
    assert.equal(isDebugMode(['node', 'aipack']), true);
    process.env.AIPACK_DEBUG = 'false';
    assert.equal(isDebugMode(['node', 'aipack']), false);
  } finally {
    if (prev === undefined) delete process.env.AIPACK_DEBUG;
    else process.env.AIPACK_DEBUG = prev;
  }
});

test('formatErrorForUser：默认无堆栈，debug 附加堆栈', () => {
  const err = new Error('boom 401');
  const plain = formatErrorForUser(err, { debug: false });
  assert.match(plain, /API Key/);
  assert.match(plain, /boom 401/);
  assert.doesNotMatch(plain, /at /); // 无堆栈

  const debugOut = formatErrorForUser(err, { debug: true });
  assert.match(debugOut, /boom 401/);
  assert.match(debugOut, /at /); // 含堆栈
});

test('formatErrorForUser：字符串输入仅翻译（流内 error chunk 场景）', () => {
  const out = formatErrorForUser('rate limit exceeded', { debug: false });
  assert.match(out, /频率或额度/);
});

test('errorMessage：非 Error 值字符串化', () => {
  assert.equal(errorMessage('text'), 'text');
  assert.equal(errorMessage(42), '42');
});

// ─── suggestSimilar ──────────────────────────────────────────────

test('suggestSimilar：常见拼写错误命中', () => {
  assert.equal(suggestSimilar('--prnt', ['--print', '--provider', '--safe']), '--print');
  assert.equal(suggestSimilar('/mode', ['/model', '/memory', '/help']), '/model');
  assert.equal(suggestSimilar('--toools', ['--tools', '--safe']), '--tools');
});

test('suggestSimilar：无相似或距离过远返回 undefined', () => {
  assert.equal(suggestSimilar('--zzzzzz', ['--print', '--safe']), undefined);
  assert.equal(suggestSimilar('x', ['-y']), undefined); // 距离不小于候选长度
});

// ─── parseArgs 集成：--debug 与未知选项建议 ───────────────────────

test('parseArgs：--debug 解析为布尔', () => {
  assert.equal(parseArgs(['--debug', '你好']).debug, true);
  assert.equal(parseArgs(['你好']).debug, undefined);
});

test('parseArgs：未知选项带 did-you-mean 建议', () => {
  const errors = parseArgs(['--prnt']).diagnostics.filter(d => d.type === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /未知选项: --prnt（是否想用 --print\?）/);
});

test('parseArgs：无相似候选时不给建议', () => {
  const errors = parseArgs(['--zzzzzz']).diagnostics.filter(d => d.type === 'error');
  assert.match(errors[0].message, /未知选项: --zzzzzz$/);
});
