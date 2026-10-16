/**
 * aipack CLI 主逻辑：子命令分发 + 模式路由
 * 可执行入口见 src/bin.ts（bin: dist/bin.js）
 */
import chalk from 'chalk';
import type { PermissionRequest } from '@aipack-ai/agent';
import { handleApprovalsCommand } from './commands/approvals.js';
import { listModels } from './commands/models.js';
import { parseArgs, printHelp } from './args.js';
import { buildRuntime } from './builder.js';
import { buildInitialMessage } from './initial-message.js';
import { runPrintMode } from './modes/print.js';
import { runJsonMode } from './modes/json.js';
import { runInteractiveMode } from './modes/interactive.js';
import { readStreamAll } from './prompt.js';
import { createToolConfirmHandler } from './confirm.js';
import { runDoctor } from './doctor.js';
import { runApiKeyOnboarding } from './onboarding.js';
import { createRequest } from '@aipack-ai/agent';
import { VERSION } from './version.js';

/** 模型是否支持图片输入（input 能力缺失时保守视为不支持） */
function supportsImage(input?: readonly string[]): boolean {
  return Array.isArray(input) && input.includes('image');
}

export async function main(argv: string[]): Promise<number> {
  // ── 子命令：approvals ──
  if (argv[0] === 'approvals' || argv[0] === 'approval') {
    return handleApprovalsCommand(argv.slice(1));
  }

  // ── 子命令：doctor（环境自检）──
  if (argv[0] === 'doctor') {
    return runDoctor();
  }

  // ── 参数解析 ──
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.version) {
    console.log(VERSION);
    return 0;
  }

  const errors = args.diagnostics.filter(d => d.type === 'error');
  if (errors.length > 0) {
    for (const e of errors) console.error(chalk.red(e.message));
    printHelp();
    return 1;
  }
  for (const w of args.diagnostics.filter(d => d.type === 'warning')) {
    console.error(chalk.yellow(w.message));
  }

  // ── --list-models ──
  if (args.listModels !== undefined) {
    return listModels(args.listModels);
  }

  // ── 管道 stdin（print / json 模式）──
  // 无 -p/--mode json 却从管道读入（如 `echo ... | aipack` 忘了 -p）：
  // 交互模式的 readline 会立即收到 EOF 而退出（可能中断正在进行的运行），
  // 自动降级为 print 模式并提示
  let printMode = args.print;
  if (!printMode && args.mode !== 'json' && !process.stdin.isTTY) {
    printMode = true;
    console.error(chalk.yellow('检测到管道 stdin 且未指定 -p，自动以 print 模式运行（如需交互请直接运行 aipack）'));
  }

  let stdinText: string | undefined;
  if ((printMode || args.mode === 'json') && !process.stdin.isTTY) {
    stdinText = await readStreamAll(process.stdin);
  }

  // ── 初始消息 ──
  const initial = await buildInitialMessage(args.messages, args.fileArgs, stdinText);

  const isNonInteractive = printMode || args.mode === 'json';
  if (isNonInteractive && !initial.text.trim() && initial.media.length === 0) {
    console.error(chalk.red('非交互模式需要提供消息（位置参数、@文件或管道 stdin）'));
    return 1;
  }

  // ── confirm 委托：选择式确认（方向键），交互模式接管后包装 rl 重建 ──
  // 默认自动放行非危险命令；--safe 时全部人工确认；--yes 时全部自动放行
  const toolConfirm = createToolConfirmHandler({
    autoApproveSafe: !args.safe,
    yes: args.yes === true,
  });
  const confirmRef: { fn: (req: PermissionRequest) => Promise<boolean> } = {
    fn: req => toolConfirm(req),
  };

  // ── 首次使用引导：交互 TTY 且未传 --api-key 且无任何 Key → 引导配置 ──
  // （内部自检：已配置任一 provider 时静默返回）
  if (!isNonInteractive && process.stdin.isTTY && !args.apiKey) {
    await runApiKeyOnboarding();
  }

  // ── 构建 Runtime ──
  let built;
  try {
    built = await buildRuntime({
      args,
      cwd: process.cwd(),
      confirmFn: req => confirmRef.fn(req),
    });
  } catch (err) {
    console.error(chalk.red(`初始化失败: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  }

  // -c 未命中历史会话时明确提示（避免用户以为在继续旧会话）
  if (args.continue && !built.resumed) {
    console.error(chalk.yellow('当前目录无历史会话，已新建会话'));
  }

  // --provider 与 --model provider/id 冲突时明确告知（此前被静默忽略）
  if (args.provider && args.model && args.model.includes('/')) {
    const modelProvider = args.model.slice(0, args.model.indexOf('/'));
    if (modelProvider !== args.provider) {
      console.error(chalk.yellow(
        `--provider ${args.provider} 已被 --model 中的 "${modelProvider}/" 前缀覆盖`,
      ));
    }
  }

  // ── 模式分发 ──
  // 图片附件 + 非视觉模型预检：提前给出可定位的警告（否则 API 原始报错难以排查）
  if (initial.media.length > 0 && !supportsImage(built.model.aiModel.input)) {
    console.error(chalk.yellow(
      `当前模型 ${built.model.aiModel.provider}/${built.model.aiModel.id} 不支持图片输入，` +
      `${initial.media.length} 个图片附件将被忽略（可换用 --model 指定视觉模型）`,
    ));
    initial.media = [];
  }

  try {
    if (args.mode === 'json' || printMode) {
      const request = createRequest(initial.text || '(空)', {
        channel: 'cli',
        sessionKey: built.sessionKey,
        ephemeral: args.noSession,
        media: initial.media,
      });
      // --mode json 优先于 -p（选项冲突警告已在 parseArgs 给出）
      if (args.mode === 'json') {
        await runJsonMode(built.runtime, request);
      } else {
        await runPrintMode(built.runtime, request);
      }
    } else {
      await runInteractiveMode({
        runtime: built.runtime,
        sessionKey: built.sessionKey,
        model: built.model,
        args,
        storage: built.storage,
        approvalManager: built.approvalManager,
        mcp: built.mcp,
        memoryFiles: built.memoryFiles,
        skills: built.skills,
        subagents: built.subagents,
        taskEnabled: built.taskEnabled,
        // 有文本或媒体附件（@文件/@图片）均作为初始消息发送；
        // 此前仅有位置参数消息时才发送，纯 @文件 会被静默丢弃
        initialMessages:
          initial.text.trim() || initial.media.length > 0
            ? [initial.text.trim() || '（见附件）']
            : [],
        initialMedia: initial.media,
        compressionTransformer: built.compressionTransformer,
        setCompressionModel: built.setCompressionModel,
        confirmRef,
        baseConfirm: toolConfirm,
      });
    }
  } finally {
    // 资源收尾兜底：单个清理失败不应吞掉主流程结果
    try {
      built.approvalManager?.close();
      await built.mcp?.dispose().catch(() => {});
      await built.runtime.close();
    } catch (err) {
      console.error(chalk.red(`资源清理失败: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  return process.exitCode === 1 ? 1 : 0;
}
