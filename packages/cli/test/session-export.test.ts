/**
 * P1 新增功能测试：
 * - /export：buildSessionMarkdown（会话消息 → Markdown）
 * - Tab 补全：listPathCompletions（@ 文件路径候选）
 * - 工具参数摘要：summarizeArgs（render tool_start / 权限确认共用）
 * - 会话标题优先级：extractSessionTitle（/rename 的 title 优先）
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSessionMarkdown, listPathCompletions } from '../src/modes/interactive.js';
import { summarizeArgs } from '../src/confirm.js';
import { extractSessionTitle } from '../src/builder.js';
import type { Message } from '@aipack-ai/agent';

// ─── buildSessionMarkdown ─────────────────────────────────────────

describe('buildSessionMarkdown', () => {
  const ts = Date.now();

  it('user / assistant 消息分节输出', () => {
    const messages: Message[] = [
      { role: 'user', content: '帮我看看', timestamp: ts },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }], timestamp: ts },
    ];
    const md = buildSessionMarkdown('s-1', messages);
    assert.ok(md.includes('# aipack 会话导出'));
    assert.ok(md.includes('- 会话: s-1'));
    assert.ok(md.includes('## 用户'));
    assert.ok(md.includes('帮我看看'));
    assert.ok(md.includes('## 助手'));
    assert.ok(md.includes('好的'));
  });

  it('assistant 的 toolCall 标注调用名与参数；thinking 跳过', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: '内心过程' },
          { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } },
          { type: 'text', text: '执行完成' },
        ],
        timestamp: ts,
      } as Message,
    ];
    const md = buildSessionMarkdown('s-2', messages);
    assert.ok(md.includes('调用工具 `bash`'), 'toolCall 应标注调用');
    assert.ok(md.includes('ls'), 'toolCall 应包含参数');
    assert.ok(!md.includes('内心过程'), 'thinking 块应跳过');
  });

  it('toolResult 折叠展示（失败标注）', () => {
    const messages: Message[] = [
      {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'bash',
        isError: true,
        content: [{ type: 'text', text: 'command not found' }],
        timestamp: ts,
      } as Message,
    ];
    const md = buildSessionMarkdown('s-3', messages);
    assert.ok(md.includes('工具结果: bash（失败）'));
    assert.ok(md.includes('command not found'));
    assert.ok(md.includes('<details>'), '工具结果应折叠');
  });

  it('user 图片附件占位', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: '这图' }, { type: 'image', data: 'x', mimeType: 'image/png' }],
        timestamp: ts,
      } as Message,
    ];
    const md = buildSessionMarkdown('s-4', messages);
    assert.ok(md.includes('[图片]'));
  });
});

// ─── listPathCompletions（Tab 补全）───────────────────────────────

describe('listPathCompletions', () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aipack-tab-'));
    await fs.writeFile(path.join(dir, 'readme.md'), 'x', 'utf-8');
    await fs.writeFile(path.join(dir, 'render.ts'), 'x', 'utf-8');
    await fs.writeFile(path.join(dir, '.hidden.json'), 'x', 'utf-8');
    await fs.mkdir(path.join(dir, 'src'));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('空前缀列出顶层条目（目录以 / 结尾），隐藏项不出现', async () => {
    const hits = await listPathCompletions(`${dir}/`);
    assert.ok(hits.includes('readme.md'));
    assert.ok(hits.includes('src/'), '目录应以 / 结尾');
    assert.ok(!hits.includes('.hidden.json'), '空前缀不列隐藏文件');
  });

  it('前缀过滤匹配项', async () => {
    const hits = await listPathCompletions(`${dir}/re`);
    assert.deepEqual(hits, ['readme.md', 'render.ts'].sort());
  });

  it('. 前缀列出隐藏文件', async () => {
    const hits = await listPathCompletions(`${dir}/.`);
    assert.deepEqual(hits, ['.hidden.json']);
  });

  it('目录不存在返回空数组', async () => {
    const hits = await listPathCompletions(path.join(dir, 'nope', 'x'));
    assert.deepEqual(hits, []);
  });
});

// ─── summarizeArgs（工具参数摘要）─────────────────────────────────

describe('summarizeArgs', () => {
  it('bash 工具显示命令；超长截断', () => {
    assert.equal(summarizeArgs({ command: 'ls -la' }), 'ls -la');
    const long = { command: 'x'.repeat(80) };
    assert.ok(summarizeArgs(long).endsWith('…'));
    assert.equal(summarizeArgs(long).length, 61);
  });

  it('文件工具显示 file/path 字段', () => {
    assert.equal(summarizeArgs({ file: 'a.ts' }), 'a.ts');
    assert.equal(summarizeArgs({ path: 'b/c.ts' }), 'b/c.ts');
  });

  it('无已知字段或非对象返回空串', () => {
    assert.equal(summarizeArgs({ foo: 1 }), '');
    assert.equal(summarizeArgs(null), '');
    assert.equal(summarizeArgs('str'), '');
  });
});

// ─── extractSessionTitle（title 优先级）───────────────────────────

describe('extractSessionTitle title 优先', () => {
  it('title 优先于首条用户消息', () => {
    const session = {
      key: 's-1',
      version: 1,
      title: '调试登录',
      messages: [
        { role: 'user', content: '很长的首条消息内容', timestamp: Date.now() },
      ],
      model: null,
      usage: { input: 0, output: 0, total: 0 },
      createdAt: '',
      updatedAt: '',
    };
    assert.equal(extractSessionTitle(session), '调试登录');
  });

  it('无 title 回退首条用户消息摘要（向后兼容）', () => {
    const session = {
      key: 's-2',
      version: 1,
      messages: [
        { role: 'user', content: '帮我修复 bug', timestamp: Date.now() },
      ],
      model: null,
      usage: { input: 0, output: 0, total: 0 },
      createdAt: '',
      updatedAt: '',
    };
    assert.equal(extractSessionTitle(session), '帮我修复 bug');
  });
});
