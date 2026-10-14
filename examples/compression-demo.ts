/**
 * 根目录示例：使用 aipack-compression + DeepSeek 模型实现上下文压缩
 *
 * 演示 v2 策略管道：
 *   trim:      无损裁剪（thinking 剥离 + tool_result 按 token 预算裁剪）
 *   summarize: 旧消息摘要（Fork Agent 调用真实 DeepSeek，超预算时 map-reduce）
 *   truncate:  硬截断保底（按工具对整体丢弃最旧非 pinned 资源）
 *   lifecycle: 压不下去时发出上下文耗尽事件（交接文档 + 建议新会话 id）
 *
 * 模型配置统一来自 examples/model.config.ts（本地私有，不提交）：
 *   cp examples/model.config.example.ts examples/model.config.ts
 *
 * 运行:
 *   npx tsx examples/compression-demo.ts
 * 换用推理模型:
 *   DEEPSEEK_MODEL=deepseek-reasoner npx tsx examples/compression-demo.ts
 * 自定义模拟窗口大小（用于快速触发压缩，不传则用模型真实 contextWindow）:
 *   DEMO_CONTEXT_WINDOW=4000 npx tsx examples/compression-demo.ts
 */

import {
  createRuntime,
  createRequest,
  extractText,
  createDefaultTransformers,
} from '@aipack-ai/agent';
import type { Model, ContentBlock, Tool } from '@aipack-ai/agent';
import {
  createCompressionTransformer,
  loadCompressionConfig,
} from '@aipack-ai/compression';
import type { ContextExhaustedEvent } from '@aipack-ai/compression';
import { createLlm, formatModelConfig } from './model.config';

async function main() {
  // ── 1. 从统一配置装配模型 + streamFn ──────────────────────────
  const { model: realModel, streamFn } = createLlm();

  // 演示用：允许通过环境变量覆盖 contextWindow，用小窗口快速触发压缩
  // 不设置 DEMO_CONTEXT_WINDOW 则使用模型真实 contextWindow（如 deepseek-chat 的 64K）
  const demoContextWindow = process.env.DEMO_CONTEXT_WINDOW
    ? Number(process.env.DEMO_CONTEXT_WINDOW)
    : realModel.contextWindow;

  // 覆盖窗口时同步压低 maxTokens：v2 预算 = contextWindow - maxTokens - 边距，
  // 若 maxTokens > contextWindow，有效预算会被吃光（保底为 1 token）
  const demoMaxTokens = Math.min(
    realModel.maxTokens,
    Math.max(256, Math.floor(demoContextWindow / 4)),
  );
  const model: Model = { ...realModel, contextWindow: demoContextWindow, maxTokens: demoMaxTokens };

  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   aipack-compression + DeepSeek 压缩管道演示    ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`  模型: ${model.name} (${model.id})`);
  console.log(`  配置: ${formatModelConfig()}`);
  console.log(`  contextWindow: ${model.contextWindow} tokens${demoContextWindow !== realModel.contextWindow ? ` (覆盖自 ${realModel.contextWindow})` : ''}`);
  console.log(`  工具: read_file（返回 30 行内容，约 250 tokens/次）`);
  console.log(`  预期: 多轮对话后先触发 trim（裁剪工具输出），再触发 summarize（摘要历史）\n`);

  // ── 2. 加载压缩配置（双水位：trigger 高水位触发，target 低水位压到位）──
  const compressionConfig = loadCompressionConfig({
    budget: { triggerRatio: 0.50, targetRatio: 0.40 },
    trim: { toolResultMaxTokens: 200, toolResultHeadLines: 3, toolResultTailLines: 3 },
    summarize: { minResourcesToCompress: 3, protectedRecentCount: 4 },
  });

  const effective = model.contextWindow - model.maxTokens
    - Math.floor(model.contextWindow * compressionConfig.budget.safetyMarginRatio);
  console.log(`  水位: trigger>${(compressionConfig.budget.triggerRatio * 100).toFixed(0)}%` +
    ` target=${(compressionConfig.budget.targetRatio * 100).toFixed(0)}%` +
    ` (有效预算 ~${effective} tokens)\n`);

  // ── 3. 创建压缩转换器 ───────────────────────────────────────────
  // streamFn 复用统一配置，Fork Agent 也会调用真实模型生成摘要
  const compressionTransformer = createCompressionTransformer({
    config: compressionConfig,
    model,
    streamFn,
    contextWindow: model.contextWindow,
  });

  // 上下文耗尽事件：pinned/保护区本身超限时触发（检查点/换会话由 host 决策）
  let exhaustedEvent: ContextExhaustedEvent | null = null;
  compressionTransformer.onContextExhausted((e) => {
    exhaustedEvent = e;
  });

  // ── 4. 创建 Runtime ─────────────────────────────────────────────
  const transformers = [
    ...createDefaultTransformers(),
    compressionTransformer,
  ];

  console.log(`  转换器列表: ${transformers.map(t => `${t.name}(${t.priority})`).join(', ')}\n`);

  const sessionKey = 'demo';
  const runtime = createRuntime({
    model,
    streamFn,
    systemPrompt: '你是一个文件分析助手，使用 read_file 工具读取文件并简要分析内容。',
    transformers,
    tools: [readFileTool],
  });

  // ── 5. 模拟多轮对话，逐步填满上下文 ────────────────────────────
  const turns = [
    '请读取 file_1.txt 的内容',
    '请读取 file_2.txt 的内容',
    '请读取 file_3.txt 的内容',
    '请读取 file_4.txt 的内容',
    '请读取 file_5.txt 的内容',
    '请读取 file_6.txt 的内容',
    '请读取 file_7.txt 的内容',
    '请读取 file_8.txt 的内容',
  ];

  for (let i = 0; i < turns.length; i++) {
    logSeparator(`Turn ${i + 1}: ${turns[i]}`);

    // 流式输出本轮回复
    process.stdout.write('  AI: ');
    const request = createRequest(turns[i], { sessionKey });

    for await (const chunk of runtime.stream(request)) {
      if (chunk.type === 'text' && chunk.content) process.stdout.write(chunk.content);
      if (chunk.type === 'tool_start') console.log(`\n  [调用工具] ${chunk.toolName}`);
      if (chunk.type === 'tool_end') console.log(`  [工具完成] ${chunk.toolName}`);
    }
    console.log('\n');

    // 估算压缩后的上下文大小
    const messages = runtime.getMessages(sessionKey);
    const totalText = messages
      .map(m => {
        const c = (m as any).content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return extractText(c as ContentBlock[]);
        if (typeof m === 'string') return m;
        return '';
      })
      .join('\n');
    const estTokens = estimateTokens(totalText);
    const ratio = ((estTokens / model.contextWindow) * 100).toFixed(1);

    console.log(`  消息数: ${messages.length}`);
    console.log(`  估算 Token: ~${estTokens} / ${model.contextWindow} (${ratio}%)`);

    // 检查是否出现压缩产物
    const markers = detectCompressionArtifacts(messages);
    if (markers.length > 0) {
      console.log(`  压缩产物: ${markers.join(', ')}`);
    }

    // 上下文耗尽（压不下去）→ 打印交接文档摘要并停止
    if (exhaustedEvent) {
      const ev = exhaustedEvent as ContextExhaustedEvent;
      console.log(`\n  ⚡ 上下文耗尽事件（${ev.reason}），建议新会话: ${ev.suggestedSessionId}`);
      console.log(`  交接文档 (${ev.fallback ? 'fallback' : 'fork 生成'}):\n${ev.handoffDocument.slice(0, 400)}`);
      break;
    }
  }

  // ── 6. 最终状态报告 ─────────────────────────────────────────────
  logSeparator('最终上下文状态');

  const finalMessages = runtime.getMessages(sessionKey);
  console.log(`  最终消息数: ${finalMessages.length}`);
  console.log('  消息列表:');
  for (let i = 0; i < finalMessages.length; i++) {
    const msg = finalMessages[i] as any;
    const role = msg.role ?? (typeof msg === 'string' ? 'string' : 'unknown');
    let text: string;
    if (typeof msg === 'string') text = msg;
    else if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) text = extractText(msg.content as ContentBlock[]);
    else text = JSON.stringify(msg).slice(0, 80);
    const preview = text.replace(/\n/g, ' ').slice(0, 80);
    console.log(`    [${i}] ${role}: ${preview}...`);
  }

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║   ✅ 压缩演示完成                                   ║');
  console.log('╚════════════════════════════════════════════════════╝');

  await runtime.close();
}

