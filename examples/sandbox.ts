/**
 * 根目录示例：工具执行沙箱（Sandbox 隔离层，Tier 1 subprocess provider）
 *
 * 演示沙箱约束在真实工具调用链路上的效果（工具声明 Tool.sandbox → 沙箱执行）：
 *   1. 白名单内执行：worker 子进程按 spec 跑工具，结果跨进程往返
 *   2. fs 越界读取：读 workspace 外文件 → SandboxFsViolation 拦截 + violation 遥测
 *   3. fs.deny 显式拒绝：白名单内但命中 deny（如 .env）同样被拦（deny 优先）
 *   4. env 白名单：worker 不继承宿主 env；spec.env 显式注入可见；HOME 是一次性临时目录
 *   5. secrets broker：凭证按需单条发放（requestSecret）；未声明名 → 拒绝 + violation
 *   6. wallClockMs 超时强杀
 *   7. outputBytes 输出封顶（超限 kill + 截断）
 *
 * 关键点：
 * - 沙箱与权限层正交：Permission = 事前授权（fail-closed），
 *   Sandbox = 事中约束（fail-open：能力不足降级 + 告警，授权层仍是底线）；
 * - 声明了 Tool.sandbox 的工具必须来自命名模块（toolModules，见 sandbox-tools.ts），
 *   闭包工具无法跨进程；未声明的工具行为零变化（零迁移保证）；
 * - worker env 由白名单构造（绝不继承宿主），HOME/TMPDIR 用后清理；
 * - 全程经 telemetry.onSandboxEvent 观测 spawn / violation / killed / exit 事件；
 * - 强隔离升级路径：strategy 声明 'os' → Linux bwrap / macOS Seatbelt（内核边界），
 *   Windows 走进程树事后审计；本例聚焦跨平台基线 'subprocess'。
 *
 * 运行（需先构建 agent 包，worker 以 dist/sandbox/worker.js 启动）:
 *   pnpm build:agent && npx tsx examples/sandbox.ts
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createRuntime,
  createRequest,
  createAllowAllPolicy,
  SubprocessSandboxProvider,
} from '@aipack-ai/agent';
import type {
  AssistantMessage,
  StreamEvent,
  StreamFn,
  Telemetry,
  Tool,
} from '@aipack-ai/agent';
import demoTools, { DEMO_NOTES, DEMO_ROOT, DEMO_SECRETS_ENV, OUTSIDE_FILE } from './sandbox-tools';

// ─── 脚本化模型：用固定脚本替代真实 LLM（无需 API Key，离线可跑）────

type ScriptStep =
  | { toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> }
  | { text: string };

/** 每次被调用时消费一个脚本步骤；脚本耗尽后兜底返回文本 */
function createScriptedStreamFn(script: ScriptStep[]): StreamFn {
  const queue = [...script];
  return async function* (): AsyncGenerator<StreamEvent> {
    const step = queue.shift() ?? { text: '(脚本结束)' };
    const usage = { input: 10, output: 5, total: 15 };
    const message: AssistantMessage =
      'toolCalls' in step
        ? {
            role: 'assistant',
            content: step.toolCalls.map((tc) => ({
              type: 'toolCall' as const,
              id: tc.id,
              name: tc.name,
              arguments: tc.args,
            })),
            stopReason: 'toolUse',
            usage,
            timestamp: Date.now(),
          }
        : {
            role: 'assistant',
            content: [{ type: 'text', text: step.text }],
            stopReason: 'stop',
            usage,
            timestamp: Date.now(),
          };
    yield { type: 'done', message };
  };
}

// ─── 沙箱配置：Tier 1 subprocess provider + worker 池关闭 ────────────

// 工具模块：worker 进程按路径重新 import 并重建注册表（闭包工具无法跨进程）
const toolsModulePath = fileURLToPath(new URL('./sandbox-tools.ts', import.meta.url));

const sandboxProvider = new SubprocessSandboxProvider({
  // worker 以 tsx loader 启动 → 可 import TS 工具模块；
  // 发布形态可直接用 dist/sandbox/worker.js + .js 工具模块（无需 nodeArgs）
  nodeArgs: ['--import', import.meta.resolve('tsx')],
  toolModules: [toolsModulePath],
  // 每次调用独立 worker（spawn → init → exec → 销毁），演示语义最直白；
  // 生产可开池化复用（默认 { maxWorkers: 3, idleTtlMs: 60000 }）
  pool: { maxWorkers: 0 },
});

