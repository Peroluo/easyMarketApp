# @aipack-ai/cli

基于 [`@aipack-ai/agent`](../agent) 的终端 AI 编程助手。支持交互 REPL、非交互管道与 JSON 事件流三种模式,内置文件读写、shell、检索（find/grep/ls）与 task 子 agent 工具,支持项目记忆文件（AIPACK.md / AGENTS.md / CLAUDE.md）、Skills、MCP、Hooks 与上下文压缩（策略管道）;默认权限策略对正常操作零打断、仅危险命令需确认。

```bash
npm install -g @aipack-ai/cli
aipack "帮我看看这个项目"
```

## 快速开始

```bash
# 任选一个提供商设置 API Key（也可直接运行 aipack，无 Key 时交互引导配置）
export DEEPSEEK_API_KEY=sk-xxx

# 交互模式（REPL）
aipack

# 非交互：单次提问（支持管道）
aipack -p "总结 README.md"
cat src/index.ts | aipack -p "这段代码有什么问题？"

# 指定模型（provider/id 组合写法）
aipack --model deepseek/deepseek-chat "你好"
aipack --model anthropic/claude-sonnet-4-20250514 "重构这个函数"

# 附带文件上下文（图片自动走多模态通道）
aipack @package.json "分析依赖"
aipack @screenshot.png "这个报错怎么修"

# 继续当前目录最近的会话
aipack -c "我们刚才聊到哪里了？"
```

## 三种运行模式

| 模式 | 用法 | 说明 |
|------|------|------|
| 交互（默认） | `aipack` | REPL,支持斜杠命令、多行输入、Ctrl+C 中断运行（双击退出） |
| 非交互 | `aipack -p "..."` | 处理一次提示后退出；回复写 stdout（可管道），工具信息写 stderr |
| JSON 事件流 | `aipack --mode json "..."` | 全部流式事件按 JSON 行输出，供程序消费 |

JSON 模式输出示例：

```json
{"type":"text","content":"你好","timestamp":1730000000000}
{"type":"tool_start","toolName":"bash","timestamp":1730000000100}
{"type":"tool_end","isError":false,"timestamp":1730000000300}
{"type":"done","timestamp":1730000000400}
```

## 命令行选项

### 模型

| 选项 | 说明 |
|------|------|
| `--provider <名称>` | 提供商：openai / deepseek / anthropic / google / groq / moonshot ... |
| `--model <id>` | 模型 ID,支持 `provider/id` 组合写法；目录外模型自动按提供商 API 推断 |
| `--api-key <key>` | 覆盖环境变量 |
| `--thinking <级别>` | 思考级别：off / minimal / low / medium / high / max |
| `--list-models [搜索]` | 列出内置模型目录（标注 API Key 配置状态） |

未指定模型时优先使用 DeepSeek（`DEEPSEEK_API_KEY` 已配置则用 `deepseek-chat`），次选第一个已配置 `*_API_KEY` 的内置提供商。

### 会话

| 选项 | 说明 |
|------|------|
| `-c, --continue` | 继续当前目录最近的会话 |
| `-r, --resume` | 列出当前目录历史会话供选择 |
| `--session <key>` | 使用指定会话 |
| `-n, --name <名称>` | 为新会话命名 |
| `--session-dir <目录>` | 自定义会话存储目录 |
| `--no-session` | 临时会话，不持久化 |

会话按工作目录分组存储于 `~/.aipack/cli-sessions/<cwd编码>/`。

### 工具与权限

| 选项 | 说明 |
|------|------|
| `-t, --tools <列表>` | 工具白名单（逗号分隔） |
| `-xt, --exclude-tools <列表>` | 工具黑名单 |
| `-nt, --no-tools` | 禁用全部工具 |
| `--safe` | 保守模式：写文件与 shell 全部人工确认 |
| `--yes, -y` | 自动批准一切（含危险命令），CI/管道用 |

内置工具：

