// 最小复现：node:test harness + Atomics.wait freeze 用例
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SubprocessSandboxProvider, mergeSpec } from '../index.ts';

const workerTs = path.resolve('runtime/sandbox/worker.ts');
const tsxEntryUrl = import.meta.resolve('tsx');
const workspace = mkdtempSync(path.join(os.tmpdir(), 'mini-ws-'));
const toolsModule = path.join(workspace, 'tools.mjs');
writeFileSync(toolsModule, `
export default [
  { name: 'freeze', description: 'block', parameters: { type: 'object', properties: {} },
    async execute() {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
      return { content: [{ type: 'text', text: 'unfrozen' }], details: {} };
    } },
];
`);

test('mini freeze heartbeat kill', async () => {
  const provider = new SubprocessSandboxProvider({
    workerPath: workerTs,
    nodeArgs: ['--import', tsxEntryUrl],
    toolModules: [toolsModule],
    heartbeatTimeoutMs: 2500,
    pool: { maxWorkers: 0 },
  });
  const events = [];
  const result = await provider.run({
    toolName: 'freeze', toolCallId: 'c1', args: {},
    spec: mergeSpec(undefined, { strategy: 'subprocess' }, workspace),
    signal: new AbortController().signal,
    onEvent: e => events.push(e.type),
  });
  console.log('run done:', JSON.stringify(result.details), 'events:', events.join(','));
  assert.equal(result.details?.killed, 'heartbeat-lost');
  await provider.close();
});

test.after(() => {
  rmSync(workspace, { recursive: true, force: true });
  console.log('after cleanup; resources:', process.getActiveResourcesInfo());
});
