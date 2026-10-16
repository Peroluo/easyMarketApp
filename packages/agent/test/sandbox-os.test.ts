/**
 * Tier 2 Linux bwrap 沙箱测试（SANDBOX_PLAN §7.2 / §10-M4 + §11.3 红队）。
 *
 * buildBwrapArgv 为纯函数，命令生成映射全平台可测；能力探测与真 bwrap
 * 集成仅在 Linux 生效（Windows 跑 supports=false 与降级路径断言，
 * Linux 集成用例标记 skip）。
 *
 * §11.3 红队逃逸用例（Linux-only describe）：net deny 内核断网 / fork
 * 炸弹进程树清理 / setsid 后台逃逸 die-with-parent 清场 / deny 内核遮蔽 /
 * env clearenv，可用 Docker 容器（node:20-slim + bubblewrap）本地验证。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildBwrapArgv,
  probeLinuxSandboxCaps,
  BwrapSandboxProvider,
  createDefaultSandboxProvider,
} from '../runtime/sandbox/index.ts';
import type { SandboxSpec } from '../index.ts';

const IS_LINUX = process.platform === 'linux';

/** 完备 spec 直构（不走 mergeSpec，映射测试关注 argv 生成而非合并语义） */
function spec(partial: Partial<SandboxSpec>): SandboxSpec {
  return {
    strategy: 'os',
    fs: { readable: [], writable: [] },
    net: { mode: 'deny' },
    env: {},
    resources: {},
    ...partial,
  };
}

function makeSpec(opts: {
  readable?: string[];
  writable?: string[];
  deny?: string[];
  env?: Record<string, string>;
  net?: SandboxSpec['net'];
  resources?: SandboxSpec['resources'];
}): SandboxSpec {
  return spec({
    ...(opts.readable ? { fs: { readable: opts.readable, writable: opts.writable ?? [], deny: opts.deny } } : {}),
    ...(opts.writable && !opts.readable ? { fs: { readable: [], writable: opts.writable, deny: opts.deny } } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.net ? { net: opts.net } : {}),
    ...(opts.resources ? { resources: opts.resources } : {}),
  });
}

const BASE = {
  nodeBin: '/usr/bin/node',
  workerPath: '/opt/aipack/dist/sandbox/worker.js',
  nodeArgs: [],
  toolModules: [],
  denyEmptyFile: '/tmp/aipack-bwrap-x/empty',
};

function indexOfArg(argv: readonly string[], flag: string, value?: string): number {
  const i = argv.indexOf(flag);
  assert.ok(i >= 0, `expected flag ${flag} in argv`);
  if (value !== undefined) {
    assert.ok(argv[i + 1] === value || argv[i + 2] === value, `expected ${flag} ${value}`);
  }
  return i;
}

// ─── 命令生成（纯函数）───────────────────────────────────────────────

