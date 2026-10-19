/**
 * M7 CLI 沙箱集成测试：
 * - resolveSandboxOptions：--sandbox os|subprocess|off → RuntimeOptions.sandbox 映射
 *   （off 与缺省 = undefined，零迁移保证）
 * - formatSandboxEvent：沙箱遥测事件 → 用户可见提示文案
 *   （violation / degraded / killed / limit 渲染，spawn/exit 噪声静默）
 * - checkSandbox：doctor 沙箱能力检测 + 策略矩阵（平台条件断言，不写死探测结果）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SandboxEventType, SandboxTelemetryInfo } from '@aipack-ai/agent';
import { resolveSandboxOptions, formatSandboxEvent } from '../src/builder.js';
import { checkSandbox } from '../src/doctor.js';
import type { Args } from '../src/args.js';

// ─── resolveSandboxOptions ───────────────────────────────────────

function makeArgs(sandbox: Args['sandbox']): Args {
  return { messages: [], fileArgs: [], diagnostics: [], sandbox };
}

test('resolveSandboxOptions: os → 全局基线 os', () => {
  assert.deepEqual(resolveSandboxOptions(makeArgs('os')), {
    defaults: { strategy: 'os' },
  });
});

test('resolveSandboxOptions: subprocess → 全局基线 subprocess', () => {
  assert.deepEqual(resolveSandboxOptions(makeArgs('subprocess')), {
    defaults: { strategy: 'subprocess' },
  });
});

test('resolveSandboxOptions: off 与缺省 → undefined（不配置沙箱，零迁移）', () => {
  assert.equal(resolveSandboxOptions(makeArgs('off')), undefined);
  assert.equal(resolveSandboxOptions(makeArgs(undefined)), undefined);
});

// ─── formatSandboxEvent ──────────────────────────────────────────

function makeInfo(type: SandboxEventType, detail?: Record<string, unknown>): SandboxTelemetryInfo {
  return {
    traceId: 'trace-1',
    sessionKey: 'session-1',
    toolName: 'bash',
    toolCallId: 'call-1',
    strategy: 'os',
    type,
    ...(detail !== undefined ? { detail } : {}),
  };
}

test('formatSandboxEvent: net violation → 未授权主机提示', () => {
  const msg = formatSandboxEvent(
    makeInfo('violation', { kind: 'net', host: 'evil.example.com', method: 'GET' }),
  );
  assert.ok(msg !== undefined);
  assert.match(msg, /沙箱拦截/);
  assert.match(msg, /bash/);
  assert.match(msg, /evil\.example\.com/);
  assert.match(msg, /GET/);
});

test('formatSandboxEvent: fs violation → 越界路径提示', () => {
  const msg = formatSandboxEvent(
    makeInfo('violation', { op: 'write', path: '/etc/passwd' }),
  );
  assert.ok(msg !== undefined);
  assert.match(msg, /write 操作越界路径 \/etc\/passwd/);
});

test('formatSandboxEvent: secret violation → 未声明凭证提示', () => {
  const msg = formatSandboxEvent(
    makeInfo('violation', { kind: 'secret', name: 'AWS_SECRET_ACCESS_KEY', reason: 'not-declared' }),
  );
  assert.ok(msg !== undefined);
  assert.match(msg, /AWS_SECRET_ACCESS_KEY/);
  assert.match(msg, /已拒绝/);
});

test('formatSandboxEvent: 未知形态 violation 兜底含 detail', () => {
  const msg = formatSandboxEvent(makeInfo('violation', { weird: 1 }));
  assert.ok(msg !== undefined);
  assert.match(msg, /\{"weird":1\}/);
});

test('formatSandboxEvent: 降级链事件 → from → to 提示', () => {
  const msg = formatSandboxEvent(makeInfo('degraded', { from: 'os', to: 'subprocess' }));
  assert.ok(msg !== undefined);
  assert.match(msg, /os → subprocess/);
  assert.match(msg, /平台能力不足/);
});

test('formatSandboxEvent: 带原因的 degraded → 透出原因', () => {
  const msg = formatSandboxEvent(
    makeInfo('degraded', { reason: 'tool-module-load', modules: { './x.js': 'not found' } }),
  );
  assert.ok(msg !== undefined);
  assert.match(msg, /tool-module-load/);
  assert.match(msg, /bash/);
});

test('formatSandboxEvent: killed → 强杀原因提示', () => {
  const msg = formatSandboxEvent(makeInfo('killed', { reason: 'timeout' }));
  assert.ok(msg !== undefined);
  assert.match(msg, /timeout/);
});

test('formatSandboxEvent: limit → 资源限额提示', () => {
  const msg = formatSandboxEvent(makeInfo('limit', { memoryMb: 512 }));
  assert.ok(msg !== undefined);
  assert.match(msg, /资源限额/);
});

test('formatSandboxEvent: spawn / exit 生命周期噪声不渲染', () => {
  assert.equal(formatSandboxEvent(makeInfo('spawn')), undefined);
  assert.equal(formatSandboxEvent(makeInfo('exit')), undefined);
});

// ─── checkSandbox（doctor 沙箱检测 + 策略矩阵）────────────────────

test('checkSandbox: 返回能力 + 矩阵两项，矩阵恒 ok 且标注 microvm 未实现', async () => {
  const results = await checkSandbox();
  assert.equal(results.length, 2);
  const [capability, matrix] = results;
  assert.equal(capability.label, '沙箱能力');
  assert.ok(['ok', 'warn'].includes(capability.status), '能力项不产生 fail（沙箱不可用是预期降级）');
  assert.equal(matrix.label, '沙箱策略矩阵');
  assert.equal(matrix.status, 'ok');
  assert.match(matrix.detail, /microvm → 未实现/);
  assert.match(matrix.detail, /未声明沙箱的工具 inprocess 直跑/);
});

test('checkSandbox: 矩阵映射与平台语义一致', async () => {
  const [, matrix] = await checkSandbox();
  if (process.platform === 'win32') {
    // Windows 恒无 OS 级沙箱：os 声明必降级（subprocess 可用 → subprocess，否则 inprocess）
    assert.match(matrix.detail, /os → (subprocess|inprocess)/);
  } else if (process.platform === 'linux') {
    // Linux 上 os 可用与否取决于 bwrap 真探测，两者皆合法
    assert.match(matrix.detail, /os → (os|subprocess|inprocess)/);
  } else if (process.platform === 'darwin') {
    assert.match(matrix.detail, /os → (os|subprocess|inprocess)/);
  }
  // subprocess 声明 → subprocess 或 inprocess（不会反向升级到 os）
  assert.match(matrix.detail, /subprocess → (subprocess|inprocess)/);
});

test('checkSandbox: 能力明细按平台给出对应探测项', async () => {
  const [capability] = await checkSandbox();
  if (process.platform === 'linux') {
    assert.match(capability.detail, /bwrap/);
    assert.match(capability.detail, /cgroup v2/);
    assert.match(capability.detail, /systemd-run 配额/);
  } else if (process.platform === 'darwin') {
    assert.match(capability.detail, /Seatbelt/);
  } else {
    assert.match(capability.detail, /Windows 无 OS 级沙箱/);
  }
});
