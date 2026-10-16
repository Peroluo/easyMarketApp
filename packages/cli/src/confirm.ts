/**
 * 终端交互式选择器 + 工具权限确认
 *
 * 替代 y/N 输入式确认：↑/↓（或 j/k）选择，回车确认，Esc/q/Ctrl+C 取消。
 * 数字键 1-9 直选。非 TTY 环境返回取消（保守拒绝）。
 */
import chalk from 'chalk';
import type { PermissionRequest } from '@aipack-ai/agent';
import { select } from './select.js';
import { pauseActiveSpinner, resumeActiveSpinner } from './spinner.js';

export { select };
export type { SelectOption } from './select.js';

// ─── 危险命令检测（bash 工具）────────────────────────────────────

/** [模式, 说明]：命中的 shell 命令即使默认放行模式也需人工确认 */
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  // 递归删除根/家目录（rm -rf /、rm -rf ~、rm -rf /* 等）——最严重，优先匹配
  [/rm\s+[^;|&]*[rf][^;|&]*\s+(\/|~|\$HOME)(\/?\*|\s|$)/, '递归删除根/家目录'],
  // rm 作为独立命令（命令位置：行首 / ; & | ` $ ( 之后，或 sudo/xargs/time 等前缀命令后）。
  // 不用 \brm\b：避免误报 "git rm"、"npm rm"、"echo rm"、文件名含 rm 等
  [/(?:^|[;&|`$(]\s*|\b(?:sudo|xargs|nice|time|nohup|env)\s+)rm\b/, '删除文件'],
  [/\bsudo(\s|$)/, '提权执行'],
  [/\bmkfs(\s|\.)/, '格式化磁盘'],
  [/\bdd\s+[^;|]*of=\/dev\//, '写入磁盘设备'],
  [/>\s*\/dev\/(sd|disk|nvme)/, '覆写磁盘设备'],
  [/(curl|wget)[^|;]*\|\s*(sudo\s+)?(ba|z)?sh/, '管道执行远程脚本'],
  [/chmod\s+-R\s+777\s+\/(\s|$)/, '根目录开放全部权限'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, '关机/重启'],
  [/:\s*\(\)\s*\{[^}]*\}\s*;\s*:/, 'fork 炸弹'],
];

/** 返回危险原因；非危险命令返回 null */
export function isDangerousCommand(command: string): string | null {
  for (const [pattern, reason] of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

// ─── 工具权限确认（三选项 + 会话级记忆）──────────────────────────

export type ToolConfirmChoice = 'once' | 'always' | 'deny';

/**
 * 从工具参数提取简短摘要（bash 显示命令，文件工具显示路径）。
 * 权限确认与流式渲染（tool_start）共用。
 */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  const cmd = a.command;
  if (typeof cmd === 'string') return cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd;
  const file = a.file ?? a.path;
  if (typeof file === 'string') return file;
  return '';
}

export interface ToolConfirmHandlerOptions {
  /**
   * 自动放行低风险操作（默认 true）：
   * - 仅内置 bash 工具的非危险命令静默放行，其余需确认的工具（如 MCP）弹选择器
   * - false（--safe）时全部弹选择器
   */
  autoApproveSafe?: boolean;
  /**
   * 自动批准一切（--yes，CI/管道用）：跳过所有确认，包括危险命令。
   * 优先级最高，且在非 TTY 环境同样生效。
   */
  yes?: boolean;
}

export function createToolConfirmHandler(
  options: ToolConfirmHandlerOptions = {},
): (req: PermissionRequest) => Promise<boolean> {
  const autoApproveSafe = options.autoApproveSafe ?? true;
  const yes = options.yes ?? false;
  /** 会话级"总是允许"记忆：key = 能力组合或工具名（仅对非危险操作生效） */
  const alwaysAllowed = new Set<string>();

  return async (req: PermissionRequest): Promise<boolean> => {
    // --yes：无条件放行（包括非 TTY 管道场景）
    if (yes) return true;

    const args = req.args as Record<string, unknown> | undefined;
    const command = typeof args?.command === 'string' ? args.command : '';

    // 危险命令检测优先：危险命令永远需要人工确认，
    // 不受"总是允许"记忆影响（避免一次放行后续 rm -rf / 被静默执行）
    const dangerReason = command ? isDangerousCommand(command) : null;

    const key = req.permissions.length > 0
      ? [...req.permissions].sort().join(',')
      : `tool:${req.toolName}`;

    // 非危险操作：会话级"总是允许"或默认模式静默放行
    if (!dangerReason) {
      if (alwaysAllowed.has(key)) return true;
      // 默认模式：仅内置 bash 工具的非危险命令静默放行——不依赖 TTY，
      // 管道 / -p 非交互场景同样生效（否则 print 模式下连 ls 都被拒绝）
      // （不能只看参数里有没有 command 字段，否则 MCP 等带 command 参数的工具会被误放行）
      if (autoApproveSafe && req.toolName === 'bash') return true;
    }

    // 危险命令 / 其余需确认的工具：无 TTY 无法弹选择器，保守拒绝
    if (!process.stdin.isTTY) return false;

    const summary = command || summarizeArgs(args);
    const question = dangerReason
      ? `危险命令（${dangerReason}）：${summary}`
      : summary
        ? `允许执行 ${req.toolName}：${summary}`
        : `允许执行 ${req.toolName}`;

    // 危险命令只给"允许/拒绝"两项（不给"总是允许"，防止误授权）
    const options = dangerReason
      ? [
          { label: '允许', value: 'once' as const },
          { label: '拒绝', value: 'deny' as const },
        ]
      : [
          { label: '允许', value: 'once' as const },
          { label: '总是允许（本会话）', value: 'always' as const },
          { label: '拒绝', value: 'deny' as const },
        ];

    // 暂停 spinner，避免动画覆盖选择器渲染
    pauseActiveSpinner();
    let choice: ToolConfirmChoice | null;
    try {
      choice = await select<ToolConfirmChoice>(question, options);
    } finally {
      resumeActiveSpinner();
    }

    if (choice === 'always') {
      alwaysAllowed.add(key);
      return true;
    }
    return choice === 'once';
  };
}
