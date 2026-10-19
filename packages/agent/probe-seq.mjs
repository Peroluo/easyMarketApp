// 顺序复现：wallClock kill 用例 → freeze 用例（模拟测试文件内的用例顺序）
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SubprocessSandboxProvider, mergeSpec } from './index.ts';

const workerTs = path.resolve('runtime/sandbox/worker.ts');
const tsxEntryUrl = import.meta.resolve('tsx');
const fixtureDir = mkdtempSync(path.join(tmpdir(), 'probe-tools-'));
const toolsModule = path.join(fixtureDir, 'tools.mjs');
writeFileSync(toolsModule, `
export default [
  { name: 'sleep', description: 'sleep', parameters: { type: 'object', properties: {} },
    async execute() { await new Promise(r => setTimeout(r, 8000)); return { content: [{ type: 'text', text: 'slept' }], details: {} }; } },
  { name: 'freeze', description: 'freeze', parameters: { type: 'object', properties: {} },
    async execute() { while (true) {} } },
];
`);

function makeProvider(hb) {
  return new SubprocessSandboxProvider({
    workerPath: workerTs,
    nodeArgs: ['--import', tsxEntryUrl],
    toolModules: [toolsModule],
    heartbeatTimeoutMs: hb,
    pool: { maxWorkers: 0 },
  });
}

const t0 = Date.now();
const log = (...a) => console.log(`[probe +${Date.now() - t0}ms]`, ...a);

// 用例 8：wallClock 超时
{
  const events = [];
  const provider = makeProvider(15000);
  const spec = mergeSpec(undefined, { strategy: 'subprocess', resources: { wallClockMs: 400 } }, process.cwd());
  log('wallClock run start');
  const result = await provider.run({
    toolName: 'sleep', toolCallId: 'c1', args: {},
    spec, signal: new AbortController().signal,
    onEvent: e => events.push(e.type),
  });
  log('wallClock done:', JSON.stringify(result.details), 'events:', events.join(','));
  await provider.close();
}
log('=== freeze phase ===');
// 用例 9：freeze 心跳僵死
{
  const events = [];
  const provider = makeProvider(2500);
  const spec = mergeSpec(undefined, { strategy: 'subprocess' }, process.cwd());
  log('freeze run start');
  const result = await provider.run({
    toolName: 'freeze', toolCallId: 'c2', args: {},
    spec, signal: new AbortController().signal,
    onEvent: e => events.push(e.type),
  });
  log('freeze done:', JSON.stringify(result.details), 'events:', events.join(','));
  await provider.close();
}
rmSync(fixtureDir, { recursive: true, force: true });
log('done');
process.exit(0);
