/**
 * server/http-entry.ts - MCP Streamable HTTP 服务端进程入口（Node only）
 *
 * 启动一个 Streamable HTTP MCP server（默认 `127.0.0.1:8080/mcp`），
 * 供外部 MCP 客户端（Claude Desktop / 自研 client / 其它 server 端到端测试）连接。
 *
 * 工具来源（与 stdio-entry 对齐）：
 *   1. 环境变量 AIPACK_MCP_TOOLS 指向一个 ESM 模块（.js/.mjs/.ts），
 *      默认导出或具名 `tools` 导出为 Tool[]；
 *   2. 未设置时回退内置演示工具（echo / add / ask_llm），便于开箱即用与自测。
 *
 * 环境变量：
 *   AIPACK_MCP_HOST          listen host（默认 127.0.0.1）
 *   AIPACK_MCP_PORT          listen port（默认 8080；0 = 随机）
 *   AIPACK_MCP_ENDPOINT      endpoint path（默认 /mcp）
 *   AIPACK_MCP_SERVER_NAME   serverInfo.name（默认 aipack-mcp-http）
 *   AIPACK_MCP_SERVER_VERSION serverInfo.version（默认 0.1.0）
 *
 * sampling（M3）：`sampling: true` 宣告能力，http-runner 自动注入出站通道，
 * `ask_llm` 演示工具经 `host.sampleLLM()` 向外部 client 请求 LLM 补全。
 *
 * 本文件为进程入口（直接运行即启动 main）；程序化复用循环请 import
 * `runHttpServer` / `createMcpHttpServer` / `createMcpServerHost`。
 */

import { pathToFileURL } from 'node:url';
import type { Tool } from '@aipack-ai/agent';
import * as jsonrpc from '../client/jsonrpc';
import { createMcpServerHost } from './host';
import type { McpServerHost } from './host';
import { runHttpServer } from './http-runner';

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

// ─── 内置演示工具（与 stdio-entry 同步）──────────────────────

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
    name: process.env.AIPACK_MCP_SERVER_NAME ?? 'aipack-mcp-http',
    version: process.env.AIPACK_MCP_SERVER_VERSION ?? '0.1.0',
    tools: external ?? demoTools,
    sampling: true,
    onNotification: (n) => {
      // HTTP 传输层会覆盖此回调（createMcpHttpServer 内）；保留兜底
      process.stderr.write(`[mcp-http] unexpected notification: ${jsonrpc.serialize(n)}\n`);
    },
  });
  holder.host = host;

  const handle = await runHttpServer(host, {
    endpoint: process.env.AIPACK_MCP_ENDPOINT ?? '/mcp',
    host: process.env.AIPACK_MCP_HOST ?? '127.0.0.1',
    port: process.env.AIPACK_MCP_PORT ? Number(process.env.AIPACK_MCP_PORT) : 8080,
    onListening: ({ url }) => {
      process.stderr.write(`[mcp-http] listening on ${url}\n`);
    },
  });

  // 优雅退出：SIGINT/SIGTERM → 关闭 server
  const shutdown = async (): Promise<void> => {
    process.stderr.write('[mcp-http] shutting down\n');
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// 本文件为进程入口：直接运行即启动 main（不做 import.meta.url 主模块判定，
// 以避免打包器把副作用代码 hoist 到共享 chunk 后判定失效）。
main().catch((err) => {
  console.error(err);
  process.exit(1);
});