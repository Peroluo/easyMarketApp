/**
 * M6 网络代理 + 凭证代理测试（SANDBOX_PLAN §7.3/§7.4 + §10-M6 + §11）。
 *
 * 覆盖：
 * - mergeSpec secrets 白名单合并（交集/单方/缺省，收紧语义）；
 * - 纯函数：netProxyEnv / buildBwrapArgv proxy 分支 / buildSeatbeltProfile proxy 分支；
 * - forwarder 集成（全平台）：HTTP forward 放行与拒绝、CONNECT 隧道放行与拒绝、
 *   hosts 大小写不敏感、审计日志、close 清理；
 * - secrets broker 端到端（Tier 1 真跑 worker）：声明名成功 + process.env 注入、
 *   未声明名拒绝 + violation、宿主不可用 error；
 * - net proxy 端到端（Tier 1 真跑）：工具经框架注入的 HTTP_PROXY 访问白名单
 *   target → 200；白名单外 → 403 + violation 事件；
 * - net.mode 'allow' 直连告警事件；
 * - Linux-only（§10-M6 双测试）：bwrap proxy 真跑放行/拒绝（deny 路径真跑
 *   见 sandbox-os.test.ts §11.3）。
 */

import { test, describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeSpec,
} from '../index.ts';
import {
  SubprocessSandboxProvider,
  BwrapSandboxProvider,
  probeLinuxSandboxCaps,
} from '../runtime/sandbox/index.ts';
import {
  netProxyEnv,
  startNetForwarder,
  type NetForwarder,
} from '../runtime/sandbox/net-proxy.ts';
import { buildBwrapArgv } from '../runtime/sandbox/bwrap.ts';
import { buildSeatbeltProfile } from '../runtime/sandbox/seatbelt.ts';
import type {
  SandboxEvent,
  SandboxRunRequest,
  SandboxSpec,
} from '../index.ts';
// mergeSpec 与 provider 类型分属不同模块：mergeSpec 在包根（core re-export）

const IS_LINUX = process.platform === 'linux';

// ─── 测试环境与工具 ──────────────────────────────────────────────────

/** fixture 工具模块（worker 按 toolModules 重建注册表）：
 *  secret-probe 走 broker API；net-probe 走框架注入的 HTTP_PROXY forward proxy */
const TOOLS_SOURCE = `
import * as http from 'node:http';

const text = t => ({ content: [{ type: 'text', text: t }], details: {} });

export default [
  {
    name: 'echo',
    description: 'echo args back',
    parameters: { type: 'object', properties: {} },
    async execute(toolCallId, args) {
      return text('echo:' + JSON.stringify(args));
    },
  },
  {
    name: 'secret-probe',
    description: 'request a secret via the host broker',
    parameters: { type: 'object', properties: {} },
    async execute(toolCallId, args) {
      const api = globalThis.__aipackSandbox;
      try {
        const v = await api.requestSecret(args.name);
        return text(JSON.stringify({ ok: true, value: v, env: process.env[args.name] ?? '(absent)' }));
      } catch (e) {
        return text(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
      }
    },
  },
  {
    name: 'net-probe',
    description: 'fetch absolute URL via HTTP_PROXY forward proxy',
    parameters: { type: 'object', properties: {} },
    async execute(toolCallId, args) {
      const proxy = process.env.HTTP_PROXY ?? '';
      const m = /^http:\\/\\/127\\.0\\.0\\.1:(\\d+)$/.exec(proxy);
      if (m === null) {
        return text(JSON.stringify({ error: 'HTTP_PROXY not set as expected', proxy }));
      }
      try {
        const r = await new Promise((resolve, reject) => {
          let body = '';
          const req = http.request(
            { host: '127.0.0.1', port: Number(m[1]), path: args.url, method: 'GET' },
            res => {
              res.on('data', c => { body += c; });
              res.on('end', () => resolve({ status: res.statusCode, body }));
            },
          );
          req.on('error', reject);
          req.end();
        });
        return text(JSON.stringify(r));
      } catch (e) {
        return text(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
      }
    },
  },
];
`;

