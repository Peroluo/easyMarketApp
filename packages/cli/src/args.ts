/**
 * CLI 参数解析与帮助文本（参考 pi 的 args.ts，适配 aipack）
 */
import type { ThinkingLevel } from '@aipack-ai/agent';
import chalk from 'chalk';
import { APP_NAME, VERSION } from './version.js';

export type Mode = 'text' | 'json';

export interface Args {
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string[];
  thinking?: ThinkingLevel;
  continue?: boolean;
  resume?: boolean;
  help?: boolean;
  version?: boolean;
  mode?: Mode;
  name?: string;
  noSession?: boolean;
  session?: string;
  sessionDir?: string;
  tools?: string[];
  excludeTools?: string[];
  noTools?: boolean;
  print?: boolean;
  listModels?: string | true;
  /** 保守模式：写文件与 shell 全部人工确认 */
  safe?: boolean;
  /** 自动批准一切（含危险命令），CI/管道用 */
  yes?: boolean;
  /** 单次请求最大 agentic 回合数（默认 50） */
  maxTurns?: number;
  /** 关闭上下文压缩（内置摘要压缩与五级压缩 transformer 均不启用） */
  noCompaction?: boolean;
  /** 压缩配置文件路径（JSON，DeepPartial<CompressionConfig> 结构，叠加在默认配置上） */
  compactionConfig?: string;
  /** 位置参数（用户消息） */
  messages: string[];
  /** @file 引用 */
  fileArgs: string[];
  diagnostics: Array<{ type: 'warning' | 'error'; message: string }>;
}

const VALID_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max'] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
  return (VALID_THINKING_LEVELS as readonly string[]).includes(level);
}