// ─── 自定义工具：返回超长内容以快速填满上下文 ──────────────────────

const readFileTool: Tool = {
  name: 'read_file',
  description: '读取文件内容（演示用，返回多行内容）',
  parameters: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: '文件路径' },
    },
    required: ['path'],
  },
  async execute(_toolCallId: string, args: unknown) {
    const { path } = (args ?? {}) as { path?: string };
    // 生成 30 行内容，约 ~250 token，多次调用逐步填满上下文窗口
    const lines: string[] = [];
    lines.push(`File: ${path}`);
    lines.push('========================================');
    for (let i = 1; i <= 30; i++) {
      lines.push(`Line ${i}: Data row ${i} from ${path}. Contains configuration values for testing compression.`);
    }
    lines.push('========================================');
    lines.push('End of file.');
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: { path, lineCount: lines.length },
    };
  },
};

// ─── 辅助函数 ──────────────────────────────────────────────────────

function logSeparator(title: string) {
  console.log('\n' + '─'.repeat(50));
  console.log(`  ${title}`);
  console.log('─'.repeat(50));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function detectCompressionArtifacts(messages: any[]): string[] {
  const markers: string[] = [];
  const hasSummary = messages.some(m => m.role === 'compactionSummary');
  const hasTrimmed = messages.some(m => {
    const c = m.content;
    const text = typeof m === 'string' ? m
      : typeof c === 'string' ? c
      : Array.isArray(c) ? c.map((b: any) => b?.text ?? '').join('')
      : '';
    return text.includes('[... 已截断');
  });
  if (hasTrimmed) markers.push('Trim');
  if (hasSummary) markers.push('Summarize');
  return markers;
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
