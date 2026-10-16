/**
 * Sandbox 契约层（M1）测试：
 * - isPathWithin：词法前缀匹配（分隔符归一 / win32 大小写不敏感 / 根路径 / 前缀边界）
 * - resolveToolSandbox：undefined → 空 spec、静态透传、工厂声明调用参数
 * - mergeSpec 基础回填：workspace 根 / strategy 缺省 subprocess / net 缺省 deny
 * - mergeSpec 收紧语义：strategy 就高、fs 交集（工具声明 ∩ defaults）、
 *   deny 并集去重、net 更严值、hosts 大小写不敏感交集、resources 逐字段 min、
 *   env 逐键覆盖（非收紧字段）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSpec, resolveToolSandbox, isPathWithin } from '../index.ts';
import type { SandboxSpec } from '../index.ts';

const WS = 'd:/git/aipack';

// ─── isPathWithin：词法前缀匹配 ───────────────────────────────────

describe('isPathWithin', () => {
  it('相等路径命中（含自身）', () => {
    assert.ok(isPathWithin(WS, WS));
  });

  it('前缀包含命中', () => {
    assert.ok(isPathWithin(`${WS}/packages/agent`, WS));
  });

  it('前缀边界：部分段名不误命中', () => {
    // '/abc' 不应命中 '/ab'（词法前缀按段匹配）
    assert.ok(!isPathWithin('/abc', '/ab'));
    assert.ok(!isPathWithin('/etc/passwd', '/etc/pas'));
  });

  it('反斜杠与尾分隔符归一', () => {
    assert.ok(isPathWithin('d:\\git\\aipack\\packages', 'd:/git/aipack/'));
    assert.ok(isPathWithin(`${WS}/`, WS));
  });

  it('win32 大小写不敏感；其余平台大小写敏感', () => {
    if (process.platform === 'win32') {
      assert.ok(isPathWithin('D:/Git/AIPack/packages', 'd:/git/aipack'));
    } else {
      assert.ok(!isPathWithin('/Git/AIPack', '/git/aipack'));
    }
  });

  it('根路径前缀命中任意绝对路径', () => {
    assert.ok(isPathWithin('/usr/bin', '/'));
    assert.ok(isPathWithin('/etc/passwd', '/'));
  });

  it('越界路径不命中', () => {
    assert.ok(!isPathWithin('/usr', '/etc'));
    assert.ok(!isPathWithin(WS, '/d/git'));
  });
});

// ─── resolveToolSandbox：工具声明解析 ──────────────────────────────

describe('resolveToolSandbox', () => {
  it('undefined 声明 → 空 spec（不进入隔离链路由调用方判定）', () => {
    assert.deepEqual(resolveToolSandbox(undefined, {}), {});
  });

  it('静态 Partial 声明原样返回', () => {
    const decl = { strategy: 'os' as const };
    assert.deepEqual(resolveToolSandbox(decl, {}), decl);
  });

  it('工厂声明接收 (args, { workspace }) 并透传返回值', () => {
    const factory = (args: unknown, ctx: { workspace?: string }) => ({
      fs: { readable: [ctx.workspace ?? '.'], writable: [String((args as { dir: string }).dir)] },
    });
    const resolved = resolveToolSandbox(factory, { dir: '/tmp/out' }, WS);
    assert.deepEqual(resolved, {
      fs: { readable: [WS], writable: ['/tmp/out'] },
    });
  });

  it('工厂返回 null/undefined 防御性视作空 spec', () => {
    assert.deepEqual(
      resolveToolSandbox(() => undefined as never, {}),
      {},
    );
  });
});

// ─── mergeSpec：基础回填 ───────────────────────────────────────────

describe('mergeSpec 基础回填', () => {
  it('双方全空 + workspace → 完备默认 spec（subprocess / workspace 根 / deny）', () => {
    const spec = mergeSpec(undefined, undefined, WS);
    assert.equal(spec.strategy, 'subprocess');
    assert.deepEqual(spec.fs, { readable: [WS], writable: [WS] });
    assert.deepEqual(spec.net, { mode: 'deny' });
    assert.deepEqual(spec.env, {});
    assert.deepEqual(spec.resources, {});
  });

  it('无 workspace 时 fs 回填为空（deny-by-default）', () => {
    const spec = mergeSpec(undefined, undefined);
    assert.deepEqual(spec.fs, { readable: [], writable: [] });
  });

  it('工具声明单方字段直接生效', () => {
    const spec = mergeSpec(undefined, { strategy: 'os', net: { mode: 'proxy', hosts: ['a.com'] } }, WS);
    assert.equal(spec.strategy, 'os');
    assert.deepEqual(spec.net, { mode: 'proxy', hosts: ['a.com'] });
  });
});

// ─── mergeSpec：收紧语义 ────────────────────────────────────────────

describe('mergeSpec 收紧语义', () => {
  it('strategy 取隔离强度更高者：运行时基线不可被工具声明降级', () => {
    assert.equal(mergeSpec({ strategy: 'os' }, { strategy: 'inprocess' }).strategy, 'os');
    // 工具自我升级允许（结果不弱于运行时基线）
    assert.equal(mergeSpec({ strategy: 'subprocess' }, { strategy: 'microvm' }).strategy, 'microvm');
    // 强度相同
    assert.equal(mergeSpec({ strategy: 'os' }, { strategy: 'os' }).strategy, 'os');
  });

  it('fs.writable 交集：丢弃工具侧落在 defaults 允许范围外的路径', () => {
    const spec = mergeSpec(
      { fs: { writable: [WS] } },
      { fs: { readable: [WS], writable: [`${WS}/packages`, '/tmp/evil'] } },
      WS,
    );
    assert.deepEqual(spec.fs.readable, [WS]);
    assert.deepEqual(spec.fs.writable, [`${WS}/packages`]);
  });

  it('fs 工具侧缺省回填 workspace 后再与 defaults 求交集', () => {
    // defaults 允许含 workspace → 回填结果保留
    assert.deepEqual(
      mergeSpec({ fs: { writable: [WS, 'd:/data'] } }, undefined, WS).fs.writable,
      [WS],
    );
    // defaults 不含 workspace → 回填结果被收紧为空（配置错误尽早暴露）
    assert.deepEqual(
      mergeSpec({ fs: { writable: ['d:/data'] } }, undefined, WS).fs.writable,
      [],
    );
  });

  it('fs.deny 并集去重（更严 = 更多拒绝），工具侧在前', () => {
    const spec = mergeSpec(
      { fs: { deny: ['~/.ssh', 'd:/a\\b'] } },
      { fs: { deny: ['d:/a/b', '.env'] } },
      WS,
    );
    // 归一去重保留首次拼写（工具侧 'd:/a/b'）
    assert.deepEqual(spec.fs.deny, ['d:/a/b', '.env', '~/.ssh']);
  });

  it('双方均未声明 deny → 字段省略', () => {
    assert.equal(mergeSpec(undefined, undefined, WS).fs.deny, undefined);
  });

  it('net.mode 取更严值（deny < proxy < allow），双方缺省 deny', () => {
    assert.equal(mergeSpec({ net: { mode: 'deny' } }, { net: { mode: 'allow' } }).net.mode, 'deny');
    assert.equal(mergeSpec({ net: { mode: 'proxy' } }, { net: { mode: 'allow' } }).net.mode, 'proxy');
    assert.equal(mergeSpec(undefined, { net: { mode: 'allow' } }).net.mode, 'allow');
    assert.equal(mergeSpec(undefined, undefined).net.mode, 'deny');
  });

  it('net.hosts 大小写不敏感交集，保留工具侧拼写', () => {
    const spec = mergeSpec(
      { net: { mode: 'proxy', hosts: ['api.example.com', 'cdn.example.com'] } },
      { net: { mode: 'proxy', hosts: ['API.Example.com', 'other.io'] } },
    );
    assert.deepEqual(spec.net.hosts, ['API.Example.com']);
  });

  it('net.hosts 单方声明直接生效', () => {
    assert.deepEqual(
      mergeSpec({ net: { mode: 'proxy', hosts: ['a.com'] } }, { net: { mode: 'proxy' } }).net.hosts,
      ['a.com'],
    );
    assert.deepEqual(
      mergeSpec(undefined, { net: { mode: 'proxy', hosts: ['b.com'] } }).net.hosts,
      ['b.com'],
    );
  });

  it('resources 逐字段取 min（更严），单方保留', () => {
    const spec = mergeSpec(
      { resources: { wallClockMs: 1000, memoryMb: 512 } },
      { resources: { wallClockMs: 2000, processes: 10 } },
    );
    assert.deepEqual(spec.resources, {
      wallClockMs: 1000,
      memoryMb: 512,
      processes: 10,
    });
  });

  it('env 非收紧字段：工具逐键覆盖 defaults', () => {
    const spec = mergeSpec(
      { env: { LANG: 'C', FORCE_COLOR: '1' } },
      { env: { FORCE_COLOR: '0', CUSTOM: 'x' } },
    );
    assert.deepEqual(spec.env, { LANG: 'C', FORCE_COLOR: '0', CUSTOM: 'x' });
  });

  it('合并结果对既有的 defaults 声明保持可预测（完整用例）', () => {
    const merged: SandboxSpec = mergeSpec(
      {
        strategy: 'subprocess',
        fs: { readable: [WS], writable: [`${WS}/build`], deny: ['.env'] },
        net: { mode: 'proxy', hosts: ['registry.npmjs.org'] },
        resources: { outputBytes: 1_000_000 },
      },
      {
        strategy: 'inprocess',
        fs: { readable: [WS, '/usr/bin'], writable: [`${WS}/build`, '/tmp'] },
        net: { mode: 'allow' },
        env: { CI: 'true' },
        resources: { outputBytes: 2_000_000, processes: 16 },
      },
      WS,
    );
    assert.equal(merged.strategy, 'subprocess');
    assert.deepEqual(merged.fs.readable, [WS]);
    assert.deepEqual(merged.fs.writable, [`${WS}/build`]);
    assert.deepEqual(merged.fs.deny, ['.env']);
    assert.deepEqual(merged.net, { mode: 'proxy', hosts: ['registry.npmjs.org'] });
    assert.deepEqual(merged.env, { CI: 'true' });
    assert.deepEqual(merged.resources, { outputBytes: 1_000_000, processes: 16 });
  });
});
