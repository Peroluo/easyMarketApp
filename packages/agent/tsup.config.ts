import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'index.ts',
      'ai/index': 'ai/index.ts',
    },
    format: ['esm'],
    target: 'es2022',
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
    skipNodeModulesBundle: true,
  },
  {
    // 沙箱 worker 独立入口必须 self-contained（单入口构建，无共享 chunk）：
    // 宿主把 worker spawn 进最小挂载面的 OS 沙箱（bwrap/Seatbelt 只 bind
    // worker 所在目录），esbuild splitting 产出的 dist 根共享 chunk 在沙箱
    // 内不可见 → ERR_MODULE_NOT_FOUND。
    // 宿主以 node <dist>/sandbox/worker.js spawn（不内联脚本）。
    entry: { 'sandbox/worker': 'runtime/sandbox/worker.ts' },
    format: ['esm'],
    target: 'es2022',
    sourcemap: true,
    clean: false,
    outDir: 'dist',
    skipNodeModulesBundle: true,
  },
  {
    // worker 内注册的 fs ESM 拦截 hook（module.register 的 loader，与 worker
    // 同目录；同样 self-contained）
    entry: { 'sandbox/fs-hook': 'runtime/sandbox/fs-hook.ts' },
    format: ['esm'],
    target: 'es2022',
    sourcemap: true,
    clean: false,
    outDir: 'dist',
    skipNodeModulesBundle: true,
  },
]);