describe('buildBwrapArgv：fs spec → bwrap 参数映射', () => {
  it('基础骨架：系统 ro-bind + proc/dev/tmpfs + 命名空间 + clearenv + payload', () => {
    const argv = buildBwrapArgv(spec({}), BASE);
    assert.equal(argv[0], 'bwrap');
    // 系统目录只读（含 /run：systemd dbus socket，配额包装需要）
    assert.deepEqual(argv.slice(1, 3), ['--ro-bind', '/usr']);
    assert.ok(argv.includes('/run'));
    // proc/dev/tmp 基础设施
    for (const f of ['--proc', '--dev', '--tmpfs']) assert.ok(argv.includes(f));
    // 命名空间与父死随消（--unshare-user 显式：容器 root 无 CAP_SYS_ADMIN 场景）
    assert.ok(argv.includes('--unshare-user'));
    assert.ok(argv.includes('--unshare-pid'));
    assert.ok(argv.includes('--die-with-parent'));
    // env 清洗 + 沙箱内 HOME
    const ci = indexOfArg(argv, '--clearenv');
    assert.ok(argv.includes('HOME'));
    assert.ok(argv.includes('/tmp/aipack-sandbox-home'));
    // payload：node workerPath（末尾）
    assert.deepEqual(argv.slice(-2), [BASE.nodeBin, BASE.workerPath]);
    assert.ok(ci > 0);
  });

  it('readable → ro-bind；writable → bind；基础设施目录去重', () => {
    const argv = buildBwrapArgv(
      makeSpec({ readable: ['/data/inputs'], writable: ['/data/work'] }),
      { ...BASE, workerPath: '/srv/app/dist/sandbox/worker.js' },
    );
    assert.ok(argv.includes('--ro-bind'));
    assert.ok(argv.includes('/data/inputs'));
    assert.ok(argv.includes('--bind'));
    assert.ok(argv.includes('/data/work'));
    // nodeBin 在 /usr/bin 下（/usr 已 ro-bind）→ 不重复挂载 /usr/bin
    assert.ok(!argv.includes('/usr/bin'), '已覆盖前缀不重复挂载');
    // worker 目录未被系统前缀覆盖 → ro-bind
    assert.ok(argv.includes('/srv/app/dist/sandbox'));
    assert.ok(argv.includes('--unshare-pid'));
  });

  it('toolModules 目录只读挂载（worker 按名重建注册表的基础设施可见性）', () => {
    const argv = buildBwrapArgv(
      spec({}),
      { ...BASE, toolModules: ['/srv/tools/tools.mjs'] },
    );
    assert.ok(argv.includes('/srv/tools'));
  });

  it('deny 目录 → tmpfs 遮蔽；deny 文件 → 空文件 ro-bind 遮蔽', async () => {
    const denyDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bwrap-deny-'));
    const denyFile = path.join(denyDir, 'file-secret');
    await fs.promises.writeFile(denyFile, 'x');
    try {
      const argv = buildBwrapArgv(
        makeSpec({ readable: ['/ws'], deny: [denyDir, denyFile] }),
        BASE,
      );
      // 目录 → tmpfs
      assert.ok(argv.includes('--tmpfs'));
      assert.ok(argv.includes(denyDir));
      // 文件 → 空文件 ro-bind 覆盖：[--ro-bind, denyEmptyFile, denyFile]
      const i = argv.indexOf(denyFile);
      assert.ok(i > 0, 'deny 文件必须被遮蔽');
      assert.equal(argv[i - 1], BASE.denyEmptyFile);
      assert.equal(argv[i - 2], '--ro-bind');
    } finally {
      await fs.promises.rm(denyDir, { recursive: true, force: true });
    }
  });

  it('deny 不存在且未被任何挂载覆盖 → 跳过（本就不可见）', () => {
    const argv = buildBwrapArgv(
      makeSpec({ deny: ['/nonexistent/nothing'] }),
      BASE,
    );
    assert.ok(!argv.includes('/nonexistent/nothing'));
  });

  it('网络：deny → --unshare-net；proxy 无 forwarder 端口 → fail-closed 断网；allow → 不加', () => {
    assert.ok(buildBwrapArgv(makeSpec({ net: { mode: 'deny' } }), BASE).includes('--unshare-net'));
    // M6：proxy 需宿主 forwarder 端口（netProxyPort）；未提供 = forwarder 不可用 → 保守断网
    assert.ok(buildBwrapArgv(makeSpec({ net: { mode: 'proxy', hosts: ['a.com'] } }), BASE).includes('--unshare-net'));
    assert.ok(!buildBwrapArgv(makeSpec({ net: { mode: 'allow' } }), BASE).includes('--unshare-net'));
  });

  it('env：spec.env 逐键 --setenv（clearenv 后注入）', () => {
    const argv = buildBwrapArgv(
      makeSpec({ env: { MY_KEY: 'v1', OTHER: 'v2' } }),
      BASE,
    );
    assert.ok(argv.includes('MY_KEY'));
    assert.ok(argv.includes('v1'));
    assert.ok(argv.includes('OTHER'));
    assert.ok(argv.includes('v2'));
  });

  it('配额：useQuota + memory/cpu/pids → systemd-run --scope 包装', () => {
    const argv = buildBwrapArgv(
      makeSpec({ resources: { memoryMb: 512, cpuMs: 2500, processes: 64 } }),
      { ...BASE, useQuota: true },
    );
    const si = argv.indexOf('systemd-run');
    assert.ok(si > 0, '配额包装段必须存在');
    assert.equal(argv[si + 1], '--scope');
    assert.ok(argv.includes('MemoryMax=512M'));
    assert.ok(argv.includes('CPUQuota=250%')); // 2500ms CPU/秒 = 250%
    assert.ok(argv.includes('TasksMax=64'));
    // 包装段位于 payload（node）之前
    assert.ok(si < argv.indexOf(BASE.nodeBin));
  });

  it('未启用配额 → 无 systemd-run 段', () => {
    const argv = buildBwrapArgv(
      makeSpec({ resources: { memoryMb: 512 } }),
      BASE,
    );
    assert.ok(!argv.includes('systemd-run'));
  });
});

// ─── 能力探测与路由 ──────────────────────────────────────────────────

