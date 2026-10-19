#!/usr/bin/env node
/**
 * 跨平台测试 runner：枚举包内 test/、tests/ 目录下的 *.test.ts 后调 node --test。
 *
 * 背景：package.json 中 `node --import tsx --test test/*.test.ts` 的 glob
 * 由 shell 展开——Windows（PowerShell/cmd）不展开 glob，实际 0 个文件被
 * 执行且退出码 0（假绿）。此处用 fs 枚举，各平台行为一致。
 *
 * 若包内有自带 runner（scripts/run-tests.mjs，可能含平台跳过清单等
 * 包专属语义），优先委托执行，保持与 `pnpm --filter <pkg> test` 一致。
 *
 * 用法（在各包 package.json 中）：node ../../scripts/run-tests.mjs
 * 基准目录为 process.cwd()（pnpm script 的 cwd 即包目录）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pkgDir = process.cwd();

// 委托包自带 runner（如 cli 的 win32 POSIX 专用测试跳过清单）
const ownRunner = path.join(pkgDir, 'scripts', 'run-tests.mjs');
if (fs.existsSync(ownRunner)) {
  const r = spawnSync(process.execPath, [ownRunner], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const files = ['test', 'tests']
  .map((dir) => path.join(pkgDir, dir))
  .filter((dir) => fs.existsSync(dir))
  .flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .sort()
      .map((f) => path.join(dir, f)),
  );

if (files.length === 0) {
  console.error(`[run-tests] ${pkgDir} 下未找到测试文件`);
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
