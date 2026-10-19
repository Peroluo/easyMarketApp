// 无 process.exit 复现：freeze 用例后进程退出阶段是否挂（残留 handle 诊断）
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
  { name: 'freeze', description: 'freeze', parameters: { type: 'object', properties: {} },
    async execute() { while (true) {} } },
];
`);

const provider = new SubprocessSandboxProvider({
  workerPath: workerTs,
  nodeArgs: ['--import', tsxEntryUrl],
  toolModules: [toolsModule],
  heartbeatTimeoutMs: 2500,
  pool: { maxWorkers: 0 },
});
const events = [];
const spec = mergeSpec(undefined, { strategy: 'subprocess' }, process.cwd());
const result = await provider.run({
  toolName: 'freeze', toolCallId: 'c1', args: {},
  spec, signal: new AbortController().signal,
  onEvent: e => events.push(e.type),
});
console.log('run done:', JSON.stringify(result.details), 'events:', events.join(','));
await provider.close();
rmSync(fixtureDir, { recursive: true, force: true });
console.log('cleanup done; active resources:', process.getActiveResourcesInfo());
// 不 process.exit：若事件循环残留 handle，进程会挂在此处
console.log('waiting for natural exit...');
