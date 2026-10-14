/**
 * aipack-compression 演示（v2 策略管道）
 *
 * 用 mock 的 streamFn 模拟 fork 摘要，演示 trim（无损裁剪）→ summarize（有损摘要）链路。
 *
 * 运行：pnpm example
 */

import {
  createCompressionTransformer,
  loadCompressionConfig,
  ConsoleTelemetryReporter,
} from '../index';
import type { ContextResource, Model, StreamFn, StreamEvent, AssistantMessage } from '@aipack-ai/agent';

// ─── Mock 模型 ────────────────────────────────────────────────────

const model: Model = {
  id: 'demo-model',
  name: 'Demo Model',
  provider: 'demo',
  contextWindow: 1000, // 故意设小，便于触发压缩
  maxTokens: 2048,
  reasoning: false,
};

// ─── Mock streamFn：返回固定摘要文本（对齐真实 provider 事件序列）───

const mockStreamFn: StreamFn = async function* (): AsyncGenerator<StreamEvent> {
  const summary = '## Context Summary\nDemo task: user requested X.\n\n## Key Decisions\n- Use approach Y';
  yield { type: 'text_delta', delta: summary };
  const assistant: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: summary }],
    stopReason: 'stop',
    usage: { input: 400, output: 20, total: 420 },
    timestamp: Date.now(),
  };
  yield { type: 'done', message: assistant };
};

// ─── 构造测试资源 ─────────────────────────────────────────────────

function makeResource(
  id: string,
  type: ContextResource['type'],
  content: unknown,
  deps: string[] = [],
  pinned = false,
): ContextResource {
  return {
    id,
    type,
    role: type === 'assistant_message' ? 'assistant'
      : type === 'user_message' ? 'user'
      : type === 'tool_result' ? 'toolResult'
      : 'system',
    content,
    timestamp: Date.now() + Math.random(),
    dependencies: deps,
    meta: type === 'tool_result' && deps.length > 0 ? { toolCallId: deps[0] } : {},
    pinned,
  };
}

async function main(): Promise<void> {
  // 预算：effective = 1000 - 0(输出预留) - 50(安全边距) = 950
  //   trigger 760 / target 380 / hardLimit 950
  const config = loadCompressionConfig({
    budget: { outputReserveTokens: 0, safetyMarginRatio: 0.05 },
    summarize: { minResourcesToCompress: 2, protectedRecentCount: 2, forkMaxTokens: 50 },
    telemetry: { enabled: true, logTokenDelta: true, logTriggerReason: true },
  });

  const reporter = new ConsoleTelemetryReporter({
    logTokenDelta: config.telemetry.logTokenDelta,
    logTriggerReason: config.telemetry.logTriggerReason,
  });

  const transformer = createCompressionTransformer({
    config,
    model,
    streamFn: mockStreamFn,
    contextWindow: model.contextWindow,
    telemetryReporter: reporter,
  });

  // 场景：4 条历史消息（~320 token）+ 巨型 tool_result（~3000 token，超过
  // trim 的 2000 token 预算）+ 保护区内的最近对话。
  // 预期链路：trim 裁剪 tool_result（~3000→~90）→ 仍高于 target(380) →
  // summarize 把历史 + 裁剪后的 tool_result 替换为单条摘要。
  const longOutput = Array.from({ length: 800 }, (_, i) => `line ${i}: data`).join('\n');
  const resources: ContextResource[] = [
    makeResource('sys1', 'system_message', '你是一个乐于助人的助手。', [], true),
    makeResource('u1', 'user_message', 'x'.repeat(320)),
    makeResource('u2', 'user_message', 'x'.repeat(320)),
    makeResource('u3', 'user_message', 'x'.repeat(320)),
    makeResource('u4', 'user_message', 'x'.repeat(320)),
    makeResource('a1', 'assistant_message', 'Calling tool.', ['call_1']),
    makeResource('tr1', 'tool_result', longOutput, ['call_1']),
    makeResource('u5', 'user_message', 'continue'),
    makeResource('a2', 'assistant_message', 'Done.'),
  ];

  const transformed = await transformer.transform(resources, {
    graph: {} as any,
    runtime: { sessionKey: 'demo', turn: 1 },
  });

  console.log('\n=== Result ===');
  console.log(`Before: ${resources.length} resources`);
  console.log(`After:  ${transformed.length} resources`);
  for (const r of transformed) {
    const text = typeof r.content === 'string'
      ? r.content
      : JSON.stringify(r.content).slice(0, 80);
    console.log(`  [${r.type}${r.pinned ? '*' : ''}] ${text.slice(0, 60)}...`);
  }
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