// ─── 沙箱事件采集（telemetry.onSandboxEvent）+ 工具结果采集 ─────────

const sandboxEvents: string[] = [];
/** 各 session 最近一次工具执行的实际 ToolResult（res.content 只是最终回复文本） */
const toolResultBySession = new Map<string, string>();
const eventCounts = { violation: 0, killed: 0 };

const telemetry: Telemetry = {
  onSandboxEvent(info) {
    if (info.type === 'violation') eventCounts.violation++;
    if (info.type === 'killed') eventCounts.killed++;
    const detail = info.detail && Object.keys(info.detail).length > 0
      ? ` ${JSON.stringify(info.detail)}`
      : '';
    sandboxEvents.push(`[${info.type}] ${info.toolName} (${info.strategy})${detail}`);
  },
  onToolCall(info) {
    const text = info.result.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    toolResultBySession.set(info.sessionKey, text || '(空结果)');
  },
};

// ─── Runtime 工厂：共享 provider / 遥测，每次场景一个脚本 ────────────

function makeRuntime(script: ScriptStep[]) {
  return createRuntime({
    streamFn: createScriptedStreamFn(script),
    tools: demoTools satisfies Tool[],
    // 本例聚焦沙箱：权限层全放行（未配置策略时框架默认 fail-closed 拒绝所有工具）。
    // 生产中权限层与沙箱叠加使用：先授权、再进笼。
    permissionPolicy: createAllowAllPolicy(),
    workspace: DEMO_ROOT, // 工具 fs 声明缺省时，readable/writable 回填该根
    sandbox: {
      provider: sandboxProvider,
      // 运行时全局基线：mergeSpec 与工具声明合并时只收紧不放宽
      //（如 wallClockMs 双方都声明时取 min）
      defaults: { resources: { wallClockMs: 30_000 } },
    },
    telemetry,
    systemPrompt: '你是一个会调用工具的助手。',
  });
}

/** 跑一个场景：一段脚本（一次工具调用）→ 返回工具实际结果与本轮沙箱事件 */
async function runScenario(sessionKey: string, toolCall: { id: string; name: string; args: Record<string, unknown> }) {
  const before = sandboxEvents.length;
  const rt = makeRuntime([
    { toolCalls: [toolCall] },
    { text: '(工具调用完成)' },
  ]);
  await rt.run(createRequest('按脚本触发一次工具调用', { sessionKey }));
  await rt.close();
  return {
    toolResult: toolResultBySession.get(sessionKey) ?? '(工具未执行)',
    events: sandboxEvents.slice(before),
  };
}

// ─── 输出辅助 ────────────────────────────────────────────────────────

function section(title: string) {
  console.log(`\n${'─'.repeat(56)}\n  ${title}\n${'─'.repeat(56)}`);
}

function showResult(label: string, content: string) {
  console.log(`  ${label}: ${content.replace(/\n/g, ' ⏎ ').slice(0, 110)}`);
}

function printEvents(events: string[]) {
  if (events.length === 0) {
    console.log('  (无沙箱事件)');
    return;
  }
  for (const e of events) console.log(`  • ${e}`);
}

