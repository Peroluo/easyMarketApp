/**
 * server/stdio-entry.ts - MCP stdio 服务端进程入口（Node only）
 *
 * 读 stdin 行分隔 JSON-RPC → McpServerHost.handleRequest → 写 stdout。
 * 外部 MCP 客户端（Claude Desktop / Cursor）可直接在配置里拉起：
 *
 *   node packages/mcp/dist/server/stdio-entry.js
 *
 * 工具来源（按优先级）：
 *   1. 环境变量 AIPACK_MCP_TOOLS 指向一个 ESM 模块（.js/.mjs/.ts），
 *      其默认导出或具名 `tools` 导出为 Tool[]；
 *   2. 未设置时回退内置演示工具（echo / add / ask_llm），便于开箱即用与自测。
 *
 * sampling（M3）：`sampling: true` 宣告能力，stdio-runner 自动注入出站通道，
 * `ask_llm` 演示工具经 `host.sampleLLM()` 向外部 client 请求 LLM 补全。
 *
 * 本文件为进程入口（直接运行即启动 main）；程序化复用循环请 import
 * `runStdioServer` / `createMcpServerHost`（从包主入口 @aipack-ai/mcp）。
 */

import { pathToFileURL } from 'node:url';
import type { Tool } from '@aipack-ai/agent';
import * as jsonrpc from '../client/jsonrpc';
import { createMcpServerHost } from './host';
import type { McpServerHost } from './host';
import { runStdioServer } from './stdio-runner';

// ─── 工具来源解析 ─────────────────────────────────────────────

async function loadToolsFromEnv(): Promise<Tool[] | null> {
  const p = process.env.AIPACK_MCP_TOOLS;
  if (!p) return null; // 回退 demo
  const url = pathToFileURL(p).href;
  const mod = (await import(url)) as { tools?: Tool[]; default?: Tool[] | { tools?: Tool[] } };
  if (Array.isArray(mod.tools)) return mod.tools;
  if (Array.isArray(mod.default)) return mod.default as Tool[];
  if (mod.default && Array.isArray((mod.default as { tools?: Tool[] }).tools)) {
    return (mod.default as { tools: Tool[] }).tools;
  }
  throw new Error(`AIPACK_MCP_TOOLS module "${p}" does not export \`tools\` (Tool[])`);
}

// ─── 内置演示工具（开箱即用 / 自测）──────────────────────────

const echoTool: Tool = {
  name: 'echo',
  description: '原样返回输入文本',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要回显的文本' } },
    required: ['text'],
  },
  permissions: [],
  async execute(_id: string, args: unknown) {
    const text = String((args as { text?: string } | null)?.text ?? '');
    return { content: [{ type: 'text' as const, text }], details: undefined };
  },
};

const addTool: Tool = {
  name: 'add',
  description: '两数相加',
  parameters: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  permissions: [],
  async execute(_id: string, args: unknown) {
    const a = Number((args as { a?: number } | null)?.a ?? 0);
    const b = Number((args as { b?: number } | null)?.b ?? 0);
    return { content: [{ type: 'text' as const, text: String(a + b) }], details: undefined };
  },
};

/**
 * 演示 sampling：经 host.sampleLLM 向外部 client 请求 LLM 补全。
 * host 经 holder 惰性引用（resolver 在 tools/list 时才调用，此时 host 已构造）。
 */
function buildAskLlmTool(hostGetter: () => McpServerHost): Tool {
  return {
    name: 'ask_llm',
    description: '通过 MCP sampling 向已连接的客户端 LLM 提问',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: '要提问的问题' } },
      required: ['question'],
    },
    permissions: [],
    async execute(_id: string, args: unknown) {
      const question = String((args as { question?: string } | null)?.question ?? '');
      try {
        const res = await hostGetter().sampleLLM({
          messages: [{ role: 'user', content: { type: 'text', text: question } }],
          maxTokens: 256,
        });
        const text = res.content.type === 'text' ? (res.content.text ?? '') : '[图像响应]';
        return { content: [{ type: 'text' as const, text }], details: undefined };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `sampling 失败：${message}` }],
          details: { error: message },
        };
      }
    },
  };
}

// ─── 进程入口 ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const external = await loadToolsFromEnv();
  // holder 模式：demo 工具的 ask_llm 需惰性引用 host
  const holder: { host?: McpServerHost } = {};
  const demoTools = (): Tool[] => [echoTool, addTool, buildAskLlmTool(() => holder.host!)];
  const host = createMcpServerHost({
    name: process.env.AIPACK_MCP_SERVER_NAME ?? 'aipack-mcp',
    version: process.env.AIPACK_MCP_SERVER_VERSION ?? '0.1.0',
    tools: external ?? demoTools,
    sampling: true, // 宣告 sampling 能力；runner 自动注入出站通道
    onNotification: (n) => {
      process.stdout.write(jsonrpc.serialize(n) + '\n');
    },
  });
  holder.host = host;
  await runStdioServer(host);
}

// 本文件为进程入口：直接运行即启动 main（不做 import.meta.url 主模块判定，
// 以避免打包器把副作用代码 hoist 到共享 chunk 后判定失效）。
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