describe('BwrapSandboxProvider 能力探测', () => {
  it('supports 探测：非 Linux 恒 false、caps 全 false；Linux 与探测一致', async () => {
    const caps = await probeLinuxSandboxCaps();
    const provider = new BwrapSandboxProvider();
    if (!IS_LINUX) {
      assert.equal(caps.bwrap, false);
      assert.equal(caps.quota, false);
      assert.equal(await provider.supports('os'), false);
      assert.equal(await provider.supports('subprocess'), false);
    } else {
      // Linux：supports 与探测一致（探测为真实验证：能否构造沙箱，非二进制存在）
      assert.equal(await provider.supports('os'), caps.bwrap);
    }
  });

  it('非 Linux 平台 run(os) 显式抛错（须由 default 路由降级）', async () => {
    if (IS_LINUX) return;
    const provider = new BwrapSandboxProvider();
    await assert.rejects(
      () =>
        provider.run({
          toolName: 't',
          toolCallId: 'c',
          args: {},
          spec: spec({ strategy: 'subprocess' }), // 即使策略不符也先于平台检查
          signal: new AbortController().signal,
        }),
      /unavailable|unsupported/,
    );
  });
});

describe('createDefaultSandboxProvider：os/microvm 路由（无 bwrap 环境）', () => {
  const provider = createDefaultSandboxProvider({ toolModules: [] });

  it('supports(microvm) 恒 false（Tier 3 仅预留）', async () => {
    assert.equal(await provider.supports('microvm'), false);
  });

  it('microvm 声明 → 降级链落 subprocess（degraded 事件可见）', async () => {
    if (IS_LINUX) return; // Linux 有 bwrap 时降级目标是 os，路径不同
    const events: { type: string; detail?: Record<string, unknown> }[] = [];
    const result = await provider.run({
      toolName: 't',
      toolCallId: 'c',
      args: {},
      spec: spec({ strategy: 'microvm' }),
      signal: new AbortController().signal,
      onEvent: e => { events.push(e); },
    });
    // Windows 无 bwrap：microvm → subprocess（经 worker 不可用路径返回 error 或降级执行）
    const degraded = events.find(e => e.type === 'degraded');
    assert.ok(degraded, '降级必须发 degraded 事件');
    assert.equal(degraded?.detail?.from, 'microvm');
    assert.ok(
      result.details !== undefined,
      '无论执行成败应产出结构化 ToolResult',
    );
  });
});

// ─── Linux 集成（真 bwrap，Linux CI 上生效）─────────────────────────