// ─── 主流程 ─────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   aipack 工具沙箱演示（Sandbox · Tier 1 subprocess） ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  // ── 准备演示环境：workspace（fs 白名单根）+ 内外两份"敏感"文件 ──
  fs.rmSync(DEMO_ROOT, { recursive: true, force: true });
  fs.mkdirSync(DEMO_ROOT, { recursive: true });
  fs.writeFileSync(DEMO_NOTES, 'workspace 笔记：aipack 沙箱演示。\n');
  fs.writeFileSync(DEMO_SECRETS_ENV, 'DATABASE_PASSWORD=should-never-be-read\n');
  fs.writeFileSync(OUTSIDE_FILE, 'workspace 之外的秘密（不在任何白名单内）。\n');
  console.log(`  workspace : ${DEMO_ROOT}`);
  console.log(`  哨兵文件  : ${OUTSIDE_FILE}`);

  // 宿主持有变量：worker env 白名单构造 → 沙箱内不可见；DEMO_API_KEY 供 broker 发放
  process.env.AIPACK_HOST_ONLY = 'host-only-should-not-leak';
  process.env.DEMO_API_KEY = 'demo-key-1234567890abcdef';

  // ── 1. 白名单内正常执行 ──────────────────────────────────────
  section('1. 白名单内执行 —— worker 子进程按 spec 跑工具，结果跨进程往返');
  const s1 = await runScenario('sb-ok', {
    id: 'c1', name: 'safe_read', args: { path: DEMO_NOTES },
  });
  showResult('工具返回', s1.toolResult);
  printEvents(s1.events);

  // ── 2. fs 越界读取被拦截 ─────────────────────────────────────
  section('2. fs 越界 —— 读 workspace 外文件 → 拦截 + violation 遥测');
  const s2 = await runScenario('sb-outside', {
    id: 'c2', name: 'escape_read', args: { path: OUTSIDE_FILE },
  });
  showResult('工具返回', s2.toolResult);
  printEvents(s2.events);

  // ── 3. deny 显式拒绝优先 ─────────────────────────────────────
  section('3. fs.deny —— 白名单内但命中显式拒绝（secrets.env）同样被拦');
  const s3 = await runScenario('sb-deny', {
    id: 'c3', name: 'escape_read', args: { path: DEMO_SECRETS_ENV },
  });
  showResult('工具返回', s3.toolResult);
  printEvents(s3.events);

  // ── 4. env 白名单 ────────────────────────────────────────────
  section('4. env 白名单 —— 不继承宿主 env；spec.env 注入可见；HOME 一次性');
  const s4 = await runScenario('sb-env', { id: 'c4', name: 'env_probe', args: {} });
  for (const line of s4.toolResult.split('\n')) console.log(`  ${line}`);
  printEvents(s4.events);

  // ── 5. secrets broker：声明名发放 / 未声明名拒绝 ─────────────
  section('5. secrets broker —— 凭证按需单条发放（5a），未声明名拒绝（5b）');
  const s5a = await runScenario('sb-secret-ok', {
    id: 'c5a', name: 'request_secret', args: { name: 'DEMO_API_KEY' },
  });
  showResult('已声明 → 工具返回', s5a.toolResult);
  const s5b = await runScenario('sb-secret-no', {
    id: 'c5b', name: 'request_secret', args: { name: 'UNDECLARED_SECRET' },
  });
  showResult('未声明 → 工具返回', s5b.toolResult);
  printEvents([...s5a.events, ...s5b.events]);

  // ── 6. wallClockMs 超时强杀 ──────────────────────────────────
  section('6. 资源限额（wallClockMs=800）—— 超时强杀整个 worker（杀树）');
  const s6 = await runScenario('sb-wallclock', { id: 'c6', name: 'slow_tool', args: {} });
  showResult('工具返回', s6.toolResult);
  printEvents(s6.events);

  // ── 7. outputBytes 输出封顶 ──────────────────────────────────
  section('7. 资源限额（outputBytes=64KB）—— 输出超限 kill + 截断结果');
  const s7 = await runScenario('sb-output', { id: 'c7', name: 'loud_tool', args: {} });
  showResult('工具返回', s7.toolResult);
  printEvents(s7.events);

  // ── 清理与汇总 ───────────────────────────────────────────────
  section('汇总');
  console.log(`  沙箱事件总数: ${sandboxEvents.length} | violation 拦截: ${eventCounts.violation} 次 | 强杀: ${eventCounts.killed} 次`);
  console.log('  工具全程跑在独立 worker 进程：env 白名单、HOME 一次性目录、结果跨进程往返');
  console.log('  升级强隔离：工具声明 strategy "os" → Linux bwrap / macOS Seatbelt（内核边界）');

  fs.rmSync(DEMO_ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE_FILE, { force: true });
  console.log('\n✅ 沙箱演示完成（演示目录已清理）');
}

main().catch((err) => {
  console.error('运行失败:', err);
  process.exit(1);
});
