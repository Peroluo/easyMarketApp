/**
 * examples/mcp-server.ts - MCP 服务端方向示例
 *
 * 把 aipack 工具集合反向暴露为标准 MCP Server，供外部 MCP 客户端
 * （Claude Desktop / Cursor 等）经 stdio 调用。离线可运行。
 *
 * 运行：pnpm example:mcp-server
 *
 * 验证方式（另开终端）：
 *   printf '%s\n' \
 *     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' \
 *     '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 *     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 *     '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"greet","arguments":{"name":"aipack"}}}' \
 *   | pnpm example:mcp-server
 *
 * 或在 Claude Desktop 配置中拉起（指向构建产物）：
 *   { "mcpServers": { "aipack": { "command": "node", "args": ["<repo>/packages/mcp/dist/server/stdio-entry.js"] } } }
 *
 * 这里直接用程序化 API（createMcpServerHost + runStdioServer）拉起自定义工具，
 * 等价于 dist/server/stdio-entry.js + AIPACK_MCP_TOOLS 加载工具模块的方式。
 */

import { createMcpServerHost, runStdioServer } from '@aipack-ai/mcp';
import type { Tool } from '@aipack-ai/agent';

const tools: Tool[] = [
  {
    name: 'greet',
    description: '按姓名向对方打招呼',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '要问候的对象' } },
      required: ['name'],
    },
    permissions: [],
    async execute(_id, args) {
      const name = String((args as { name?: string } | null)?.name ?? 'world');
      return { content: [{ type: 'text' as const, text: `你好 ${name}` }], details: undefined };
    },
  },
  {
    name: 'add',
    description: '两数相加',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    permissions: [],
    async execute(_id, args) {
      const a = Number((args as { a?: number } | null)?.a ?? 0);
      const b = Number((args as { b?: number } | null)?.b ?? 0);
      return { content: [{ type: 'text' as const, text: String(a + b) }], details: undefined };
    },
  },
];

const host = createMcpServerHost({
  name: 'aipack-example',
  version: '0.1.0',
  tools,
  // 演示：可选 resources / prompts（提供即 advertise capability）
  resources: [{ uri: 'about://aipack', name: 'about', description: '关于本服务', text: 'aipack MCP 示例服务', mimeType: 'text/plain' }],
});

await runStdioServer(host);
