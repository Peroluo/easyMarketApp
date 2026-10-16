/**
 * @aipack-ai/cli - 公共导出
 *
 * CLI 本体经 bin（aipack）使用；此处导出可编程复用的组件
 * （参数解析、工具集、Runtime 构建、运行模式）。
 */
export { parseArgs, printHelp, isValidThinkingLevel, suggestSimilar } from './src/args.js';
export type { Args, Mode } from './src/args.js';

export { isDebugMode, translateApiError, errorMessage, formatErrorForUser } from './src/errors.js';

export { BUILTIN_TOOLS, selectTools, readTool, writeTool, editTool, bashTool } from './src/tools.js';

export {
  loadConfig,
  buildRuntime,
  resolveModel,
  resolveSessionKey,
  listSessionsByRecency,
  listSessionInfos,
  extractSessionTitle,
  formatRelativeTime,
} from './src/builder.js';
export type { AipackCliConfig, ResolvedModel, SessionChoice, BuiltRuntime, SessionInfo } from './src/builder.js';

export { buildInitialMessage } from './src/initial-message.js';

export { select, isDangerousCommand, createToolConfirmHandler, summarizeArgs } from './src/confirm.js';
export type { SelectOption, ToolConfirmChoice, ToolConfirmHandlerOptions } from './src/confirm.js';

export {
  runInteractiveMode,
  pickSessionInteractively,
  listPathCompletions,
  buildSessionMarkdown,
} from './src/modes/interactive.js';
export { runPrintMode } from './src/modes/print.js';
export { runJsonMode } from './src/modes/json.js';
export { ChunkRenderer } from './src/modes/render.js';
export type { RenderOptions } from './src/modes/render.js';
export { Spinner, pauseActiveSpinner, resumeActiveSpinner } from './src/spinner.js';
export { printStartupBanner } from './src/banner.js';
export type { BannerOptions } from './src/banner.js';

export { main } from './src/cli.js';
export { runDoctor } from './src/doctor.js';
export {
  runApiKeyOnboarding,
  loadPersistedEnvIntoProcess,
  saveEnvVar,
  persistedEnvPath,
} from './src/onboarding.js';
export { APP_NAME, VERSION, defaultConfigDir, defaultSessionDir } from './src/version.js';
