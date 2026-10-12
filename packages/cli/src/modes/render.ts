/**
 * 流式 chunk 的终端渲染（interactive / print 共用）
 *
 * 增强 UX：
 * - 思考阶段：旋转动画（TTY）而非静态提示
 * - 工具阶段：动画 + 名称；结束时显示耗时与成败
 * - 文本/错误保持原有流式输出
 */
import chalk from 'chalk';
import type { ResultChunk } from '@aipack-ai/agent';
import { Spinner } from '../spinner.js';

export interface RenderOptions {
  /** 显示思考过程（默认折叠为省略提示） */
  showThinking?: boolean;
  /** 输出目标（默认 stdout；print 模式工具信息走 stderr 保持 stdout 纯文本） */
  toolStream?: NodeJS.WriteStream;
}

export class ChunkRenderer {
  private thinkingShown = false;
  private inTool = false;
  /** 当前工具起始时间（用于结束时显示耗时） */
  private toolStartedAt = 0;
  private spinner = new Spinner();

  constructor(private opts: RenderOptions = {}) {}

  render(chunk: ResultChunk): void {
    // 工具/状态信息输出流（默认 stdout；print 模式传 stderr 保持 stdout 纯文本）
    const status = this.opts.toolStream ?? process.stdout;
    switch (chunk.type) {
      case 'text':
        // 流式文本输出前停止任何动画，避免行内交错
        if (this.spinner.active || this.inTool) {
          this.spinner.stop();
          this.inTool = false;
        }
        // 本段思考已结束；复位标记使"文本→工具→再思考"场景中
        // 第二段思考重新显示提示（否则静默无反馈，用户以为卡死）
        this.thinkingShown = false;
        if (chunk.content) process.stdout.write(chunk.content);
        break;

      case 'thinking': {
        if (this.opts.showThinking && chunk.content) {
          process.stdout.write(chalk.dim(chunk.content));
        } else if (!this.thinkingShown) {
          this.thinkingShown = true;
          // 仅 TTY 起动画；非 TTY 退化为静态提示
          if (process.stdout.isTTY) {
            this.spinner.start('思考中');
          } else {
            status.write(chalk.dim('  (思考中...)\n'));
          }
        }
        break;
      }

      case 'tool_start':
        // 切换动画前缀为工具名，不新增行
        this.inTool = true;
        this.toolStartedAt = Date.now();
        if (process.stdout.isTTY) {
          this.spinner.start(`执行 ${chunk.toolName ?? '工具'}`);
        } else {
          status.write(chalk.cyan(`\n⚙ ${chunk.toolName} `));
        }
        break;

      case 'tool_end':
        if (this.inTool) {
          const elapsed = this.toolStartedAt ? Date.now() - this.toolStartedAt : 0;
          const timeStr = elapsed > 0 ? chalk.dim(` ${formatElapsed(elapsed)}`) : '';
          if (process.stdout.isTTY) {
            const mark = chunk.isError ? chalk.red('✗') : chalk.green('✓');
            this.spinner.stop(`${chalk.cyan('⚙')} ${chunk.toolName ?? ''} ${mark}${timeStr}`);
          } else {
            status.write(chunk.isError ? chalk.red(' ✗\n') : chalk.green(' ✓\n'));
          }
          this.inTool = false;
          // 工具结束后常跟随新一段推理思考：复位以便再次显示提示
          this.thinkingShown = false;
        }
        break;

      case 'error':
        this.spinner.stop();
        this.inTool = false;
        status.write(chalk.red(`\n错误: ${chunk.content ?? '未知错误'}\n`));
        break;

      case 'done':
        this.spinner.stop();
        this.inTool = false;
        process.stdout.write('\n');
        break;
    }
  }

  reset(): void {
    this.spinner.stop();
    this.thinkingShown = false;
    this.inTool = false;
    this.toolStartedAt = 0;
  }
}

/** 把毫秒格式化为人类可读时长（如 1.2s / 23ms / 1m 05s） */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${String(rem).padStart(2, '0')}s`;
}
