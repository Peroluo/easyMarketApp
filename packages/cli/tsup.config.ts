import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
    index: 'index.ts',
    // 沙箱 worker 按名重建注册表的独立模块（--sandbox 时 toolModules 指向 dist/tools.js）
    tools: 'src/tools.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  skipNodeModulesBundle: true,
  // 构建用独立 tsconfig（paths 置空）：让 @aipack-ai/agent 走 node_modules 解析，
  // external 才能生效；typecheck 用根 paths 指向 agent 源码，不依赖 dist 存在
  tsconfig: 'tsconfig.build.json',
  external: ['@aipack-ai/agent', '@aipack-ai/agent/ai'],
});