let workspace: string;
let toolsModule: string;
/** 本地 target HTTP server（forwarder 放行目标） */
let targetServer: http.Server;
let targetPort: number;
/** 本地 TCP echo server（CONNECT 隧道目标） */
let echoServer: net.Server;
let echoPort: number;

const workerTs = fileURLToPath(new URL('../runtime/sandbox/worker.ts', import.meta.url));
const tsxEntryUrl = import.meta.resolve('tsx');

const HOST_SECRET_VAR = 'AIPACK_TEST_SECRET';
const HOST_SECRET_VALUE = 'm6-broker-secret-value';
const OTHER_SECRET_VAR = 'AIPACK_M6_UNDECLARED';

function makeProvider(toolModules: string[] = [toolsModule]): SubprocessSandboxProvider {
  return new SubprocessSandboxProvider({
    workerPath: workerTs,
    nodeArgs: ['--import', tsxEntryUrl],
    toolModules,
  });
}

/** mergeSpec 构造完备 spec（net/secrets/env 透传） */
function makeSpec(partial?: {
  net?: SandboxSpec['net'];
  secrets?: string[];
  env?: Record<string, string>;
}): SandboxSpec {
  return mergeSpec(
    undefined,
    {
      ...(partial?.net ? { net: partial.net } : {}),
      ...(partial?.secrets ? { secrets: partial.secrets } : {}),
      ...(partial?.env ? { env: partial.env } : {}),
    },
    workspace,
  );
}

function makeReq(opts: {
  toolName: string;
  args?: unknown;
  spec?: SandboxSpec;
  events?: SandboxEvent[];
}): SandboxRunRequest {
  return {
    toolName: opts.toolName,
    toolCallId: `tc_${Math.random().toString(36).slice(2, 10)}`,
    args: opts.args ?? {},
    spec: opts.spec ?? makeSpec(),
    signal: new AbortController().signal,
    ...(opts.events ? { onEvent: e => { opts.events!.push(e); } } : {}),
  };
}

/** 请求 target URL（forward proxy 形态：绝对 URI 走 forwarder） */
function proxyFetch(
  forwarderPort: number,
  url: string,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    let body = '';
    const req = http.request(
      { host: '127.0.0.1', port: forwarderPort, path: url, method: 'GET' },
      res => {
        res.on('data', (c: Buffer) => { body += c.toString('utf8'); });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 发起 CONNECT 隧道请求（返回响应头状态与后续可写 socket） */
function connectRequest(
  forwarderPort: number,
  target: string,
): Promise<{ status: number | undefined; socket?: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: forwarderPort, method: 'CONNECT', path: target,
    });
    req.on('connect', (res, socket) => {
      resolve({ status: res.statusCode, socket });
    });
    req.on('error', reject);
    req.end();
  });
}

function listen0(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr !== null && typeof addr !== 'object') {
        reject(new Error('unexpected listen address'));
        return;
      }
      resolve(addr.port);
    });
  });
}

function closeServer(server: net.Server | http.Server): Promise<void> {
  return new Promise(resolve => {
    (server as http.Server).closeAllConnections?.();
    server.close(() => resolve());
  });
}

// ─── 契约层：mergeSpec secrets ───────────────────────────────────────

describe('mergeSpec secrets（凭证白名单合并，收紧语义）', () => {
  it('双方都定义取交集（大小写不敏感，保留 tool 侧拼写）', () => {
    const spec = mergeSpec(
      { secrets: ['A_KEY', 'B_KEY'] },
      { secrets: ['a_key', 'C_KEY'] },
    );
    assert.deepEqual(spec.secrets, ['a_key']);
  });

  it('单方定义取单方；都缺省 → 不携带（broker 未启用）', () => {
    assert.deepEqual(mergeSpec({ secrets: ['A'] }, {}).secrets, ['A']);
    assert.deepEqual(mergeSpec({}, { secrets: ['B'] }).secrets, ['B']);
    assert.equal(mergeSpec({}, {}).secrets, undefined);
  });

  it('defaults 与 tool 声明联合后 secrets 过滤保持白名单语义', () => {
    // 实际语义：交集（运行时收紧）；空 defaults hosts 同款——显式空数组收紧为全禁
    const spec = mergeSpec({ secrets: [] }, { secrets: ['A', 'B'] });
    assert.deepEqual(spec.secrets, []);
  });
});

