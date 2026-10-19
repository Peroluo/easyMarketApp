/**
 * M5 Windows/macOS OS 层补强测试（SANDBOX_PLAN §10-M5）。
 *
 * - audit-win 纯函数（parseCsvLine / aggregateTree / checkResourceLimits）全平台可测；
 * - seatbelt profile 模板生成纯函数全平台可测；
 * - SeatbeltSandboxProvider 能力探测：非 darwin 恒 false + run 显式抛错；
 *   darwin 真跑 sandbox-exec 留 macOS CI（profile experimental 校准）；
 * - Windows 真进程树审计集成（声明限额超限 → 事后审计 kill）仅 Windows 生效。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SeatbeltSandboxProvider,
  SubprocessSandboxProvider,
  createWindowsProcessAudit,
  parseCsvLine,
  aggregateTree,
  checkResourceLimits,
  PROCESS_LIMIT_REASON,
  MEMORY_LIMIT_REASON,
} from '../runtime/sandbox/index.ts';
import { buildSeatbeltProfile } from '../runtime/sandbox/seatbelt.ts';
import { mergeSpec } from '../index.ts';
import type {
  SandboxEvent,
  SandboxRunRequest,
  SandboxSpec,
} from '../index.ts';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ─── audit-win：CSV 解析（纯函数）─────────────────────────────────────

describe('parseCsvLine（PowerShell ConvertTo-Csv 转义）', () => {
  it('基础逗号分隔', () => {
    assert.deepEqual(parseCsvLine('"1","2","3"'), ['1', '2', '3']);
  });

  it('引号内逗号不拆分字段', () => {
    assert.deepEqual(parseCsvLine('"a,b","c"'), ['a,b', 'c']);
  });

  it('双引号转义 "" 还原为单引号', () => {
    assert.deepEqual(parseCsvLine('"x""y","z"'), ['x"y', 'z']);
  });

  it('无引号字段与空字段', () => {
    assert.deepEqual(parseCsvLine('1,2,"",4'), ['1', '2', '', '4']);
  });
});

// ─── audit-win：进程树聚合（纯函数）───────────────────────────────────

describe('aggregateTree（BFS 建树 + 环防御）', () => {
  const rows = [
    { pid: 1, ppid: 0, workingSetBytes: 100 }, // 无关节点（root=10 的树外）
    { pid: 10, ppid: 1, workingSetBytes: 200 }, // root
    { pid: 11, ppid: 10, workingSetBytes: 300 },
    { pid: 12, ppid: 11, workingSetBytes: 400 },
    { pid: 13, ppid: 10, workingSetBytes: 50 },
    { pid: 99, ppid: 0, workingSetBytes: 999 }, // 树外
  ];

  it('自 root 起聚合整棵子树：进程数与内存合计', () => {
    const r = aggregateTree(10, rows);
    assert.equal(r.processes, 4); // 10,11,12,13
    assert.equal(r.memoryBytes, 200 + 300 + 400 + 50);
  });

  it('root 不在进程表也计入自身（正常退出竞态下不误杀归零）', () => {
    const r = aggregateTree(55555, rows);
    assert.equal(r.processes, 1);
    assert.equal(r.memoryBytes, 0);
  });

  it('pid 复用环不无限循环', () => {
    const cyclic = [
      { pid: 20, ppid: 21 },
      { pid: 21, ppid: 20 },
      { pid: 22, ppid: 20 },
    ];
    const r = aggregateTree(20, cyclic);
    assert.equal(r.processes, 3); // 20,21,22 各计一次后终止
  });
});

// ─── audit-win：阈值判定（纯函数）─────────────────────────────────────

describe('checkResourceLimits（processes 优先）', () => {
  it('processes 超限 → process-limit（优先于内存判定）', () => {
    assert.equal(
      checkResourceLimits({ processes: 5, memoryBytes: 10 ** 12 }, { processes: 4, memoryMb: 1 }),
      PROCESS_LIMIT_REASON,
    );
  });

  it('memory 超限 → memory-limit', () => {
    assert.equal(
      checkResourceLimits({ processes: 1, memoryBytes: 2 * 1024 * 1024 }, { memoryMb: 1 }),
      MEMORY_LIMIT_REASON,
    );
  });

  it('未声明字段不判定；未超限返回 undefined', () => {
    assert.equal(checkResourceLimits({ processes: 99, memoryBytes: 0 }, { memoryMb: 1 }), undefined);
    assert.equal(checkResourceLimits({ processes: 1, memoryBytes: 1024 }, { processes: 8 }), undefined);
    assert.equal(checkResourceLimits({ processes: 1, memoryBytes: 1024 }, {}), undefined);
  });
});

// ─── seatbelt：profile 模板生成（纯函数）──────────────────────────────

function macSpec(partial?: { readable?: string[]; writable?: string[]; deny?: string[]; net?: SandboxSpec['net']; env?: Record<string, string> }): SandboxSpec {
  const spec = mergeSpec(undefined, {
    ...(partial?.readable || partial?.writable || partial?.deny
      ? { fs: { readable: partial.readable ?? [], writable: partial.writable ?? [], deny: partial.deny } }
      : {}),
    ...(partial?.net ? { net: partial.net } : {}),
    ...(partial?.env ? { env: partial.env } : {}),
  }, '/ws');
  return { ...spec, strategy: 'os' };
}

const PROFILE_OPTS = {
  homePath: '/tmp/aipack-seatbelt-x',
  nodeBin: '/usr/local/bin/node',
  workerPath: '/opt/app/dist/sandbox/worker.js',
  toolModules: ['/opt/app/tools/tools.mjs'],
};

describe('buildSeatbeltProfile（fs/net/env → profile 映射）', () => {
  const profile = buildSeatbeltProfile(macSpec(), PROFILE_OPTS);

  it('基线：version 1 + deny default + 进程/系统调用放行', () => {
    const lines = profile.split('\n');
    assert.equal(lines[0], '(version 1)');
    assert.equal(lines[1], '(deny default)');
    assert.ok(profile.includes('(allow process-exec*)'));
    // posix_spawn 的 fork 需独立授权；操作名不带星号（带星号是非法形式，
    // sandbox-exec 拒绝加载）—— 真机校准结论，见 seatbelt.ts 注释
    assert.ok(profile.includes('(allow process-fork)'));
    assert.ok(!profile.includes('process-fork*'));
    assert.ok(profile.includes('(allow mach-lookup)'));
  });

  it('读取面全放行（macOS 初始化限制）+ 基础设施目录 + HOME 临时目录读写', () => {
    // 真机校准：按目录收窄 file-read 会命中初始化期未知路径 → SIGABRT
    // （/bin/echo 都无法存活），读取面只能全放行；隔离边界在写入面 + deny
    assert.ok(profile.includes('(allow file-read* (subpath "/"))'));
    // node/worker/toolModules 所在目录保留映射（全局读下冗余，语义可追溯）
    assert.ok(profile.includes('(subpath "/usr/local/bin")'));
    assert.ok(profile.includes('(subpath "/opt/app/dist/sandbox")'));
    assert.ok(profile.includes('(subpath "/opt/app/tools")'));
    // HOME 读写（工具临时文件落点）
    assert.ok(profile.includes(`(allow file-read* (subpath "${PROFILE_OPTS.homePath}"))`));
    assert.ok(profile.includes(`(allow file-write* (subpath "${PROFILE_OPTS.homePath}"))`));
  });

  it('readable 只读 / writable 读写 / deny 显式拒绝', () => {
    const p = buildSeatbeltProfile(
      macSpec({ readable: ['/data/in'], writable: ['/data/work'], deny: ['/data/secret'] }),
      PROFILE_OPTS,
    );
    assert.ok(p.includes('(allow file-read* (subpath "/data/in"))'));
    assert.ok(!p.includes('(allow file-write* (subpath "/data/in"))'));
    assert.ok(p.includes('(allow file-read* (subpath "/data/work"))'));
    assert.ok(p.includes('(allow file-write* (subpath "/data/work"))'));
    assert.ok(p.includes('(deny file-read* (subpath "/data/secret"))'));
    assert.ok(p.includes('(deny file-write* (subpath "/data/secret"))'));
  });

  it('网络：deny/proxy 无 forwarder 端口缺省断网（deny default 涵盖）；allow → (allow network*)', () => {
    const deny = buildSeatbeltProfile(macSpec({ net: { mode: 'deny' } }), PROFILE_OPTS);
    assert.ok(!deny.includes('network*'));
    // M6：proxy 需 netProxyPort（forwarder 可用）；未提供 = 不可用 → 保持 deny default
    const proxy = buildSeatbeltProfile(macSpec({ net: { mode: 'proxy', hosts: ['a.com'] } }), PROFILE_OPTS);
    assert.ok(!proxy.includes('network*'), 'proxy 无 forwarder 端口 = fail-closed 保守断网');
    const allow = buildSeatbeltProfile(macSpec({ net: { mode: 'allow' } }), PROFILE_OPTS);
    assert.ok(allow.includes('(allow network*)'));
  });

  it('spec.env 不进 profile（macOS env 由宿主 spawn 白名单构造）', () => {
    const p = buildSeatbeltProfile(macSpec({ env: { MY_KEY: 'v1' } }), PROFILE_OPTS);
    assert.ok(!p.includes('MY_KEY'));
  });
});

// ─── SeatbeltSandboxProvider 能力探测与路由 ───────────────────────────

const workerTs = fileURLToPath(new URL('../runtime/sandbox/worker.ts', import.meta.url));

describe('SeatbeltSandboxProvider 能力探测', () => {
  it('非 os 策略恒 false（本 provider 只实现 os）', async () => {
    const provider = new SeatbeltSandboxProvider({ workerPath: workerTs });
    assert.equal(await provider.supports('subprocess'), false);
    assert.equal(await provider.supports('inprocess'), false);
    assert.equal(await provider.supports('microvm'), false);
  });

  it('非 macOS 平台：supports(os)=false（os 仅 darwin 提供）', async () => {
    if (IS_MAC) return;
    const provider = new SeatbeltSandboxProvider({ workerPath: workerTs });
    assert.equal(await provider.supports('os'), false);
  });

  it('非 macOS 平台 run(os) 显式抛错（须由 default 路由降级）', { skip: IS_MAC }, async () => {
    const provider = new SeatbeltSandboxProvider({ workerPath: workerTs });
    await assert.rejects(
      () =>
        provider.run({
          toolName: 't',
          toolCallId: 'c',
          args: {},
          spec: macSpec(),
          signal: new AbortController().signal,
        }),
      /unavailable|unsupported/,
    );
  });

  it('macOS：supports(os)=true（sandbox-exec 系统自带）', { skip: !IS_MAC }, async () => {
    const provider = new SeatbeltSandboxProvider({ workerPath: workerTs, toolModules: [] });
    assert.equal(await provider.supports('os'), true);
  });
});

// ─── Windows 进程树审计集成（真进程，仅 Windows 生效）────────────────

describe('Windows 进程树审计集成（真进程）', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-audit-'));
  const toolsModule = path.join(workspace, 'tools.mjs');
  fs.writeFileSync(toolsModule, `
export default [
  {
    name: 'sleep',
    description: 'sleep 15s (audit kill target)',
    parameters: { type: 'object', properties: {} },
    async execute() {
      await new Promise(r => setTimeout(r, 15000));
      return { content: [{ type: 'text', text: 'slept' }], details: {} };
    },
  },
];
`);

  const tsxEntryUrl = import.meta.resolve('tsx');
  function makeProvider(): SubprocessSandboxProvider {
    return new SubprocessSandboxProvider({
      workerPath: workerTs,
      nodeArgs: ['--import', tsxEntryUrl],
      toolModules: [toolsModule],
    });
  }

  function makeReq(spec: SandboxSpec, events: SandboxEvent[]): SandboxRunRequest {
    return {
      toolName: 'sleep',
      toolCallId: 'm5-audit',
      args: {},
      spec,
      signal: new AbortController().signal,
      onEvent: e => { events.push(e); },
    };
  }

  it(
    '声明 processes 限额超限 → 审计触发 kill(process-limit)',
    { skip: !IS_WIN, timeout: 45000 },
    async () => {
      const provider = makeProvider();
      const spec = mergeSpec(
        undefined,
        { resources: { processes: 0, wallClockMs: 40000 } }, // 0：任何树规模必超（worker 自身 1 进程）
        workspace,
      );
      const events: SandboxEvent[] = [];
      const result = await provider.run(makeReq({ ...spec, strategy: 'subprocess' }, events));
      const killed = events.find(e => e.type === 'killed');
      assert.equal(killed?.detail?.reason, PROCESS_LIMIT_REASON);
      assert.equal((result.details as Record<string, unknown>)?.killed, PROCESS_LIMIT_REASON);
    },
  );

  it(
    '声明 memoryMb 限额超限 → 审计触发 kill(memory-limit)',
    { skip: !IS_WIN, timeout: 45000 },
    async () => {
      const provider = makeProvider();
      const spec = mergeSpec(
        undefined,
        { resources: { memoryMb: 0, wallClockMs: 40000 } }, // 0MB：任何真实进程树内存必超
        workspace,
      );
      const events: SandboxEvent[] = [];
      const result = await provider.run(makeReq({ ...spec, strategy: 'subprocess' }, events));
      const killed = events.find(e => e.type === 'killed');
      assert.equal(killed?.detail?.reason, MEMORY_LIMIT_REASON);
      assert.equal((result.details as Record<string, unknown>)?.killed, MEMORY_LIMIT_REASON);
    },
  );

  it(
    'root pid 已回收（worker 退出竞态）→ sample 返回 undefined，不误判超限',
    { skip: !IS_WIN, timeout: 30000 },
    async () => {
      // 宿主 pid + 10_000_000 远超 Windows 实际 pid 分配范围 → 必然缺表
      const audit = createWindowsProcessAudit(process.pid + 10_000_000, { processes: 0, memoryMb: 0 });
      const s = await audit.sample();
      assert.equal(s, undefined, 'root 缺表时本轮无数据，不得误判超限');
    },
  );

  after(async () => {
    await fs.promises.rm(workspace, { recursive: true, force: true }).catch(() => {});
  });
});