export function parseArgs(args: string[]): Args {
  const result: Args = {
    messages: [],
    fileArgs: [],
    diagnostics: [],
  };

  /** 带值选项 → 处理函数（调用时值已保证存在） */
  const valueFlags: Record<string, (v: string) => void> = {
    '--mode': v => {
      if (v === 'text' || v === 'json') result.mode = v;
      else result.diagnostics.push({ type: 'error', message: `无效的 mode: ${v}（可选 text / json）` });
    },
    '--provider': v => { result.provider = v; },
    '--model': v => { result.model = v; },
    '--api-key': v => {
      result.apiKey = v;
      // 命令行参数对 ps 等进程列表可见，提示改用环境变量（仍允许使用，CI 场景需要）
      result.diagnostics.push({
        type: 'warning',
        message: '命令行传入 --api-key 会暴露在进程列表中，建议改用环境变量（如 DEEPSEEK_API_KEY）',
      });
    },
    '--system-prompt': v => { result.systemPrompt = v; },
    '--append-system-prompt': v => { (result.appendSystemPrompt ??= []).push(v); },
    '--thinking': v => {
      if (isValidThinkingLevel(v)) result.thinking = v;
      else {
        // 与 --mode 的无效值处理一致：报错退出（而非降级警告后继续跑错配置）
        result.diagnostics.push({
          type: 'error',
          message: `无效的思考级别 "${v}"。可选: ${VALID_THINKING_LEVELS.join(', ')}`,
        });
      }
    },
    '--name': v => { result.name = v; },
    '--session': v => { result.session = v; },
    '--session-dir': v => { result.sessionDir = v; },
    '--tools': v => { result.tools = v.split(',').map(s => s.trim()).filter(Boolean); },
    '--exclude-tools': v => { result.excludeTools = v.split(',').map(s => s.trim()).filter(Boolean); },
    '--max-turns': v => {
      const n = Number.parseInt(v, 10);
      if (Number.isInteger(n) && n > 0) result.maxTurns = n;
      else result.diagnostics.push({ type: 'error', message: `无效的 --max-turns: ${v}（需为正整数）` });
    },
    '--compaction-config': v => { result.compactionConfig = v; },
  };

  /** 短选项 → 等价长选项（带值） */
  const shortWithValue: Record<string, string> = {
    '-n': '--name',
    '-t': '--tools',
    '-xt': '--exclude-tools',
  };

  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    // `--` 之后全部视为位置消息（可传递以 - 开头的消息，如 "aipack -- '-p 参数说明'"）
    if (arg === '--') {
      result.messages.push(...args.slice(i + 1));
      break;
    }
    let inlineValue: string | undefined;
    // 支持 --opt=value 形式
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        inlineValue = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
    }
    const flag = shortWithValue[arg] ?? arg;

    /**
     * 吞并紧随的位置参数作为选项的内联消息/搜索词。
     * 仅当下一项存在、不是 `--` 分隔符、不以 - / @ 开头时才吞并
     * （否则会把后续选项或 @文件引用误当作消息）。
     */
    const nextPositional = (): string | undefined => {
      const next = args[i + 1];
      return next !== undefined && next !== '--' && !next.startsWith('-') && !next.startsWith('@')
        ? (i++, next)
        : undefined;
    };

    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--version' || arg === '-v') {
      result.version = true;
    } else if (arg === '--continue' || arg === '-c') {
      result.continue = true;
    } else if (arg === '--resume' || arg === '-r') {
      result.resume = true;
    } else if (arg === '--no-session') {
      result.noSession = true;
    } else if (arg === '--no-tools' || arg === '-nt') {
      result.noTools = true;
    } else if (arg === '--safe') {
      result.safe = true;
    } else if (arg === '--no-compaction') {
      result.noCompaction = true;
    } else if (arg === '--yes' || arg === '-y') {
      result.yes = true;
    } else if (valueFlags[flag]) {
      // `--` 是选项/消息分隔符，不能作为选项值被消费（否则其后消息全部丢失）
      const next = i + 1 < args.length ? args[i + 1] : undefined;
      const v = inlineValue ?? (next !== undefined && next !== '--' ? args[++i] : undefined);
      if (v === undefined) {
        result.diagnostics.push({ type: 'error', message: `选项 ${arg} 需要一个值` });
      } else {
        valueFlags[flag](v);
      }
    } else if (arg === '--print' || arg === '-p') {
      result.print = true;
      // 内联值优先（--print=消息），否则吞并紧随的位置参数
      const v = inlineValue ?? nextPositional();
      if (v !== undefined) result.messages.push(v);
    } else if (arg === '--list-models') {
      result.listModels = inlineValue ?? nextPositional() ?? true;
    } else if (arg.startsWith('@')) {
      result.fileArgs.push(arg.slice(1));
    } else if (arg.startsWith('-') && arg !== '-') {
      result.diagnostics.push({ type: 'error', message: `未知选项: ${arg}` });
    } else {
      result.messages.push(arg);
    }
  }

  // ── 选项冲突/组合检查（静默忽略某一侧会让用户误以为配置生效）──
  if (result.print && result.mode === 'json') {
    result.diagnostics.push({
      type: 'warning',
      message: '同时指定 --print 与 --mode json，将以 JSON 模式运行（事件流输出到 stdout，不再输出纯文本）',
    });
  }
  if (result.continue && result.session) {
    result.diagnostics.push({
      type: 'warning',
      message: `同时指定 --continue 与 --session，将使用 --session "${result.session}"（忽略 --continue）`,
    });
  }
  if (result.noSession && result.sessionDir) {
    result.diagnostics.push({
      type: 'warning',
      message: '--no-session 与 --session-dir 同用时不会持久化会话（--session-dir 被忽略）',
    });
  }
  if (result.yes && result.safe) {
    result.diagnostics.push({
      type: 'warning',
      message: '--yes 与 --safe 同用时 --yes 优先生效（全部自动批准，含危险命令）',
    });
  }

  return result;
}