// ─── 纯函数：proxy env 与命令生成 ────────────────────────────────────

describe('netProxyEnv（worker env 注入集）', () => {
  it('大写/小写变体 + NO_PROXY 防环（loopback 自身不走代理）', () => {
    const env = netProxyEnv(39921);
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:39921');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:39921');
    assert.equal(env.http_proxy, 'http://127.0.0.1:39921');
    assert.equal(env.https_proxy, 'http://127.0.0.1:39921');
    assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
    assert.equal(env.no_proxy, '127.0.0.1,localhost');
  });
});

const BWRAP_BASE = {
  nodeBin: '/usr/bin/node',
  workerPath: '/opt/aipack/dist/sandbox/worker.js',
  nodeArgs: [] as string[],
  toolModules: [] as string[],
  denyEmptyFile: '/tmp/aipack-bwrap-x/empty',
};

function osSpec(net: SandboxSpec['net']): SandboxSpec {
  return {
    strategy: 'os',
    fs: { readable: [], writable: [] },
    net,
    env: {},
    resources: {},
  };
}

describe('buildBwrapArgv net 三分支（M6）', () => {
  it('proxy + forwarder 端口：不 unshare-net + 注入代理 setenv', () => {
    const argv = buildBwrapArgv(osSpec({ mode: 'proxy', hosts: ['a.com'] }), {
      ...BWRAP_BASE,
      netProxyPort: 39921,
    });
    assert.ok(!argv.includes('--unshare-net'), 'proxy 有 forwarder 时不得断网');
    const i = argv.indexOf('--setenv');
    assert.ok(i >= 0, '必须注入代理 setenv');
    // HTTP_PROXY 值与端口
    const hp = argv.indexOf('HTTP_PROXY');
    assert.ok(hp > 0 && argv[hp + 1] === 'http://127.0.0.1:39921');
    // 代理 setenv 在 spec.env 之后（网络段位于 env 段后）
    const clearenv = argv.indexOf('--clearenv');
    assert.ok(clearenv > 0 && hp > clearenv);
  });

  it('deny：--unshare-net（强保证不变）', () => {
    assert.ok(
      buildBwrapArgv(osSpec({ mode: 'deny' }), BWRAP_BASE).includes('--unshare-net'),
    );
  });

  it('allow：不加 unshare-net 也不注入代理 setenv（直连）', () => {
    const argv = buildBwrapArgv(osSpec({ mode: 'allow' }), BWRAP_BASE);
    assert.ok(!argv.includes('--unshare-net'));
    assert.ok(!argv.includes('HTTP_PROXY'));
  });
});

const SEATBELT_OPTS = {
  homePath: '/tmp/aipack-seatbelt-x',
  nodeBin: '/usr/local/bin/node',
  workerPath: '/opt/aipack/dist/sandbox/worker.js',
};

describe('buildSeatbeltProfile net 分支（M6）', () => {
  it('proxy + forwarder 端口：仅放行 network-outbound 到 127.0.0.1:port', () => {
    const p = buildSeatbeltProfile(osSpec({ mode: 'proxy', hosts: ['a.com'] }), {
      ...SEATBELT_OPTS,
      netProxyPort: 39921,
    });
    assert.ok(p.includes('(allow network-outbound (remote ip "127.0.0.1:39921"))'));
    assert.ok(!p.includes('(allow network*)'), 'proxy 不得放行全量 network*');
  });

  it('proxy 无端口：保持 deny default（fail-closed）', () => {
    const p = buildSeatbeltProfile(osSpec({ mode: 'proxy', hosts: ['a.com'] }), SEATBELT_OPTS);
    assert.ok(!p.includes('network'));
  });
});

