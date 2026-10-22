import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'index.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // 依赖全部保持 external（langfuse 为运行时依赖，@aipack-ai/agent 仅类型导入）
  skipNodeModulesBundle: true,
});