export function printHelp(): void {
  const c = chalk;
  const title = c.bold.cyan(`${APP_NAME} ${VERSION}`);
  const head = (s: string): string => c.bold.magenta(s);
  const opt = (flag: string, desc: string): string =>
    `  ${c.green(flag.padEnd(28))} ${c.dim(desc)}`;

  console.log(`${title}  ${c.dim('· 终端 AI 编程助手')}

${head('用法:')}
  ${c.cyan(APP_NAME)} ${c.dim('[选项]')} ${c.yellow('[@文件...]')} ${c.dim('[消息...]')}
  ${c.dim('消息以 - 开头时用')} ${c.yellow('--')} ${c.dim('分隔选项与消息，如: aipack -- "-p 是什么参数"')}

${head('子命令:')}
${opt('approvals list', '列出未决审批单')}
${opt('approvals approve <id>', '批准审批单')}
${opt('approvals deny <id>', '驳回审批单')}
${opt('--list-models [搜索]', '列出可用模型（标注 API Key 配置状态）')}

${head('模式:')}
${opt('(默认)', '交互模式（REPL），支持斜杠命令与多行输入')}
${opt('--print, -p [消息]', '非交互：处理一次提示后退出（支持管道 stdin）')}
${opt('--mode json', '以 JSON 行输出全部流式事件')}

${head('模型选项:')}
${opt('--provider <名称>', '提供商（openai/deepseek/anthropic/google...）')}
${opt('--model <id>', '模型 ID，支持 provider/id 组合写法')}
${opt('--api-key <key>', 'API Key（覆盖环境变量）')}
${opt('--thinking <级别>', '思考级别: off/minimal/low/medium/high/max')}

${head('会话选项:')}
${opt('--continue, -c', '继续当前目录最近的会话')}
${opt('--resume, -r', '浏览并选择历史会话')}
${opt('--session <名称>', '使用指定会话')}
${opt('--name, -n <名称>', '为新会话命名')}
${opt('--session-dir <目录>', '自定义会话存储目录')}
${opt('--no-session', '临时会话（不持久化）')}

${head('工具与权限:')}
${opt('--tools, -t <列表>', '工具白名单（逗号分隔）')}
${opt('--exclude-tools, -xt <列表>', '工具黑名单（逗号分隔）')}
${opt('--no-tools, -nt', '禁用全部工具')}
${opt('--safe', '保守模式：写文件/shell 全部人工确认')}
${opt('--yes, -y', '自动批准一切（含危险命令），CI/管道用')}

  ${c.dim('内置工具:')} read · write · edit · bash · find · grep · ls · task
  ${c.dim('task 工具:')} 启动子 agent（隔离上下文执行子任务并返回报告，
            ${c.dim('同回合多个 task 并行；定义见 aipack.config.js 的 agents 字段）')}
  ${c.dim('默认权限:')} 读/写文件静默放行（工作区范围）；bash 仅危险命令需确认
            ${c.dim('（rm 删除、sudo、磁盘写入、远程脚本管道等；危险命令每次重确认）')}

${head('上下文压缩:')}
${opt('--no-compaction', '关闭上下文压缩（长会话可能溢出）')}
${opt('--compaction-config <文件>', '压缩配置 JSON（覆盖默认阈值）')}

${head('其他:')}
${opt('--max-turns <n>', '单次请求最大 agentic 回合数（默认 50）')}
${opt('--system-prompt <文本>', '替换默认系统提示词')}
${opt('--append-system-prompt <文本>', '追加系统提示词（可多次）')}
${opt('--help, -h', '显示本帮助')}
${opt('--version, -v', '显示版本')}

${head('交互模式:')}
  ${c.dim('· 多行输入：行尾以')} ${c.yellow('\\')} ${c.dim('续行，空行提交')}
  ${c.dim('· 斜杠命令：/help /model /thinking /clear /compact /sessions /agents /quit')}
  ${c.dim('· Ctrl+C 中断运行，连按两次退出')}

${head('示例:')}
  ${c.dim('# 交互模式')}
  ${c.cyan(APP_NAME)}
  ${c.dim('# 管道单次提问')}
  ${c.yellow('cat README.md')} ${c.dim('|')} ${c.cyan(APP_NAME)} ${c.green('-p')} ${c.yellow('"总结这段文本"')}
  ${c.dim('# 指定模型（provider/id）')}
  ${c.cyan(APP_NAME)} ${c.green('--model')} ${c.yellow('deepseek/deepseek-chat')} ${c.yellow('"你好"')}
  ${c.dim('# 附带文件上下文（图片走多模态）')}
  ${c.cyan(APP_NAME)} ${c.yellow('@package.json')} ${c.yellow('"分析依赖"')}
  ${c.dim('# 继续上次会话')}
  ${c.cyan(APP_NAME)} ${c.green('-c')} ${c.yellow('"我们刚才聊到哪里了？"')}
  ${c.dim('# 只读审查')}
  ${c.cyan(APP_NAME)} ${c.green('-t')} ${c.yellow('read,find,grep')} ${c.green('-p')} ${c.yellow('"审查 src/"')}

${head('环境变量:')}
  ${c.dim('OPENAI_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY ...')}
  ${c.dim('AIPACK_CONFIG_DIR')} ${c.dim('→')} ${c.dim('配置目录（默认 ~/.aipack）')}
`);
}