// ─── forwarder 集成（全平台）─────────────────────────────────────────

describe('NetForwarder（本地 HTTP(S) forwarder）', () => {
  let forwarder: NetForwarder;
  let violations: { host: string; method: string }[];

  before(async () => {
    targetServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`pong:${req.url}`);
    });
    targetPort = await listen0(targetServer);
    echoServer = net.createServer(s => {
      s.pipe(s);
    });
    echoPort = await listen0(echoServer);
  });

  after(async () => {
    await closeServer(targetServer);
    await closeServer(echoServer);
  });

  beforeEach(async () => {
    violations = [];
    forwarder = await startNetForwarder({
      hosts: ['127.0.0.1', 'EXAMPLE.com'],
      onViolation: v => { violations.push(v); },
    });
  });

  afterEach(async () => {
    await forwarder.close();
  });

  it('HTTP forward：白名单 host 放行并转发 + 审计 allowed=true', async () => {
    const r = await proxyFetch(forwarder.port, `http://127.0.0.1:${targetPort}/ping?a=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'pong:/ping?a=1');
    const entry = forwarder.auditLog.find(e => e.host === '127.0.0.1');
    assert.ok(entry, '必须有审计条目');
    assert.equal(entry.allowed, true);
    assert.equal(entry.method, 'GET');
    assert.ok(entry.bytes > 0, '审计需记录字节量');
    assert.equal(violations.length, 0);
  });

  it('HTTP forward：白名单外 host → 403 + violation 回调 + 审计 allowed=false', async () => {
    const r = await proxyFetch(forwarder.port, `http://10.255.255.1:9/x`);
    assert.equal(r.status, 403);
    assert.match(r.body, /not allowed/);
    assert.equal(violations[0]?.host, '10.255.255.1');
    assert.equal(violations[0]?.method, 'GET');
    const entry = forwarder.auditLog.find(e => e.host === '10.255.255.1');
    assert.ok(entry && entry.allowed === false && entry.reason === 'host-not-allowed');
  });

  it('hosts 大小写不敏感（EXAMPLE.com ↔ example.com 放行决策）', async () => {
    // 白名单 EXAMPLE.com，请求 example.com：匹配放行（审计 allowed=true）；
    // upstream 是真外网域名端口 1（必然连接失败 → 502）——本用例只验证
    // 匹配决策（403=未匹配 vs 非403=放行），不依赖外网连通
    const r = await proxyFetch(forwarder.port, 'http://example.com:1/c');
    assert.notEqual(r.status, 403, '白名单 EXAMPLE.com 必须匹配小写请求 host');
    const entry = forwarder.auditLog.find(e => e.host === 'example.com');
    assert.ok(entry && entry.allowed === true, '审计须记录放行决策');
    assert.equal(violations.length, 0);
    // 对照组：白名单外大写 host → 403 拒绝
    const r2 = await proxyFetch(forwarder.port, 'http://EV.COM:1/c');
    assert.equal(r2.status, 403);
    assert.equal(violations[0]?.host, 'ev.com', 'violation 回调 host 小写化');
  });

  it('CONNECT 隧道：白名单 host 双向管道 + 字节审计', async () => {
    const { status, socket } = await connectRequest(forwarder.port, `127.0.0.1:${echoPort}`);
    assert.equal(status, 200);
    assert.ok(socket, '隧道建立后必须有 socket');
    const echoed = await new Promise<string>(resolve => {
      socket!.once('data', (c: Buffer) => resolve(c.toString('utf8')));
      socket!.write('ping-echo');
    });
    assert.equal(echoed, 'ping-echo');
    const entry = forwarder.auditLog.find(e => e.method === 'CONNECT');
    assert.ok(entry && entry.host === '127.0.0.1' && entry.allowed === true);
    assert.ok(entry!.bytes >= 'ping-echo'.length * 2, '双向字节量计入审计');
    socket!.destroy();
  });

  it('CONNECT 隧道：白名单外 → 403 + violation', async () => {
    const { status, socket } = await connectRequest(forwarder.port, '10.255.255.1:443');
    assert.equal(status, 403);
    socket?.destroy();
    assert.equal(violations[0]?.method, 'CONNECT');
    assert.equal(violations[0]?.host, '10.255.255.1');
  });

  it('close 后端口不可再连（会话收尾无泄漏）', async () => {
    const port = forwarder.port;
    await forwarder.close();
    await assert.rejects(() => proxyFetch(port, 'http://127.0.0.1/x'));
  });

  it('空 hosts 白名单 = 代理全拒（等效 deny）', async () => {
    const f = await startNetForwarder({ hosts: [] });
    try {
      const r = await proxyFetch(f.port, `http://127.0.0.1:${targetPort}/ping`);
      assert.equal(r.status, 403);
    } finally {
      await f.close();
    }
  });
});

