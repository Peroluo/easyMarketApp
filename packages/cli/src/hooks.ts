/**
 * 用户 Hooks - 通过 aipack.config.js 暴露 RuntimeHooks 生命周期
 *
 * 对齐 Claude Code 的 hooks 模型：配置声明「事件 → matcher + shell 命令」，
 * 命令经 stdin 接收 JSON 事件载荷，通过退出码（2 = 阻断）与 stdout JSON
 * 返回决策；失败/超时不中断主流程（可观测告警）。
 *
 * 事件映射（cc 命名 → aipack RuntimeHooks）：
 * - PreToolUse        → beforeToolCall（可 block / terminate / 改写 args）
 * - PostToolUse       → afterToolCall（可 terminate）
 * - UserPromptSubmit  → beforeRun（可改写 prompt）
 * - Stop              → done（观察）
 *
 * 配置示例（aipack.config.js）：
 *   export default {
 *     hooks: {
 *       PreToolUse: [{ matcher: 'bash', command: 'deny-dangerous.sh', timeoutMs: 10000 }],
 *       PostToolUse: [{ command: 'audit-log.sh' }],
 *     },
 *   };
 */

import { spawn } from 'node:child_process';
import type { Extension, RuntimeHooks, Request, Result } from '@aipack-ai/agent';
import type {
  BeforeToolCallDecision,
  AfterToolCallDecision,
  ToolCallContext,
  AfterToolCallContext,
} from '@aipack-ai/agent';

// ─── 配置类型 ─────────────────────────────────────────────────────

/** 支持的用户钩子事件（命名对齐 cc，语义映射 RuntimeHooks） */
export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop';

export interface HookDefinition {
  /**
   * 仅 PreToolUse / PostToolUse 生效：按工具名过滤（正则或精确前缀，大小写不敏感）。
   * 缺省匹配全部工具。
   */
  matcher?: string;
  /** shell 命令（经系统 shell 执行：Unix /bin/sh -c，Windows cmd /c；stdin 收到事件 JSON） */
  command: string;
  /** 超时毫秒数（默认 60000；超时 kill 并视为无决策） */
  timeoutMs?: number;
}

export type UserHooksConfig = Partial<Record<HookEvent, HookDefinition[]>>;

/** 钩子命令 stdout 可返回的决策 JSON */
interface HookCommandOutput {
  /** 'block' 阻止工具执行（PreToolUse） */
  decision?: 'block' | 'approve' | 'deny';
  /** 阻止/终止原因（反馈给模型） */
  reason?: string;
  /** PreToolUse：覆盖工具参数 */
  args?: unknown;
  /** PostToolUse：终止整个 run */
  terminate?: boolean;
  /** UserPromptSubmit：替换用户 prompt */
  prompt?: string;
}

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
/** PostToolUse 载荷中工具输出的截断上限（避免大输出撑爆命令 stdin） */
const TOOL_OUTPUT_SNIPPET_LIMIT = 4096;

// ─── 钩子命令执行器 ───────────────────────────────────────────────

interface HookRunOutcome {
  /** 退出码 2：阻断语义（cc 约定），stderr 作为 reason */
  blocked: boolean;
  stdout: string;
  stderr: string;
}

/** hook 命令 shell：Windows 用 ComSpec（Node 自动追加 /d /s /c），Unix 用 /bin/sh（-c） */
function pickHookShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'cmd.exe';
  }
  return '/bin/sh';
}

/** 执行单个 hook 命令：stdin 传 JSON，收集 stdout/stderr，超时 kill */
function runHookCommand(
  hook: HookDefinition,
  payload: Record<string, unknown>,
): Promise<HookRunOutcome | undefined> {
  return new Promise(resolve => {
    let child;
    try {
      // shell 选项交给 Node 处理 cmd.exe 与 POSIX shell 的参数差异
      // （此前硬编码 /bin/sh，Windows 上所有用户 hooks 静默失败）
      child = spawn(hook.command, {
        shell: pickHookShell(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AIPACK_HOOK: '1' },
      });
    } catch (err) {
      console.warn(
        `[aipack] hook 命令启动失败 (${hook.command}):`,
        err instanceof Error ? err.message : String(err),
      );
      resolve(undefined);
      return;
    }

    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const finish = (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        console.warn(`[aipack] hook 命令超时（${timeoutMs}ms）已终止: ${hook.command}`);
        resolve(undefined);
        return;
      }
      resolve({ blocked: code === 2, stdout, stderr });
    };

    child.on('error', err => {
      clearTimeout(timer);
      console.warn(`[aipack] hook 命令执行失败 (${hook.command}):`, err.message);
      resolve(undefined);
    });
    child.on('close', finish);

    // stdin 写入失败（命令提前退出等）不应悬挂钩子
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/** 解析 hook 命令 stdout 的决策 JSON（整体解析失败视为无决策输出） */
function parseHookOutput(outcome: HookRunOutcome): { output?: HookCommandOutput; reason?: string } {
  const text = outcome.stdout.trim();
  if (!text) return { reason: outcome.blocked ? outcome.stderr.trim() || 'blocked by hook (exit 2)' : undefined };
  try {
    return { output: JSON.parse(text) as HookCommandOutput };
  } catch {
    return {
      reason: outcome.blocked
        ? outcome.stderr.trim() || text.slice(0, 200)
        : undefined,
    };
  }
}

/** matcher 匹配工具名：无 matcher 全匹配；优先正则，非法正则降级为不区分大小写包含 */
function matchesMatcher(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher, 'i').test(toolName);
  } catch {
    return toolName.toLowerCase().includes(matcher.toLowerCase());
  }
}

