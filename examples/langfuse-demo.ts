/**
 * 根目录示例：Langfuse 接入
 *
 * 演示：
 *   1. 通过 LangfuseExtension 以 Extension 形式接入 aipack Agent Runtime
 *   2. 上报 Langfuse 自托管（deploy/langfuse，http://localhost:3000）；
 *      未配置 LANGFUSE_PUBLIC_KEY/SECRET_KEY 时静默 no-op（离线可用）
 *   3. 模型配置统一来自 examples/model.config.ts：
 *      cp examples/model.config.example.ts examples/model.config.ts
 *      # 环境变量 DEEPSEEK_API_KEY / DEEPSEEK_MODEL / DEEPSEEK_BASE_URL 可覆盖
 *
 * 运行:
 *   pnpm build                                    # 首次需先构建 agent / agent-langfuse
 *   pnpm example:langfuse
 *
 * Langfuse 本地部署（开源自托管）:
 *   cd deploy/langfuse && docker compose up -d    # 约 2-3 分钟
 *   # 打开 http://localhost:3000 注册账号 → 创建组织/项目 → 拿 API Key
 *   LANGFUSE_PUBLIC_KEY=pk-lf-xxx LANGFUSE_SECRET_KEY=sk-lf-xxx pnpm example:langfuse
 */
import {
  createRuntime,
  createRequest,
  LoggingExtension,
  type Tool,
} from '@aipack-ai/agent';
import { LangfuseExtension } from '@aipack-ai/agent-langfuse';
import { createLlm, createLangfuseTransport, formatModelConfig, resolveLangfuseConfig } from './model.config';

// ─── 演示工具：供真实模型触发 tool_call → tool_result 循环 ─────────

const weatherTool: Tool = {
  name: 'get_weather',
  description: '查询城市天气',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  execute: async (_id, args) => ({
    content: [{ type: 'text', text: `${(args as { city?: string }).city ?? ''}：晴，22°C` }],
    details: {},
  }),
};

// ─── 主流程 ────────────────────────────────────────────────────────

async function main() {
  // ── 1. transport：配置表（model.config.ts langfuseConfig）凭据齐全 → Langfuse 自托管，
  //     环境变量 LANGFUSE_* 优先；否则 no-op ──────────────────────────
  const transport = createLangfuseTransport();
  const flushCloud = transport ? () => transport.flush() : null;
  const lfBase = resolveLangfuseConfig().baseUrl ?? 'http://localhost:3000';
  const backend = transport ? `Langfuse 自托管（${lfBase}）` : '无（凭据未配置，扩展 no-op）';

  // ── 2. Runtime 装配：LangfuseExtension 以 Extension 形式注入 ──────
  const { model, streamFn } = createLlm();
  console.log(`✅ 模型: ${formatModelConfig()}`);
  const runtime = createRuntime({
    model,
    streamFn,
    tools: [weatherTool],
    systemPrompt: '你是一个天气助手。',
    permissionFailOpen: true, // demo 放行工具执行
    extensions: [
      new LoggingExtension(),
      new LangfuseExtension({
        transport,
        runName: 'aipack.demo',
      }),
    ],
  });

  console.log(`✅ 上报后端: ${backend}\n`);

  // ── 3. 跑两条请求：一条触发工具循环，一条纯对话 ─────────────────
  const r1 = await runtime.run(createRequest('上海明天天气怎么样？'));
  console.log(`[run 1] ${r1.success ? '成功' : '失败'}: ${r1.content} tools=${r1.toolsUsed.join(',')}`);
  const r2 = await runtime.run(createRequest('用一句话介绍你自己'));
  console.log(`[run 2] ${r2.success ? '成功' : '失败'}: ${r2.content}`);

  console.log(`\n运行结束（Ctrl+C 退出）`);
  await flushCloud?.(); // 退出前刷出上报队列
  await runtime.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
