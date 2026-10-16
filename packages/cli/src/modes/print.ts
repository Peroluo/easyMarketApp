/**
 * print 模式（-p）：非交互，处理一次提示后退出。
 * 文本回复写 stdout（可管道），工具/状态信息写 stderr。
 */
import type { Runtime, ResultChunk } from '@aipack-ai/agent';
import chalk from 'chalk';
import { ChunkRenderer } from './render.js';
import { formatErrorForUser } from '../errors.js';

export async function runPrintMode(
  runtime: Runtime,
  request: Parameters<Runtime['run']>[0],
): Promise<void> {
  const renderer = new ChunkRenderer({ toolStream: process.stderr });
  let error: string | undefined;
  let usage: { input?: number; output?: number } | undefined;

  try {
    for await (const chunk of runtime.stream(request) as AsyncGenerator<ResultChunk>) {
      if (chunk.type === 'error') error = chunk.content;
      if (chunk.type === 'done' && chunk.result?.usage) usage = chunk.result.usage;
      renderer.render(chunk);
    }
  } catch (err) {
    // 错误分级：常见 API/网络错误翻译为可行动提示，--debug 下附堆栈
    process.stderr.write(chalk.red(`错误: ${formatErrorForUser(err)}\n`));
    process.exitCode = 1;
    return;
  }

  // token 用量写 stderr（保持 stdout 纯文本可管道）
  if (usage && (usage.input || usage.output)) {
    process.stderr.write(chalk.dim(`tokens: ↑${(usage.input ?? 0).toLocaleString()} ↓${(usage.output ?? 0).toLocaleString()}\n`));
  }

  if (error) process.exitCode = 1;
}
