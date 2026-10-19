/**
 * 沙箱演示工具模块（examples/sandbox.ts 的 toolModules）
 *
 * 关键约束：声明了 Tool.sandbox 的工具必须放在「命名模块」中——
 * 沙箱 worker 是独立进程，无法接收闭包工具，只能按
 * RuntimeOptions.sandbox.toolModules 重新 import 本模块、按名重建注册表。
 *
 * 本模块会被两个进程分别加载：
 * - 宿主（npx tsx examples/sandbox.ts）：注册 Tool 声明（含 sandbox 策略）；
 * - worker（node dist/sandbox/worker.js）：按名查表执行工具。
 * 因此运行时仅依赖 node: 内置模块（类型导入会被擦除，不会加载框架包）；
 * 演示路径用确定性算法计算，保证两端进程算出一致结果。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool, ToolResult } from '@aipack-ai/agent';

// ─── 演示路径常量（宿主负责创建文件；两端按同一算法计算，天然一致）───

// ⚠️ macOS 的 os.tmpdir() 是符号链接（/var/folders → /private/var/folders）：
// worker 内 fs facade 会把请求路径 realpath 后再做前缀匹配，白名单若用
// 未消解形式必然误判越界。这里统一先 realpath，保证两端拿到同一真实路径。
const TMP_ROOT = fs.realpathSync(os.tmpdir());

/** workspace 根（RuntimeOptions.workspace 也指向它 → 工具 fs 白名单缺省回填该根） */
export const DEMO_ROOT = path.join(TMP_ROOT, 'aipack-sandbox-demo');
/** 白名单内的普通文件（safe_read 的目标） */
export const DEMO_NOTES = path.join(DEMO_ROOT, 'notes.txt');
/** workspace 内、但被 deny 显式拒绝的文件（如 .env 类敏感文件） */
export const DEMO_SECRETS_ENV = path.join(DEMO_ROOT, 'secrets.env');
/** workspace 之外的哨兵文件（不在任何白名单内） */
export const OUTSIDE_FILE = path.join(TMP_ROOT, 'aipack-sandbox-demo-outside.txt');

// worker 内 secrets broker 的挂载键（core/sandbox.ts 的 SANDBOX_GLOBAL_KEY）
const SANDBOX_GLOBAL_KEY = '__aipackSandbox';

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], details: {} });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const demoTools: Tool[] = [
  {
    name: 'safe_read',
    description: '读取 workspace 白名单内的文件（预期正常执行）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件绝对路径' } },
      required: ['path'],
    },
    // fs 声明缺省 → mergeSpec 回填 readable/writable = [workspace]
    sandbox: { strategy: 'subprocess' },
    async execute(_toolCallId, args) {
      const p = String((args as { path?: string }).path ?? '');
      return text(fs.readFileSync(p, 'utf8'));
    },
  },
  {
    name: 'escape_read',
    description: '读取白名单外或 deny 路径的文件（预期被 fs facade 拦截）',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件绝对路径' } },
      required: ['path'],
    },
    sandbox: {
      strategy: 'subprocess',
      // deny 显式拒绝优先于 readable/writable 白名单（如 .env 类敏感文件）。
      // 嵌套 fs 对象须给完整 SandboxFsSpec（不声明整个 fs 才走宿主侧回填）
      fs: {
        readable: [DEMO_ROOT],
        writable: [DEMO_ROOT],
        deny: [DEMO_SECRETS_ENV],
      },
    },
    async execute(_toolCallId, args) {
      const p = String((args as { path?: string }).path ?? '');
      // 越界读取 → SandboxFsViolation 抛出 → worker 兜底为 error 结果
      // 并向宿主发送 violation 遥测事件
      return text(fs.readFileSync(p, 'utf8'));
    },
  },
  {
    name: 'env_probe',
    description: '上报 worker 进程内的关键环境变量（演示 env 白名单）',
    parameters: { type: 'object', properties: {} },
    sandbox: {
      strategy: 'subprocess',
      // spec.env 显式注入（worker 不继承宿主 env，只有这里声明的才可见）
      env: { DEMO_TASK_VAR: 'injected-by-spec-env' },
    },
    async execute() {
      return text(
        JSON.stringify(
          {
            // 宿主进程设置了该变量，但 worker env 白名单构造 → 不可见
            hostOnly: process.env.AIPACK_HOST_ONLY ?? '(absent)',
            // 经 spec.env 注入 → 可见
            taskVar: process.env.DEMO_TASK_VAR ?? '(absent)',
            // 框架保留键：HOME 指向每次调用的一次性沙箱临时目录（aipack-sandbox-*）
            home: process.env.HOME,
          },
          null,
          2,
        ),
      );
    },
  },
  {
    name: 'request_secret',
    description: '经 secrets broker 按需请求宿主凭证（未声明名会被拒绝）',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '凭证名' } },
      required: ['name'],
    },
    sandbox: {
      strategy: 'subprocess',
      // 凭证请求白名单：仅允许请求 DEMO_API_KEY；沙箱内永远不存在全量凭证
      secrets: ['DEMO_API_KEY'],
    },
    async execute(_toolCallId, args) {
      const name = String((args as { name?: string }).name ?? '');
      const api = (globalThis as Record<string, unknown>)[SANDBOX_GLOBAL_KEY] as
        | { requestSecret(name: string): Promise<string> }
        | undefined;
      if (api === undefined) {
        return text('secrets API 不可用：未在沙箱 worker 内运行');
      }
      // 宿主按 spec.secrets 白名单裁决后单条发放；同时注入 worker 自身
      // process.env[name]，不改造的工具请求后也能直接读 env
      const value = await api.requestSecret(name);
      return text(`${name} = ${value.slice(0, 8)}***（按需发放，已注入 worker env）`);
    },
  },
  {
    name: 'slow_tool',
    description: '睡眠 5 秒（预期被 wallClockMs 超时强杀）',
    parameters: { type: 'object', properties: {} },
    sandbox: {
      strategy: 'subprocess',
      resources: { wallClockMs: 800 },
    },
    async execute() {
      await sleep(5000);
      return text('slept 5s（不应看到这句话）');
    },
  },
  {
    name: 'loud_tool',
    description: '向 stderr 倾泻 2MB 输出（预期触发 outputBytes 封顶强杀）',
    parameters: { type: 'object', properties: {} },
    sandbox: {
      strategy: 'subprocess',
      resources: { outputBytes: 64 * 1024 },
    },
    async execute() {
      process.stderr.write('x'.repeat(2 * 1024 * 1024));
      return text('streamed（不应看到这句话）');
    },
  },
];

export default demoTools;
