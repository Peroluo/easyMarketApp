// freeze 挂点探针：直接调 SubprocessSandboxProvider 跑 freeze 工具
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
  {
    name: 'freeze',
    description: 'freeze the worker main thread',
    parameters: { type: 'object', properties: {} },
    async execute() { while (true) {} },
  },
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
const t0 = Date.now();
console.log('[probe] run start');
const result = await provider.run({
  toolName: 'freeze',
  toolCallId: 'c1',
  args: {},
  spec,
  signal: new AbortController().signal,
  onEvent: e => { events.push(e.type); console.log(`[probe] event: ${e.type} +${Date.now() - t0}ms`); },
});
console.log('[probe] run returned:', JSON.stringify(result.details), `+${Date.now() - t0}ms`);
console.log('[probe] events:', events.join(', '));
await provider.close?.();
rmSync(fixtureDir, { recursive: true, force: true });
console.log('[probe] done');
process.exit(0);