| 工具 | 能力 | 说明 |
|------|------|------|
| `read` | `fs:read` | 读文件，支持 offset/limit,超长截断;二进制文件明确报错 |
| `write` | `fs:write` | 写文件，自动建父目录 |
| `edit` | `fs:write` | 精确替换（oldString 唯一匹配） |
| `bash` | `shell:exec` | 执行 shell 命令,默认 60s 超时（可传 `timeoutMs` 钳制到 1s–10min）,输出截断 |
| `find` | `fs:read` | glob 模式查找文件（`**/*.ts`）,自动剪枝 node_modules/dist 等 |
| `grep` | `fs:read` | 正则搜索内容,支持 glob 过滤、忽略大小写、上下文行数 |
| `ls` | `fs:read` | 列出目录内容（目录在前,带 `/` 后缀） |
| `task` | 继承子工具 | 启动子 agent 执行子任务（见[子 agent 与 task 工具](#子-agent-与-task-工具)） |

所有文件工具限制在工作区内（越界路径与符号链接逃逸直接拒绝）。

### 上下文压缩

| 选项 | 说明 |
|------|------|
| `--no-compaction` | 关闭上下文压缩（策略管道与内置摘要压缩均不启用,仅保留硬截断兜底） |
| `--compaction-config <文件>` | 压缩配置 JSON（叠加在默认配置之上,优先级高于 `aipack.config.js` 的 `compression` 字段） |

默认启用上下文压缩,作为 runtime 降级链的第一级(策略管道 → 内置摘要压缩 → 硬截断):策略管道按预算水位依次执行 trim（裁剪） → summarize（摘要） → truncate（截断）,上下文耗尽时生成交接文档并建议切换到新会话(`aipack --session <新会话>` 可恢复)。`/model` 切换后压缩链自动跟随当前模型。

### 其他

| 选项 | 说明 |
|------|------|
| `--system-prompt <文本>` | 替换默认系统提示词 |
| `--append-system-prompt <文本>` | 追加系统提示词（可多次） |
| `--max-turns <n>` | 单次请求最大 agentic 回合数（默认 50，也可在 `aipack.config.js` 配置 `maxTurns`） |
| `--debug` | 显示详细错误与堆栈（或设 `AIPACK_DEBUG=1`）；常见 API/网络错误默认翻译为可行动提示 |
| `-h, --help` / `-v, --version` | 帮助 / 版本 |

## 默认权限策略

正常操作零打断,仅真正危险的命令需确认:

| 操作 | 默认行为 |
|------|---------|
| 读文件 | 静默放行 |
| 写文件 / 编辑 | 静默放行（工作区越界防护兜底） |
| bash 普通命令 | 静默放行 |
| bash 危险命令 | 弹出选择器,标注危险原因 |

危险命令识别：`rm` 删除（任何 `rm` 命令均需确认，含 `rm -rf /`、`rm -rf ~` 等根/家目录递归删除）、`sudo` 提权、`mkfs` / `dd of=/dev/` / `> /dev/sdX`(磁盘写入)、`curl ... \| sh`(管道执行远程脚本)、`chmod -R 777 /`、`shutdown` / `reboot`、fork 炸弹。普通命令（`ls`/`cat`/`echo` 等）静默放行。

> 危险命令每次都会重新确认，不受"总是允许"影响；"总是允许"只对非危险命令（如 `--safe` 模式下的常规命令）生效。

确认时使用**方向键选择器**(非输入式):

```
? 危险命令（提权执行）：sudo rm -rf /usr/local/foo
  ❯ 允许
    总是允许（本会话）
    拒绝
```

选择"总是允许"后,同一能力本会话内不再重复询问。

## 交互模式斜杠命令

| 命令 | 说明 |
|------|------|
| `/model [provider/id]` | 切换模型（无参弹出选择器，仅列已配置 Key 的提供商） |
| `/thinking <级别>` | 调整思考级别 |
| `/thinking show [on\|off]` | 切换思考过程显示（开 = 流式输出思考内容，默认折叠为动画） |
| `/system <文本>` | 替换系统提示词 |
| `/session` | 当前会话信息 |
| `/sessions [编号]` | 列出历史会话 / 切换到指定会话 |
| `/sessions rm <编号>` | 删除历史会话（当前会话除外） |
| `/config` | 当前生效配置总览（模型/思考/权限/工具/压缩/MCP/skills/记忆） |
| `/rename <名称>` | 命名当前会话（列表与 `--resume` 恢复时显示，优先于首条消息摘要） |
| `/export [文件]` | 导出当前会话为 Markdown（工具结果折叠展示） |
| `/clear` | 清空当前会话(仅内存) |
| `/compact` | 手动压缩会话历史（释放上下文空间） |
| `/tools` | 查看工具集与权限配置 |
| `/agents` | 查看可用子 agent（task 工具） |
| `/memory` | 查看已加载的项目记忆文件 |
| `/init` | 扫描项目并生成 AIPACK.md 项目记忆 |
| `/skills` | 查看已注册 skills |
| `/skill:<名称> [参数]` | 显式触发 skill（展开全文发送） |
| `/mcp [refresh]` | MCP server 状态 / 热刷新工具列表 |
| `/approvals` | 列出未决审批单 |
| `/approve <id>` / `/deny <id>` | 结算审批单 |
| `/help` / `/quit` | 帮助 / 退出 |

## 交互体验

- **首次使用引导**：无任何 `*_API_KEY` 且为 TTY 时，启动即引导选择提供商并输入 Key（保存到 `~/.aipack/env.json`，所有模式生效）；跳过时横幅仍列出示例 `export` 命令。
- **模型感知提示符**：提示符显示当前模型 ID，如 `aipack deepseek-chat>`。
- **思考/工具动画**：思考与工具执行期间显示旋转动画（TTY），工具执行显示参数摘要（bash 命令、文件路径），结束时标注成败与耗时。
- **Tab 补全**：行首 `/` 补全斜杠命令与 `/skill:<名称>`，行尾 `@` 补全文件路径（目录以 `/` 结尾）。
- **多行输入**：行尾以 `\` 续行，空行提交；续行中按 `Ctrl+C` 取消而非退出。
- **回合统计**：每轮回复后显示本轮 token、会话累计 token 与本轮使用的工具。
- **会话可辨识**：`/sessions` 与 `--resume` 列表显示标题（`/rename` 命名或首条消息摘要）与相对时间（如「5 分钟前」），`--resume` 用方向键选择器挑选会话。
- **输入历史**：`↑`/`↓` 翻阅历史输入，权限确认弹窗后历史不丢失。

## doctor 子命令（环境自检）

```bash
aipack doctor
```

逐项检查并给出 ✓ / ⚠ / ✗ 与修复建议：Node 版本、API Key 配置、`aipack.config.js` 加载、`.mcp.json`（项目与全局）结构、会话目录可写性、`~/.aipack/env.json` 持久化变量。存在 ✗ 项时退出码 1，可接入脚本判断。

## approvals 子命令(跨进程审批)

配合 `aipack.config.js` 的 `approvals.enabled: true` 使用。运行中的进程产生 pending 审批单落盘后,可在另一个终端结算:

```bash
aipack approvals list          # 列出未决审批单
aipack approvals approve <id>  # 批准
aipack approvals deny <id>     # 驳回
```

## 配置文件 `aipack.config.js`

放在项目根目录(可选,也支持 `aipack.config.mjs`):

```js
export default {
  // 异步审批（默认关闭：内联确认）
  approvals: {
    enabled: true,
    // 触发审批的能力（默认 ['fs:write', 'shell:exec']）
    capabilities: ['shell:exec'],
  },
  // 自定义权限规则（优先于内置规则）
  permissionRules: [
    { toolName: 'write', decision: 'confirm' },   // write 工具全部确认
    { permission: 'fs:write', decision: 'allow' }, // 按能力放行
  ],
  // 单次请求最大 agentic 回合数（--max-turns 优先于此值，均未设置时默认 50）
  maxTurns: 30,
  // 子 agent 定义（task 工具；见「子 agent 与 task 工具」）
  agents: {
    'code-reviewer': {
      description: '只读代码审查',
      prompt: '你是代码审查员，只读分析代码，不修改文件。',
      tools: ['read', 'find', 'grep', 'ls'],
      // model: 'anthropic/claude-sonnet-4-20250514',  // 可选,默认跟随主模型
      maxTurns: 20,
    },
  },
  // 用户钩子（见「Hooks」）
  hooks: {
    PreToolUse: [{ matcher: 'bash', command: './deny-dangerous.sh', timeoutMs: 10000 }],
    PostToolUse: [{ command: './audit-log.sh' }],
  },
  // 上下文压缩配置（叠加默认阈值；--compaction-config 文件优先级更高）
  compression: { /* DeepPartial<CompressionConfig> */ },
};
```

优先级:`approvals`(pending) > `--safe`(confirm) > 智能默认;`permissionRules` 永远最先匹配。

## 项目记忆文件

启动时自动加载并注入系统提示词尾部,让模型遵循项目既定约定:

| 来源 | 路径 | 说明 |
|------|------|------|
| 用户级 | `~/.aipack/AIPACK.md` | 个人偏好,跨项目生效 |
| 项目级 | `AIPACK.md` > `AGENTS.md` > `CLAUDE.md` | 取第一个存在的,兼容既有生态 |

- 支持 `@path` 行级导入(相对被导入文件所在目录),深度限制 5 层、循环去重
- 无记忆文件时零改动;`--system-prompt` 自定义时同样生效
- 交互模式运行 `/init` 可让 AI 扫描项目自动生成 `AIPACK.md`;`/memory` 查看已加载文件

## Skills

以 `.aipack/skills/<name>/SKILL.md`(项目级)或 `~/.aipack/skills/`(用户级)组织的技能文件,frontmatter 提供 `name` / `description`:

- 模型按 description 自动匹配调用;`disableModelInvocation: true` 时仅可手动触发
- `/skills` 查看已注册列表,`/skill:<名称> [参数]` 显式展开全文发送

## 子 agent 与 task 工具

`task` 工具让模型启动**隔离上下文**的子 agent:子 Runtime 独立消息历史与系统提示词,运行结束后仅把最终报告返回主对话——检索/分析产生的大量工具输出不污染主上下文。

- **并行**:同一回合的多个 task 调用由框架并行执行
- **防递归**:子 agent 工具集永远不含 task 自身(固定一层)
- **权限复用**:子 agent 的工具调用走与主 agent 相同的 PermissionPolicy / 审批
- **内置** `general-purpose` 始终可用(继承主 agent 当前工具集);自定义定义写在 `aipack.config.js` 的 `agents` 字段(`description` / `prompt` 必填,`tools` / `model` / `maxTurns` 可选,默认 30 回合)
- `/agents` 查看可用子 agent;`-xt task` / `--no-tools` 可禁用

## Hooks

通过 `aipack.config.js` 的 `hooks` 字段声明生命周期钩子(命名对齐 Claude Code),命令经 `/bin/sh -c` 执行、stdin 收 JSON 事件;退出码 2 阻断,stdout JSON(`decision` / `reason` / `args` / `terminate`)返回决策;失败或超时仅告警不中断:

| 事件 | 时机 | 能力 |
|------|------|------|
| `PreToolUse` | 工具调用前 | block / 改写 args |
| `PostToolUse` | 工具调用后 | terminate 整个 run |
| `UserPromptSubmit` | 用户提交提示词时 | 改写 prompt |
| `Stop` | run 结束 | 观察 |

`matcher`(仅 PreToolUse / PostToolUse)按工具名正则或前缀过滤,`timeoutMs` 默认 60000。

## 环境变量

| 变量 | 说明 |
|------|------|
| `<PROVIDER>_API_KEY` | 提供商 API Key,如 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` |
| `AIPACK_CONFIG_DIR` | 配置目录(默认 `~/.aipack`) |

首次使用引导写入的 Key 保存于 `~/.aipack/env.json`，启动时自动注入（真实环境变量优先，不覆盖）；`aipack doctor` 可查看其状态。

## 可编程 API

```ts
import { parseArgs, buildRuntime, runPrintMode, BUILTIN_TOOLS, isDangerousCommand } from '@aipack-ai/cli';

const args = parseArgs(['-p', '你好']);
const built = await buildRuntime({ args, cwd: process.cwd() });
// built.runtime → @aipack-ai/agent Runtime
// built.sessionKey / built.storage / built.approvalManager
```

## 开发

```bash
pnpm build:cli        # 构建（自动先构建 agent）
pnpm --filter @aipack-ai/cli typecheck
pnpm cli:dev          # tsx 直跑源码
pnpm cli              # 运行构建产物

# 冒烟
pnpm cli --list-models
printf '/help\n/quit\n' | pnpm cli
```

## License

MIT