// ─── secrets broker + net proxy 端到端（Tier 1 真跑 worker）──────────

describe('M6 端到端（Tier 1 subprocess，真 spawn worker）', () => {
  before(async () => {
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aipack-m6-test-'));
    toolsModule = path.join(workspace, 'tools.mjs');
    await fs.promises.writeFile(toolsModule, TOOLS_SOURCE);
    targetServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`pong:${req.url}`);
    });
    targetPort = await listen0(targetServer);
    process.env[HOST_SECRET_VAR] = HOST_SECRET_VALUE;
  });

  after(async () => {
    delete process.env[HOST_SECRET_VAR];
    delete process.env[OTHER_SECRET_VAR];
    await closeServer(targetServer);
    await fs.promises.rm(workspace, { recursive: true, force: true }).catch(() => {});
  });

  it('secrets broker：声明名请求成功 + 发放值注入 worker 自身 env', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq({
      toolName: 'secret-probe',
      args: { name: HOST_SECRET_VAR },
      spec: makeSpec({ secrets: [HOST_SECRET_VAR] }),
      events,
    }))) as { content: { text: string }[] };
    const r = JSON.parse(result.content[0].text) as {
      ok: boolean; value: string; env: string;
    };
    assert.equal(r.ok, true, result.content[0].text);
    assert.equal(r.value, HOST_SECRET_VALUE);
    assert.equal(r.env, HOST_SECRET_VALUE, '发放值必须注入 worker process.env');
    assert.ok(!events.some(e => e.type === 'violation'), '声明名请求不得发 violation');
  });

  it('secrets broker：未声明名 → 拒绝 + violation 事件（fail-closed）', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq({
      toolName: 'secret-probe',
      args: { name: OTHER_SECRET_VAR },
      spec: makeSpec({ secrets: [HOST_SECRET_VAR] }),
      events,
    }))) as { content: { text: string }[] };
    const r = JSON.parse(result.content[0].text) as { ok: boolean; error: string };
    assert.equal(r.ok, false);
    assert.match(r.error, /not declared/);
    const violation = events.find(
      e => e.type === 'violation' &&
        (e.detail as { kind?: string; reason?: string } | undefined)?.kind === 'secret',
    );
    assert.ok(violation, '未声明凭证请求必须有 violation 事件');
    assert.equal(
      (violation?.detail as { reason?: string } | undefined)?.reason,
      'not-declared',
    );
  });

  it('secrets broker：声明但宿主不可用 → error 响应（非 violation）', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq({
      toolName: 'secret-probe',
      args: { name: 'AIPACK_M6_MISSING' },
      spec: makeSpec({ secrets: ['AIPACK_M6_MISSING'] }),
      events,
    }))) as { content: { text: string }[] };
    const r = JSON.parse(result.content[0].text) as { ok: boolean; error: string };
    assert.equal(r.ok, false);
    assert.match(r.error, /not available/);
    assert.ok(!events.some(e => e.type === 'violation'), '宿主侧缺失非违规');
  });

  it('secrets broker：未声明 secrets（spec.secrets 缺省）→ 一切请求拒绝', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq({
      toolName: 'secret-probe',
      args: { name: HOST_SECRET_VAR },
      spec: makeSpec(), // 未声明 secrets
      events,
    }))) as { content: { text: string }[] };
    const r = JSON.parse(result.content[0].text) as { ok: boolean; error: string };
    assert.equal(r.ok, false);
    assert.match(r.error, /not declared/);
    assert.ok(events.some(
      e => e.type === 'violation' &&
        (e.detail as { kind?: string } | undefined)?.kind === 'secret',
    ));
  });

  it('net proxy：工具经框架注入的 HTTP_PROXY 访问白名单 target → 200', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq({
      toolName: 'net-probe',
      args: { url: `http://127.0.0.1:${targetPort}/allow-me` },
      spec: makeSpec({ net: { mode: 'proxy', hosts: ['127.0.0.1'] } }),
      events,
    }))) as { content: { text: string }[] };
    const r = JSON.parse(result.content[0].text) as { status: number; body: string };
    assert.equal(r.status, 200, result.content[0].text);
    assert.equal(r.body, 'pong:/allow-me');
    assert.ok(!events.some(e => e.type === 'violation'));
  });

  it('net proxy：白名单外 target → 403 + violation(kind=net) 事件', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq({
      toolName: 'net-probe',
      args: { url: `http://10.255.255.1:9/evil` },
      spec: makeSpec({ net: { mode: 'proxy', hosts: ['127.0.0.1'] } }),
      events,
    }))) as { content: { text: string }[] };
    const r = JSON.parse(result.content[0].text) as { status: number; body?: string };
    assert.equal(r.status, 403, result.content[0].text);
    const violation = events.find(
      e => e.type === 'violation' &&
        (e.detail as { kind?: string } | undefined)?.kind === 'net',
    );
    assert.ok(violation, '白名单外网络访问必须有 violation 事件');
    assert.equal(
      (violation?.detail as { host?: string } | undefined)?.host,
      '10.255.255.1',
    );
  });

  it('net proxy：spec.env 的 HTTP_PROXY 被框架覆盖（proxy 模式出口归框架）', async () => {
    const provider = makeProvider();
    const result = (await provider.run(makeReq({
      toolName: 'net-probe',
      args: { url: `http://127.0.0.1:${targetPort}/override` },
      spec: makeSpec({
        net: { mode: 'proxy', hosts: ['127.0.0.1'] },
        env: { HTTP_PROXY: 'http://10.9.9.9:1' }, // 用户试图指定出口 → 必须被覆盖
      }),
    }))) as { content: { text: string }[] };
    const r = JSON.parse(result.content[0].text) as { status: number };
    assert.equal(r.status, 200, result.content[0].text);
  });

  it('net allow：直连 + degraded 告警事件（提示收敛）', async () => {
    const provider = makeProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq({
      toolName: 'echo',
      args: { ok: 1 },
      spec: makeSpec({ net: { mode: 'allow' } }),
      events,
    }))) as { content: { text: string }[] };
    assert.match(result.content[0].text, /echo/);
    const warn = events.find(
      e => e.type === 'degraded' &&
        (e.detail as { reason?: string } | undefined)?.reason === 'net-allow-direct',
    );
    assert.ok(warn, 'net.mode allow 必须发告警事件');
  });

  it('deny / proxy 非 proxy 模式：无 HTTP_PROXY 注入（env 不含代理键）', async () => {
    const provider = makeProvider();
    const result = (await provider.run(makeReq({
      toolName: 'net-probe',
      args: { url: `http://127.0.0.1:${targetPort}/x` },
      spec: makeSpec({ net: { mode: 'deny' } }),
    }))) as { content: { text: string }[] };
    const r = JSON.parse(result.content[0].text) as { error?: string; proxy?: string };
    assert.ok(r.error !== undefined, 'deny 模式下不得有框架代理注入');
    assert.match(r.error, /HTTP_PROXY not set/);
  });
});