/** 事件下配置是否为空（空则不注册 Extension，零开销） */
export function hasUserHooks(config: UserHooksConfig | undefined): boolean {
  if (!config) return false;
  return Object.values(config).some(list => Array.isArray(list) && list.length > 0);
}

// ─── Extension 组装 ───────────────────────────────────────────────

/**
 * 根据用户 hooks 配置创建 Extension。
 * 无任何配置时返回 undefined（保持零开销）。
 */
export function createUserHooksExtension(config: UserHooksConfig | undefined): Extension | undefined {
  if (!hasUserHooks(config)) return undefined;

  const preToolUse = config?.PreToolUse ?? [];
  const postToolUse = config?.PostToolUse ?? [];
  const userPromptSubmit = config?.UserPromptSubmit ?? [];
  const stop = config?.Stop ?? [];

  return {
    name: 'cli-user-hooks',
    apply(hooks: RuntimeHooks): void {
      // PreToolUse → beforeToolCall（waterfall：返回完整 decision）
      if (preToolUse.length > 0) {
        hooks.beforeToolCall.tapPromise('cli-user-hooks', async (decision: BeforeToolCallDecision, ctx: ToolCallContext) => {
          for (const hook of preToolUse) {
            if (!matchesMatcher(hook.matcher, ctx.tool.name)) continue;
            const outcome = await runHookCommand(hook, {
              event: 'PreToolUse',
              tool_name: ctx.tool.name,
              tool_input: ctx.args,
              session_key: ctx.sessionKey,
            });
            if (!outcome) continue;
            const { output, reason } = parseHookOutput(outcome);
            const wantsBlock = outcome.blocked
              || output?.decision === 'block'
              || output?.decision === 'deny';
            if (wantsBlock) {
              return {
                ...decision,
                block: true,
                reason: output?.reason ?? reason ?? 'blocked by user hook',
              };
            }
            if (output?.terminate) {
              return { ...decision, terminate: true, reason: output.reason ?? 'terminated by user hook' };
            }
            if (output?.args !== undefined) {
              decision.args = output.args;
            }
          }
          return decision;
        });
      }

      // PostToolUse → afterToolCall（waterfall：返回完整 decision）
      if (postToolUse.length > 0) {
        hooks.afterToolCall.tapPromise('cli-user-hooks', async (decision: AfterToolCallDecision, ctx: AfterToolCallContext) => {
          for (const hook of postToolUse) {
            if (!matchesMatcher(hook.matcher, ctx.tool.name)) continue;
            const outcome = await runHookCommand(hook, {
              event: 'PostToolUse',
              tool_name: ctx.tool.name,
              tool_input: ctx.args,
              tool_output: snippetOf(ctx),
              is_error: ctx.isError,
              session_key: ctx.sessionKey,
            });
            if (!outcome) continue;
            const { output } = parseHookOutput(outcome);
            if (outcome.blocked || output?.terminate) {
              return {
                ...decision,
                terminate: true,
                ...(output?.reason ? { result: withTerminateNote(decision.result, output.reason) } : {}),
              };
            }
          }
          return decision;
        });
      }

      // UserPromptSubmit → beforeRun（waterfall：返回完整 Request；可改写 message）
      if (userPromptSubmit.length > 0) {
        hooks.beforeRun.tapPromise('cli-user-hooks', async (request: Request) => {
          let current = request;
          for (const hook of userPromptSubmit) {
            const outcome = await runHookCommand(hook, {
              event: 'UserPromptSubmit',
              prompt: current.message,
              session_key: current.sessionKey,
            });
            if (!outcome) continue;
            const { output, reason } = parseHookOutput(outcome);
            if (outcome.blocked) {
              // beforeRun 无阻断语义：命令 exit 2 仅告警，不中断请求
              console.warn(`[aipack] UserPromptSubmit hook 请求阻断已忽略（exit 2）: ${reason ?? hook.command}`);
              continue;
            }
            if (output?.prompt !== undefined && output.prompt !== current.message) {
              current = { ...current, message: output.prompt };
            }
          }
          return current;
        });
      }

      // Stop → done（观察）
      if (stop.length > 0) {
        hooks.done.tapPromise('cli-user-hooks', async (result: Result, request?: Request) => {
          for (const hook of stop) {
            await runHookCommand(hook, {
              event: 'Stop',
              stop_reason: result?.stopReason,
              session_key: request?.sessionKey,
            });
          }
        });
      }
    },
  };
}

/** 工具输出文本摘要（content 文本块拼接，超限截断） */
function snippetOf(ctx: AfterToolCallContext): string {
  const texts = (ctx.result.content ?? [])
    .map(c => (c as { text?: string }).text ?? '')
    .filter(Boolean);
  const joined = texts.join('\n');
  return joined.length > TOOL_OUTPUT_SNIPPET_LIMIT
    ? `${joined.slice(0, TOOL_OUTPUT_SNIPPET_LIMIT)}…（已截断）`
    : joined;
}

/** PostToolUse terminate 时把 reason 附加到结果文本（供模型感知原因） */
function withTerminateNote(result: import('@aipack-ai/agent').ToolResult, reason: string) {
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text' as const, text: `（run 已被用户 hook 终止: ${reason}）` },
    ],
  };
}
