/**
 * args.ts 单测：参数解析、缺值报错、--opt=value、--yes / --max-turns
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('基础：位置消息与 @file', () => {
  const a = parseArgs(['帮我看看', '@package.json', '这个项目']);
  assert.deepEqual(a.messages, ['帮我看看', '这个项目']);
  assert.deepEqual(a.fileArgs, ['package.json']);
});

test('布尔标志：--safe / --no-session / -y / --yes / -c', () => {
  const a = parseArgs(['--safe', '--no-session', '-y', '-c']);
  assert.equal(a.safe, true);
  assert.equal(a.noSession, true);
  assert.equal(a.yes, true);
  assert.equal(a.continue, true);
  const b = parseArgs(['--yes']);
  assert.equal(b.yes, true);
});

test('带值选项：--model provider/id', () => {
  const a = parseArgs(['--model', 'deepseek/deepseek-chat']);
  assert.equal(a.model, 'deepseek/deepseek-chat');
});

test('带值选项：--opt=value 形式', () => {
  const a = parseArgs(['--model=deepseek-chat', '--thinking=low', '--max-turns=20']);
  assert.equal(a.model, 'deepseek-chat');
  assert.equal(a.thinking, 'low');
  assert.equal(a.maxTurns, 20);
});

test('带值选项缺值：报错误诊断（而非误报未知选项）', () => {
  const a = parseArgs(['--model']);
  const errors = a.diagnostics.filter(d => d.type === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /--model 需要一个值/);
});

test('短选项 -n / -t / -xt', () => {
  const a = parseArgs(['-n', 'my-session', '-t', 'read,grep', '-xt', 'bash']);
  assert.equal(a.name, 'my-session');
  assert.deepEqual(a.tools, ['read', 'grep']);
  assert.deepEqual(a.excludeTools, ['bash']);
});

test('--max-turns 非法值报错', () => {
  const a = parseArgs(['--max-turns', 'abc']);
  const errors = a.diagnostics.filter(d => d.type === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /--max-turns/);
});

test('--max-turns 0 与负数报错', () => {
  for (const v of ['0', '-3']) {
    const a = parseArgs(['--max-turns', v]);
    assert.ok(a.diagnostics.some(d => d.type === 'error' && d.message.includes('--max-turns')));
  }
});

test('--thinking 非法值报 error（与 --mode 一致）', () => {
  const a = parseArgs(['--thinking', 'ultra']);
  assert.equal(a.thinking, undefined);
  assert.ok(a.diagnostics.some(d => d.type === 'error'));
  assert.ok(!a.diagnostics.some(d => d.type === 'warning'));
});

test('未知选项报错', () => {
  const a = parseArgs(['--frobnicate']);
  assert.ok(a.diagnostics.some(d => d.type === 'error' && d.message.includes('--frobnicate')));
});

test('-p 吞并紧随消息', () => {
  const a = parseArgs(['-p', '总结一下', '--no-session']);
  assert.equal(a.print, true);
  assert.deepEqual(a.messages, ['总结一下']);
  assert.equal(a.noSession, true);
});

test('tools 列表空白与空项过滤', () => {
  const a = parseArgs(['--tools', ' read , , grep,']);
  assert.deepEqual(a.tools, ['read', 'grep']);
});

test('-- 之后全部视为位置消息（可传递 - 开头消息）', () => {
  const a = parseArgs(['--print', '--', '-p 是什么参数', '--model']);
  assert.equal(a.print, true);
  assert.deepEqual(a.messages, ['-p 是什么参数', '--model']);
});

test('-- 后首个 - 开头消息不被 -p 吞并（-- 在 -p 前）', () => {
  const a = parseArgs(['-p', '--', '- 列表项']);
  assert.equal(a.print, true);
  assert.deepEqual(a.messages, ['- 列表项']);
});

test('--api-key 使用时给出进程列表泄露警告', () => {
  const a = parseArgs(['--api-key', 'sk-test']);
  assert.equal(a.apiKey, 'sk-test');
  assert.ok(a.diagnostics.some(d => d.type === 'warning' && d.message.includes('--api-key')));
});

test('--print=消息 内联值生效', () => {
  const a = parseArgs(['--print=总结一下']);
  assert.equal(a.print, true);
  assert.deepEqual(a.messages, ['总结一下']);
});

test('--list-models=搜索 内联值生效', () => {
  const a = parseArgs(['--list-models=deepseek']);
  assert.equal(a.listModels, 'deepseek');
  const b = parseArgs(['--list-models']);
  assert.equal(b.listModels, true);
});

test('带值选项不把 -- 当作值消费', () => {
  const a = parseArgs(['--model', '--', 'gpt-4o']);
  assert.equal(a.model, undefined);
  assert.ok(a.diagnostics.some(d => d.type === 'error' && d.message.includes('--model 需要一个值')));
  assert.deepEqual(a.messages, ['gpt-4o']);
});

test('选项组合冲突给出警告', () => {
  const a = parseArgs(['-p', '--mode', 'json']);
  assert.ok(a.diagnostics.some(d => d.type === 'warning' && d.message.includes('--print')));
  const b = parseArgs(['-c', '--session', 'foo']);
  assert.ok(b.diagnostics.some(d => d.type === 'warning' && d.message.includes('--continue')));
  const c = parseArgs(['--no-session', '--session-dir', '/tmp/x']);
  assert.ok(c.diagnostics.some(d => d.type === 'warning' && d.message.includes('--no-session')));
  const d = parseArgs(['--yes', '--safe']);
  assert.ok(d.diagnostics.some(d => d.type === 'warning' && d.message.includes('--yes')));
});
