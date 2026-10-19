import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { RuntimeHooks, ExtensionContext } from '@aipack-ai/agent';
import { McpClient } from '../src/client/mcp-client';
import { StdioMcpTransport } from '../src/client/stdio-transport';
import { createMcpPlugin } from '../src/extension';

// fileURLToPath 正确处理 Windows 盘符（.pathname 会产生 /D:/ 前缀，resolve 后成双盘符）
const fixturePath = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));

function makeEchoClient(timeoutMs?: number) {
  const transport = new StdioMcpTransport({ command: process.execPath, args: [fixturePath] });
  return new McpClient({
    transport,
    clientInfo: { name: 'aipack-mcp-test', version: '0.1.0' },
    requestTimeoutMs: timeoutMs,
  });
}

/** 最小 Runtime 替身：收集 registerTool / unregisterTool 调用 */
function makeStubRuntime() {
  const registered = new Map<string, { name: string; permissions?: string[]; execute?: (id: string, args?: unknown) => Promise<unknown> }>();
  return {
    registered,
    registerTool(tool: { name: string; permissions?: string[]; execute?: (id: string, args?: unknown) => Promise<unknown> }) {
      registered.set(tool.name, { name: tool.name, permissions: tool.permissions, execute: tool.execute });
    },
    unregisterTool(name: string) {
      return registered.delete(name);
    },
  };
}

describe('McpClient + echo server 端到端', () => {
  test('握手 / tools/list / tools/call / ping', async () => {
    const client = makeEchoClient();
    try {
      const init = await client.connect();
      assert.equal(init.protocolVersion, '2025-06-18');
      assert.equal(init.serverInfo.name, 'echo');
      assert.equal(init.capabilities?.tools?.listChanged, true);

      const tools = await client.listTools();
      assert.ok(tools.some((t) => t.name === 'echo'));
      assert.ok(tools.some((t) => t.name === 'add'));
      assert.ok(tools.some((t) => t.name === 'slow'));

      const echoRes = await client.callTool('echo', { text: 'hello' });
      assert.equal(echoRes.content[0].text, 'hello');
      assert.equal(echoRes.isError, undefined);

      const addRes = await client.callTool('add', { a: 2, b: 3 });
      assert.equal(addRes.content[0].text, '5');

      // client→server ping（fixture 应答 {}）
      await client.ping();
    } finally {
      await client.dispose();
    }
  });

  test('未知工具名返回 isError', async () => {
    const client = makeEchoClient();
    try {
      await client.connect();
      const res = await client.callTool('nope', {});
      assert.equal(res.isError, true);
      assert.match(res.content[0].text ?? '', /unknown tool/);
    } finally {
      await client.dispose();
    }
  });

  test('slow 工具 + 短超时 → 超时拒绝', async () => {
    const client = makeEchoClient(5000);
    try {
      await client.connect();
      await assert.rejects(
        client.callTool('slow', {}, { timeoutMs: 200 }),
        /tools\/call timeout/,
      );
    } finally {
      await client.dispose();
    }
  });

  test('已 abort 的 signal 不阻塞快速工具（cancelled 通知已发送）', async () => {
    const client = makeEchoClient();
    try {
      await client.connect();
      const ac = new AbortController();
      ac.abort();
      // echo 即时返回；abort 仅触发 cancelled 通知（被 server 忽略）
      const res = await client.callTool('echo', { text: 'aborted-but-fast' }, { signal: ac.signal });
      assert.equal(res.content[0].text, 'aborted-but-fast');
    } finally {
      await client.dispose();
    }
  });
});

describe('createMcpPlugin + echo server 端到端', () => {
  test('ready 后工具注册进 runtime；callTool 分发；mcp_status 可用', async () => {
    const rt = makeStubRuntime();
    const mcp = createMcpPlugin({
      servers: [
        {
          name: 'echo',
          transport: { type: 'stdio', command: process.execPath, args: [fixturePath] },
          timeoutMs: 5000,
        },
      ],
    });

    // 模拟 Runtime.apply：构造最小 hooks + context，驱动 McpExtension.setup
    // （注册 mcp_status + 绑定 runtime + tap beforeRun 懒连接）
    const beforeRunTaps: Array<(req: unknown) => Promise<unknown>> = [];
    const fakeHooks = {
      beforeRun: { tapPromise: (_name: string, fn: (req: unknown) => Promise<unknown>) => { beforeRunTaps.push(fn); } },
    } as unknown as RuntimeHooks;
    const fakeContext = {
      runtime: rt,
      config: {},
      workspace: '/',
      sessionKey: 's',
      shared: new Map(),
    } as unknown as ExtensionContext;
    for (const ext of mcp.extensions) ext.apply(fakeHooks, fakeContext);

    try {
      // 模拟 run 前的 beforeRun（懒连接 + 注册工具）
      await beforeRunTaps[0]!({});
      assert.equal(mcp.diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(mcp.diagnostics)}`);

      // MCP 工具 + mcp_status 已注册
      assert.ok(rt.registered.has('echo__echo'));
      assert.ok(rt.registered.has('echo__add'));
      assert.ok(rt.registered.has('echo__slow'));
      assert.ok(rt.registered.has('mcp_status'));

      // 经 registry 调用（走 adapter 映射）
      const echoRes = await mcp.registry.callTool('echo', 'echo', { text: 'via-registry' });
      assert.equal(echoRes.content[0].text, 'via-registry');
      assert.equal(echoRes.isError, undefined);

      const addRes = await mcp.registry.callTool('echo', 'add', { a: 40, b: 2 });
      assert.equal(addRes.content[0].text, '42');

      // mcp_status 工具返回诊断 + 状态
      const statusTool = rt.registered.get('mcp_status')!;
      const statusResult = (await statusTool.execute!('id', {})) as {
        content: Array<{ type: string; text: string }>;
        details: unknown;
      };
      assert.equal(statusResult.content[0].type, 'text');
      const parsed = JSON.parse(statusResult.content[0].text);
      assert.equal(parsed.servers[0].name, 'echo');
      assert.equal(parsed.servers[0].connected, true);
      assert.equal(parsed.servers[0].toolCount, 3);
    } finally {
      await mcp.dispose();
    }
  });

  test('list_changed 通知触发增量 refresh，不崩溃', async () => {
    const rt = makeStubRuntime();
    const mcp = createMcpPlugin({
      servers: [
        { name: 'echo', transport: { type: 'stdio', command: process.execPath, args: [fixturePath] } },
      ],
    });
    mcp.registry.bindRuntime(rt as never);
    try {
      await mcp.ready();
      assert.ok(rt.registered.has('echo__echo'));
      // fixture 在 init 后 ~300ms 发 list_changed；等其处理
      await new Promise((r) => setTimeout(r, 800));
      // 仍应已注册（幂等增量）
      assert.ok(rt.registered.has('echo__echo'));
      assert.ok(rt.registered.has('echo__add'));
    } finally {
      await mcp.dispose();
    }
  });
});
