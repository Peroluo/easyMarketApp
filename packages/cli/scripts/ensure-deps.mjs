#!/usr/bin/env node
/**
 * prebuild：确保 workspace 依赖包的 dist 已构建（tsup dts 引用其 *.d.ts）。
 *
 * 背景：原 prebuild 是 bash for 循环（`for p in ...; done`），Windows 无
 * bash 直接失败，导致 pnpm build 不可用。此处用 node 实现，跨平台。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(here, '..', '..');

for (const name of ['agent', 'compression', 'mcp']) {
  const dts = path.join(packagesDir, name, 'dist', 'index.d.ts');
  if (fs.existsSync(dts)) continue;
  console.log(`[prebuild] @aipack-ai/${name} dist 缺失，先构建...`);
  const r = spawnSync('pnpm', ['--filter', `@aipack-ai/${name}`, 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32', // Windows 下 pnpm 为 .cmd，需经 shell
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
