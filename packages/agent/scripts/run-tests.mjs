#!/usr/bin/env node
/**
 * 测试 runner：枚举 test/*.test.ts 后调 node --test（跨平台）。
 *
 * 背景：package.json 中 `node --import tsx --test test/*.test.ts` 的 glob
 * 由 shell 展开——Windows（PowerShell/cmd）不展开 glob，实际 0 个文件被
 * 执行且退出码 0（假绿）。此处用 fs 枚举，各平台行为一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(here, '..', 'test');

const files = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.ts'))
  .sort()
  .map(f => path.join(testDir, f));

if (files.length === 0) {
  console.error(`[run-tests] ${testDir} 下未找到测试文件`);
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