// ─── Linux-only：bwrap proxy 真跑（§10-M6 双测试，deny 见 sandbox-os）──

describe('M6 Linux bwrap proxy 真跑（§11.3 红队补面）', { skip: !IS_LINUX }, () => {
  let bwrapWs: string;
  let bwrapTools: string;
  let bwrapTarget: http.Server;
  let bwrapTargetPort: number;

  before(async () => {
    const caps = await probeLinuxSandboxCaps();
    assert.ok(caps.bwrap, '本组用例需 bwrap 可用（Docker: node:20-slim + bubblewrap）');
    bwrapWs = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aipack-m6-bwrap-'));
    bwrapTools = path.join(bwrapWs, 'tools.mjs');
    await fs.promises.writeFile(bwrapTools, TOOLS_SOURCE);
    bwrapTarget = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`pong:${req.url}`);
    });
    bwrapTargetPort = await listen0(bwrapTarget);
  });

  after(async () => {
    if (bwrapTarget !== undefined) await closeServer(bwrapTarget);
    if (bwrapWs !== undefined) {
      await fs.promises.rm(bwrapWs, { recursive: true, force: true }).catch(() => {});
    }
  });

  function makeBwrapProvider(): BwrapSandboxProvider {
    // 与 sandbox-os.test.ts 一致：依赖默认 resolveWorkerPath()（dist 产物，
    // self-contained worker）——bwrap 最小挂载面不含 tsx 的 node_modules，
    // 源码形态（worker.ts + --import tsx）在沙箱内不可行
    return new BwrapSandboxProvider({
      toolModules: [bwrapTools],
    });
  }

  /** Linux 组独立 spec：workspace 用本组 bwrapWs（Tier 1 组 after 已删其
   *  workspace，全局 makeSpec 引用已删除路径会让 bwrap bind 失败） */
  function makeLinuxSpec(net: SandboxSpec['net']): SandboxSpec {
    return { ...mergeSpec(undefined, { net }, bwrapWs), strategy: 'os' };
  }

  it('proxy：bwrap 沙箱内经宿主 forwarder 放行白名单 target', async () => {
    const provider = makeBwrapProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq({
      toolName: 'net-probe',
      args: { url: `http://127.0.0.1:${bwrapTargetPort}/via-bwrap` },
      spec: makeLinuxSpec({ mode: 'proxy', hosts: ['127.0.0.1'] }),
      events,
    }))) as { content: { text: string }[] };
    const r = JSON.parse(result.content[0].text) as { status: number; body: string };
    assert.equal(r.status, 200, result.content[0].text);
    assert.equal(r.body, 'pong:/via-bwrap');
  });

  it('proxy：bwrap 沙箱内白名单外 target → 403 + violation', async () => {
    const provider = makeBwrapProvider();
    const events: SandboxEvent[] = [];
    const result = (await provider.run(makeReq({
      toolName: 'net-probe',
      args: { url: 'http://10.255.255.1:9/evil' },
      spec: makeLinuxSpec({ mode: 'proxy', hosts: ['127.0.0.1'] }),
      events,
    }))) as { content: { text: string }[] };
    const r = JSON.parse(result.content[0].text) as { status: number };
    assert.equal(r.status, 403, result.content[0].text);
    assert.ok(events.some(
      e => e.type === 'violation' &&
        (e.detail as { kind?: string } | undefined)?.kind === 'net',
    ));
  });
});

// 兜底：非 Linux 平台给 Linux-only 组一条静态存在性断言（计数稳定）
test('M6 平台占位：非 Linux 跳过 bwrap 真跑组', { skip: IS_LINUX }, () => {
  assert.ok(!IS_LINUX);
});