describe('BwrapSandboxProvider 集成（Linux）', () => {
  it('声明 os 的 shell 工具经 bwrap 执行成功', { skip: !IS_LINUX }, async () => {
    const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bwrap-it-'));
    const toolsModule = path.join(ws, 'tools.mjs');
    await fs.promises.writeFile(toolsModule, `
import { exec as cb } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(cb);
export default [{
  name: 'shell',
  description: 'x',
  parameters: {},
  async execute() {
    const r = await exec('echo bwrap-ok');
    return { content: [{ type: 'text', text: r.stdout.trim() }], details: {} };
  },
}];
`);
    try {
      const provider = new BwrapSandboxProvider({ toolModules: [toolsModule] });
      assert.equal(await provider.supports('os'), true, 'Linux CI 须具备 bwrap');
      const result = await provider.run({
        toolName: 'shell',
        toolCallId: 'it-1',
        args: {},
        spec: makeSpec({ writable: [ws] }),
        signal: new AbortController().signal,
      });
      assert.equal(result.content[0].type === 'text' ? result.content[0].text : '', 'bwrap-ok');
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('未挂载路径在沙箱内不可见（内核强制）', { skip: !IS_LINUX }, async () => {
    const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bwrap-ws-'));
    const hiddenDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bwrap-hidden-'));
    const sentinel = path.join(hiddenDir, 'secret');
    await fs.promises.writeFile(sentinel, 'SENTINEL');
    const toolsModule = path.join(ws, 'tools.mjs');
    await fs.promises.writeFile(toolsModule, `
import * as fs from 'node:fs';
export default [{
  name: 'probe',
  description: 'x',
  parameters: {},
  async execute(id, args) {
    try { return { content: [{ type: 'text', text: fs.readFileSync(args.p, 'utf8') }], details: {} }; }
    catch { return { content: [{ type: 'text', text: 'ENOENT' }], details: {} }; }
  },
}];
`);
    try {
      const provider = new BwrapSandboxProvider({ toolModules: [toolsModule] });
      // readable/writable 仅 ws；hiddenDir 未挂载 → 沙箱内该路径不存在（内核级）
      const result = await provider.run({
        toolName: 'probe',
        toolCallId: 'it-2',
        args: { p: sentinel },
        spec: makeSpec({ writable: [ws] }),
        signal: new AbortController().signal,
      });
      const text = result.content[0].type === 'text' ? result.content[0].text : '';
      assert.equal(text, 'ENOENT', '未挂载路径必须内核级不可见，读到即逃逸');
    } finally {
      await fs.promises.rm(ws, { recursive: true, force: true }).catch(() => {});
      await fs.promises.rm(hiddenDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ─── §11.3 红队逃逸用例（真 bwrap，Linux 生效；可经 Docker 容器验证）───

describe('BwrapSandboxProvider 红队逃逸用例（§11.3，Linux）', { skip: !IS_LINUX }, () => {
  /** 红队 fixture：net 探针 / fork 炸弹 / setsid 逃逸 / deny 读取 / env 探针 */
  const REDTEAM_TOOLS = `
import net from 'node:net';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
const text = (t) => ({ content: [{ type: 'text', text: t }], details: {} });
export default [
  {
    name: 'net-deny-probe',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    async execute(_id, args) {
      const { host, port } = args ?? {};
      return await new Promise(resolve => {
        const s = net.connect({ host: String(host), port: Number(port), timeout: 3000 });
        s.on('connect', () => { s.destroy(); resolve(text('CONNECTED')); });
        s.on('error', e => { resolve(text('ERR:' + (e.code ?? e.message))); });
        s.on('timeout', () => { s.destroy(); resolve(text('TIMEOUT')); });
      });
    },
  },
  {
    name: 'net-allow-probe',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const server = net.createServer();
      await new Promise(resolve => {
        server.once('error', () => resolve());
        server.listen(18082, '127.0.0.1', () => resolve());
      });
      return await new Promise(resolve => {
        const s = net.connect({ host: '127.0.0.1', port: 18082, timeout: 3000 });
        s.on('connect', () => { s.destroy(); server.close(); resolve(text('CONNECTED')); });
        s.on('error', e => { server.close(); resolve(text('ERR:' + (e.code ?? e.message))); });
        s.on('timeout', () => { s.destroy(); server.close(); resolve(text('TIMEOUT')); });
      });
    },
  },
  {
    name: 'fork-bomb',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    async execute() {
      spawn('bash', ['-c', 'f(){ f|f& };f'], { stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 30000));
      return text('survived');
    },
  },
  {
    name: 'bg-escape',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    async execute() {
      spawn('setsid', ['sleep', '300'], { stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 30000));
      return text('survived');
    },
  },
  {
    name: 'read-denied',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    async execute(_id, args) {
      try { return text(fs.readFileSync(args.p, 'utf8')); }
      catch (e) { return text('E:' + e.code); }
    },
  },
  {
    name: 'env-probe',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const rr = process.env.RR_SECRET ?? 'absent';
      const known = process.env.RR_KNOWN ?? 'absent';
      return text('RR=' + rr + ';KNOWN=' + known);
    },
  },
];
`;

  /** 扫描 /proc 找 cmdline 含 needle 的存活进程（残留断言，不依赖 procps） */
  function findProcs(needle: string): string[] {
    const hits: string[] = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const cmdline = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
        if (cmdline.includes(needle)) hits.push(d);
      } catch {
        // 竞态：扫描瞬间进程已退出
      }
    }
    return hits;
  }

  const resultText = (r: { content: Array<{ type: string; text?: string }> }): string =>
    r.content[0]?.type === 'text' ? (r.content[0] as { text: string }).text : '';

  let redWs: string;
  let redTools: string;
  /** 宿主侧真监听（net deny 判定基准：隔离 netns 内必 refused，逃逸则 connected） */
  const denyProbeServer = net.createServer(() => {});

  before(async () => {
    redWs = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bwrap-red-'));
    redTools = path.join(redWs, 'tools.mjs');
    await fs.promises.writeFile(redTools, REDTEAM_TOOLS);
    await new Promise<void>((resolve, reject) => {
      denyProbeServer.once('error', reject);
      denyProbeServer.listen(0, '127.0.0.1', () => resolve());
    });
  });

  after(async () => {
    denyProbeServer.close();
    await fs.promises.rm(redWs, { recursive: true, force: true }).catch(() => {});
  });

  it('net deny：unshare-net 后内核级断网（宿主监听端口不可达）', async () => {
    const provider = new BwrapSandboxProvider({ toolModules: [redTools] });
    const result = await provider.run({
      toolName: 'net-deny-probe',
      toolCallId: 'rt-net-deny',
      args: { host: '127.0.0.1', port: (denyProbeServer.address() as net.AddressInfo).port },
      spec: makeSpec({ writable: [redWs] }),
      signal: new AbortController().signal,
    });
    const text = resultText(result);
    // 宿主正在监听的回环端口，隔离 netns 内必连不上（local 路由命中但
    // netns 内无监听 → ECONNREFUSED/ENETUNREACH 等）。CONNECTED = 未隔离。
    assert.ok(
      text.startsWith('ERR:'),
      `宿主监听端口在隔离 netns 内不可达，实际: ${text}`,
    );
  });

  it('net allow 对照：回环可自连（证明 deny 失败非容器断网）', async () => {
    const provider = new BwrapSandboxProvider({ toolModules: [redTools] });
    const result = await provider.run({
      toolName: 'net-allow-probe',
      toolCallId: 'rt-net-allow',
      args: {},
      spec: makeSpec({ writable: [redWs], net: { mode: 'allow' } }),
      signal: new AbortController().signal,
    });
    assert.equal(resultText(result), 'CONNECTED');
  });

  it('fork 炸弹：wallClock kill 后进程树零残留（无 systemd 时退化为审计 kill；配额路径需 systemd CI）', { timeout: 30000 }, async () => {
    const provider = new BwrapSandboxProvider({ toolModules: [redTools] });
    const result = await provider.run({
      toolName: 'fork-bomb',
      toolCallId: 'rt-bomb',
      args: {},
      spec: makeSpec({ writable: [redWs], resources: { wallClockMs: 1000 } }),
      signal: new AbortController().signal,
    });
    assert.equal(
      (result.details as Record<string, unknown>)?.killed,
      'wall-clock-timeout',
    );
    // kill(-pid) 杀整组 + die-with-parent 兜底，给清场窗口后扫描 /proc
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(findProcs('f|f').length, 0, 'fork 树必须被清干净（零残留）');
  });

  it('后台进程逃逸：setsid 脱离进程组的进程也被 die-with-parent 清场', { timeout: 30000 }, async () => {
    const provider = new BwrapSandboxProvider({ toolModules: [redTools] });
    const result = await provider.run({
      toolName: 'bg-escape',
      toolCallId: 'rt-bg',
      args: {},
      spec: makeSpec({ writable: [redWs], resources: { wallClockMs: 1000 } }),
      signal: new AbortController().signal,
    });
    assert.equal(
      (result.details as Record<string, unknown>)?.killed,
      'wall-clock-timeout',
    );
    // setsid 使 sleep 300 脱离 kill(-pid) 射程 → 验证 bwrap --die-with-parent
    // （bwrap 前台进程被杀 → 内核清 PID namespace 内全部进程）
    await new Promise(r => setTimeout(r, 2500));
    assert.equal(
      findProcs(`sleep${'\u0000'}300`).length,
      0,
      '脱组后台进程必须被 die-with-parent 内核级清场',
    );
  });

  it('deny 路径：tmpfs 内核遮蔽后不可读（Tier 2 硬边界，对照 Tier 1 软 facade）', async () => {
    const secretDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bwrap-sd-'));
    const secretFile = path.join(secretDir, 'secret');
    await fs.promises.writeFile(secretFile, 'SENTINEL');
    try {
      const provider = new BwrapSandboxProvider({ toolModules: [redTools] });
      const result = await provider.run({
        toolName: 'read-denied',
        toolCallId: 'rt-deny',
        args: { p: secretFile },
        spec: makeSpec({ readable: [secretDir], writable: [redWs], deny: [secretDir] }),
        signal: new AbortController().signal,
      });
      // 双层拦截任一生效即安全目标达成：worker 内 fs facade 先拦（violation
      // 遥测，自定义错误无 code → 'E:undefined'），绕过 facade 时内核 tmpfs
      // 兜底（遮蔽后 ENOENT）。核心断言：SENTINEL 内容绝不可达
      const text = resultText(result);
      assert.ok(text.startsWith('E:'), `deny 路径读取必须被拦截，实际: ${text}`);
      assert.ok(!text.includes('SENTINEL'), 'deny 内容绝不可读');
    } finally {
      await fs.promises.rm(secretDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('env：宿主变量被 clearenv 清除，spec.env 白名单注入可见', async () => {
    process.env['RR_SECRET'] = 'host-secret';
    try {
      const provider = new BwrapSandboxProvider({ toolModules: [redTools] });
      const result = await provider.run({
        toolName: 'env-probe',
        toolCallId: 'rt-env',
        args: {},
        spec: makeSpec({ writable: [redWs], env: { RR_KNOWN: 'v1' } }),
        signal: new AbortController().signal,
      });
      assert.equal(resultText(result), 'RR=absent;KNOWN=v1');
    } finally {
      delete process.env['RR_SECRET'];
    }
  });
});
