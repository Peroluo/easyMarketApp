/**
 * Runtime 构建器：把 CLI 参数解析结果组装成可运行的 Runtime。
 *
 * 职责：
 * 1. 加载 aipack.config.js（可选：approvals.enabled 等）
 * 2. 解析模型（--model 支持 provider/id；未配置时自动探测有 API Key 的提供商）
 * 3. 会话存储与 sessionKey 选择（--continue 找最新 / --session / --name / 自动生成）
 * 4. 权限策略（fs:read 放行；fs:write / shell:exec 按配置走 confirm 或 pending 审批）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createRuntime,
  adaptAiModel,
  createStreamFnFromAi,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
  BUILTIN_PROVIDERS,
  hasProviderConfigured,
  createFileSessionStorage,
  createPermissionPolicy,
  createApprovalManager,
  FileApprovalStore,
} from '@aipack-ai/agent';
import type {
  Runtime,
  Tool,
  SessionStorage,
  StoredSession,
  ApprovalManager,
  PermissionRequest,
  AiModel,
  PermissionPolicy,
  StreamFn,
} from '@aipack-ai/agent';
import { createSkillsPlugin } from '@aipack-ai/skills';
import type { Skill, SkillDiagnostic } from '@aipack-ai/skills';
import {
  createCompressionTransformer,
  loadCompressionConfig,
  type CompressionConfig,
  type ContextCompressionTransformer,
} from '@aipack-ai/compression';
import { createMcpPlugin, loadMcpConfig } from '@aipack-ai/mcp';
import type { McpPlugin } from '@aipack-ai/mcp';
import type { Args } from './args.js';
import { selectTools, BUILTIN_TOOLS } from './tools.js';
import { createTaskTool, loadSubagentConfigs, TASK_TOOL_NAME, TASK_TOOL_TIMEOUT_MS } from './subagents.js';
import type { SubagentDefinition } from './subagents.js';
import { defaultSessionDir, defaultConfigDir, legacyEncodeDir, VERSION } from './version.js';
import { createUserHooksExtension, type UserHooksConfig } from './hooks.js';
import { loadMemoryFiles } from './memory.js';

// ─── 配置文件 ─────────────────────────────────────────────────────

export interface AipackCliConfig {
  approvals?: {
    /** 是否启用异步审批（pending 决策 + ApprovalManager）。默认 false（内联 confirm） */
    enabled?: boolean;
    /** 触发审批的能力列表（默认 fs:write 与 shell:exec） */
    capabilities?: string[];
  };
  /** 额外权限规则（追加在内置规则之前，优先裁决） */
  permissionRules?: Array<{
    toolName?: string;
    permission?: string;
    decision: 'allow' | 'deny' | 'confirm' | 'pending';
  }>;
  /**
   * 用户钩子（PreToolUse / PostToolUse / UserPromptSubmit / Stop）。
   * 声明「matcher + shell 命令」，命令经 stdin 收 JSON 事件、退出码 2 或
   * stdout JSON 返回决策；失败/超时仅告警不中断。详见 src/hooks.ts。
   */
  hooks?: UserHooksConfig;
  /** 单次请求最大 agentic 回合数（默认 50） */
  maxTurns?: number;
  /**
   * 子 agent 定义（task 工具）：{ [名称]: { description, prompt, tools?, model?, maxTurns? } }。
   * 内置 general-purpose 始终可用；同名定义覆盖内置。校验失败的项告警后跳过。
   */
  agents?: Record<string, SubagentDefinition>;
}

export async function loadConfig(cwd: string): Promise<AipackCliConfig> {
  for (const file of ['aipack.config.js', 'aipack.config.mjs']) {
    const full = path.join(cwd, file);
    try {
      await fs.access(full);
    } catch {
      continue; // 文件不存在 → 尝试下一个
    }
    try {
      const mod = await import(pathToFileURL(full).href);
      const config = (mod.default ?? mod) as AipackCliConfig;
      return config ?? {};
    } catch (err) {
      // 配置文件存在但加载/解析失败：明确告警（不能静默回退默认配置，否则用户以为生效了）
      console.warn(
        `[aipack] 配置文件加载失败（${file}），已忽略该文件:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return {};
}

// ─── 模型解析 ─────────────────────────────────────────────────────

export interface ResolvedModel {
  aiModel: AiModel;
  /** 是否为目录外自定义模型 */
  custom: boolean;
}

/** 从 --model "provider/id" 或 --provider + --model 解析 */
function splitModelSpec(args: Args): { provider?: string; modelId?: string } {
  if (args.model && args.model.includes('/')) {
    const idx = args.model.indexOf('/');
    return { provider: args.model.slice(0, idx), modelId: args.model.slice(idx + 1) };
  }
  return { provider: args.provider, modelId: args.model };
}

/**
 * 默认提供商探测：优先级 deepseek > 其余已配置内置提供商。
 * - 未指定模型时，优先使用 DeepSeek（DEEPSEEK_API_KEY 已配置则用 deepseek-chat）
 * - 次选第一个已配置 API Key 的内置提供商
 * - 都未配置时回退 deepseek/deepseek-chat（调用会失败，提示用户配置 Key）
 */
function detectDefaultProvider(): { id: string; modelId: string } {
  const PRIORITY = ['deepseek'];
  for (const pid of PRIORITY) {
    if (hasProviderConfigured(pid)) {
      const models = getBuiltinModels(pid);
      if (models.length > 0) return { id: pid, modelId: models[0].id };
    }
  }
  for (const p of getBuiltinProviders()) {
    if (PRIORITY.includes(p.id)) continue;
    if (hasProviderConfigured(p.id)) {
      const models = getBuiltinModels(p.id);
      if (models.length > 0) return { id: p.id, modelId: models[0].id };
    }
  }
  return { id: 'deepseek', modelId: 'deepseek-chat' };
}

/** 为目录外模型构造最小可用的 ai Model（推断 API 类型与 baseUrl） */
export function buildCustomModel(providerId: string, modelId: string): AiModel {
  const meta = BUILTIN_PROVIDERS.find(p => p.id === providerId);
  const api = providerId === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
  // 输入能力推断：取该提供商内置模型中最常见的能力集（此前硬编码 ['text']，
  // 自定义视觉模型也会被误判为纯文本）
  const providerModels = getBuiltinModels(providerId);
  const withImage = providerModels.filter(m => m.input.includes('image')).length;
  const input = withImage > 0 && withImage >= providerModels.length / 2
    ? ['text', 'image']
    : ['text'];
  return {
    id: modelId,
    name: modelId,
    provider: providerId,
    api,
    baseUrl: meta?.baseUrl,
    reasoning: false,
    input,
    contextWindow: 128000,
    maxTokens: 16384,
  } as AiModel;
}

export function resolveModel(args: Args): ResolvedModel {
  const spec = splitModelSpec(args);
  const fallback = detectDefaultProvider();
  const providerId = spec.provider ?? fallback.id;
  const modelId = spec.modelId ?? fallback.modelId;

  const builtin = getBuiltinModel(providerId, modelId);
  if (builtin) return { aiModel: builtin, custom: false };
  return { aiModel: buildCustomModel(providerId, modelId), custom: true };
}

// ─── 会话解析 ─────────────────────────────────────────────────────

export interface SessionChoice {
  sessionKey: string;
  /** 是否复用了已存在的会话（--continue / --session） */
  resumed: boolean;
}

/** 会话列表条目：key + 可读标题 + 更新时间（/sessions、--resume 展示用） */
export interface SessionInfo {
  key: string;
  /** 首条用户消息摘要（前 40 字符）；无用户消息时为空串 */
  title: string;
  updatedAt: string;
}

/** 从会话提取可读标题：/rename 命名的 title 优先，缺省回退首条 user 消息摘要 */
export function extractSessionTitle(session: StoredSession): string {
  const named = session.title?.trim();
  if (named) return named.length > 40 ? `${named.slice(0, 40)}…` : named;
  for (const m of session.messages) {
    if (m.role !== 'user') continue;
    const text = Array.isArray(m.content)
      ? m.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join(' ')
      : m.content;
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (oneLine) return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
  }
  return '';
}

/** ISO 时间 → 相对时间描述（刚刚 / N 分钟前 / N 小时前 / 昨天 HH:MM / M月D日 / YYYY-MM-DD） */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = now - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const today = new Date(now);
  if (d.getFullYear() === today.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 列出会话信息（按 updatedAt 降序，最多 50 个）；load 失败的条目标题/时间为空 */
export async function listSessionInfos(storage: SessionStorage): Promise<SessionInfo[]> {
  const keys = await storage.list();
  // 上限 50：展示（10 个）与 -c（1 个）场景足够，避免全量 load 造成无谓开销
  const entries = await Promise.all(
    keys.slice(0, 50).map(async key => {
      const s = await storage.load(key);
      return { key, title: s ? extractSessionTitle(s) : '', updatedAt: s?.updatedAt ?? '' };
    }),
  );
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 列出存储中按 updatedAt 降序的会话 key（最多 50 个） */
export async function listSessionsByRecency(storage: SessionStorage): Promise<string[]> {
  return (await listSessionInfos(storage)).map(e => e.key);
}

export async function resolveSessionKey(
  args: Args,
  storage: SessionStorage | undefined,
): Promise<SessionChoice> {
  if (args.noSession) return { sessionKey: `ephemeral-${Date.now().toString(36)}`, resumed: false };
  if (args.session) {
    const key = sanitizeKey(args.session);
    // 存在性校验：--session 指向不存在的 key 时明确提示（与 -c 未命中行为一致），
    // 避免"以为在恢复旧会话、实际在新建"
    if (storage) {
      const existing = await storage.load(key);
      if (!existing) {
        console.warn(`[aipack] 会话 "${key}" 不存在，将新建会话`);
        return { sessionKey: key, resumed: false };
      }
    }
    return { sessionKey: key, resumed: true };
  }
  if (args.name) return { sessionKey: sanitizeKey(args.name), resumed: false };

  if (args.continue && storage) {
    const recent = await listSessionsByRecency(storage);
    if (recent.length > 0) return { sessionKey: recent[0], resumed: true };
    // 没有历史会话 → 落到新建
  }

  return { sessionKey: `s-${Date.now().toString(36)}`, resumed: false };
}

/**
 * 会话 key 安全化：ASCII 安全字符保留，其余字符 percent-encode。
 * 旧实现把非安全字符统一折叠为 "_"，"我的项目" 与 "你的项目" 碰撞成同一 key "___"；
 * percent-encode 后互不冲突。纯 ASCII 旧 key 编码不变（向后兼容）。
 */
function sanitizeKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-:.]/g, ch => encodeURIComponent(ch));
}

// ─── 权限策略 ─────────────────────────────────────────────────────

export interface BuildRuntimeOptions {
  args: Args;
  cwd: string;
  /** 内联人工确认回调（confirm 决策时调用；返回 true 放行） */
  confirmFn?: (req: PermissionRequest) => Promise<boolean>;
  /** 覆盖审批是否启用（默认读配置文件） */
  approvalsEnabled?: boolean;
}

export interface BuiltRuntime {
  runtime: Runtime;
  sessionKey: string;
  /** 是否复用了已存在的会话（--continue 命中 / --session） */
  resumed: boolean;
  storage?: SessionStorage;
  approvalManager?: ApprovalManager;
  model: ResolvedModel;
  config: AipackCliConfig;
  /** 压缩策略管道转换器（--no-compaction 时为 undefined） */
  compressionTransformer?: ContextCompressionTransformer;
  /**
   * 更新压缩链使用的模型（/model 切换时调用）。
   * 压缩 transformer 持有构造时的 streamFn/model 闭包，不更新会导致
   * 切换模型后 summarize 的摘要请求仍走旧模型。
   * 注意：contextWindow 在构造时固定，切换后由 runtime 内置压缩兜底。
   */
  setCompressionModel: (aiModel: AiModel) => void;
  /** MCP 插件（/mcp 命令用；无 .mcp.json 配置时为 undefined） */
  mcp?: McpPlugin;
  /** 已加载的项目记忆文件（/memory 命令展示；无记忆文件时为空数组） */
  memoryFiles: string[];
  /** 已注册的 skills（/skills 与 /skill:name 命令用；无 skill 时为空数组） */
  skills: Skill[];
  /** 可用子 agent 定义（/agents 命令展示；始终含内置 general-purpose） */
  subagents: Map<string, SubagentDefinition>;
  /** task（子 agent）工具是否已启用（被 --no-tools/-xt task/--tools 白名单排除时为 false） */
  taskEnabled: boolean;
}

// ─── 上下文压缩 ───────────────────────────────────────────────────

/**
 * 加载压缩配置：默认配置 + aipack.config.js 的 compression 字段 +
 * --compaction-config 指定的 JSON 文件（后者优先级最高）。
 * 文件读取/解析失败仅告警，回退默认配置（不阻塞启动）。
 */
async function loadCompressionSettings(
  args: Args,
  config: AipackCliConfig,
): Promise<CompressionConfig> {
  const overrides: Record<string, unknown> = {};
  const fromConfigFile = (config as { compression?: Record<string, unknown> }).compression;
  if (fromConfigFile) Object.assign(overrides, fromConfigFile);

  if (args.compactionConfig) {
    try {
      const raw = await fs.readFile(args.compactionConfig, 'utf8');
      Object.assign(overrides, JSON.parse(raw));
    } catch (err) {
      console.warn(`[aipack] 压缩配置文件加载失败（${args.compactionConfig}），使用默认配置:`,
        err instanceof Error ? err.message : String(err));
    }
  }

  return loadCompressionConfig(overrides);
}

/**
 * 构建 v2 压缩转换器（策略管道：trim → summarize → truncate，双水位调度）。
 * 作为第一级 transformer 加入 runtime 降级链：压缩管道 → runtime 内置摘要压缩 → 硬截断。
 *
 * streamFn 用"委托"实现：transformer 构造后持有闭包，无法替换；
 * 委托函数每次调用时读取最新的 compressionAiModel，/model 切换后
 * summarize/lifecycle 的摘要请求跟随当前模型（而非构造时的旧模型）。
 */
async function buildCompressionTransformer(opts: {
  args: Args;
  config: AipackCliConfig;
  model: ResolvedModel;
  streamFn: ReturnType<typeof createStreamFnFromAi>;
}): Promise<{
  transformer: ContextCompressionTransformer;
  setModel: (aiModel: AiModel) => void;
} | undefined> {
  if (opts.args.noCompaction) return undefined;

  const compressionConfig = await loadCompressionSettings(opts.args, opts.config);

  // 可变模型引用：setCompressionModel 更新，委托 streamFn 读取
  let compressionAiModel = opts.model.aiModel;
  const apiKey = opts.args.apiKey;
  const delegatingStreamFn: StreamFn = async function* (_m, context, streamOptions) {
    // 忽略 transformer 传入的（构造时闭包捕获的旧）model，始终使用当前模型
    const fn = createStreamFnFromAi(compressionAiModel, { apiKey });
    yield* fn(adaptAiModel(compressionAiModel), context, streamOptions);
  };

  const transformer = createCompressionTransformer({
    config: compressionConfig,
    model: adaptAiModel(opts.model.aiModel),
    streamFn: delegatingStreamFn,
    contextWindow: opts.model.aiModel.contextWindow,
  });

  // 上下文耗尽事件：默认仅提示（交互模式会注册自己的处理器以真正切换 activeKey；
  // print/json 单次请求模式下会话随进程结束，提示即足够）
  transformer.onContextExhausted((e) => {
    console.warn(
      `[aipack] 上下文已达极限（${e.reason}），已生成交接文档并建议切换到新会话 ${e.suggestedSessionId}。` +
      `恢复: aipack --session ${e.suggestedSessionId}`,
    );
  });

  return {
    transformer,
    setModel: (aiModel: AiModel) => { compressionAiModel = aiModel; },
  };
}

const DEFAULT_APPROVAL_CAPABILITIES = ['fs:write', 'shell:exec'];

export async function buildRuntime(options: BuildRuntimeOptions): Promise<BuiltRuntime> {
  const { args, cwd } = options;
  const config = await loadConfig(cwd);

  // ── 模型与 streamFn ──
  const model = resolveModel(args);
  const streamFn = createStreamFnFromAi(model.aiModel, {
    apiKey: args.apiKey,
  });

  // ── 工具 ──
  const toolSelection = selectTools({
    tools: args.tools,
    excludeTools: args.excludeTools,
    noTools: args.noTools,
  });
  const tools: Tool[] = toolSelection.tools;
  if (toolSelection.unknown.length > 0) {
    // 白/黑名单中的未知工具名：拼错即静默失效（黑名单拼错 = 权限范围意外扩大）
    console.warn(
      `[aipack] --tools/--exclude-tools 中的未知工具名（已忽略）: ${toolSelection.unknown.join(', ')}` +
      `；可用工具: ${[...BUILTIN_TOOLS.map(t => t.name), TASK_TOOL_NAME].join(', ')}`,
    );
  }
  // task（子 agent）工具：跟随白/黑名单语义（-xt task 可单独禁用）
  const taskEnabled = !args.noTools
    && !(args.excludeTools?.includes(TASK_TOOL_NAME))
    && (!args.tools || args.tools.includes(TASK_TOOL_NAME));

  // ── 会话存储 ──
  // 目录编码兼容：旧编码（非安全字符统一折叠为 _，存在 /a/b 与 /a.b 碰撞）→ 新编码（encodeURIComponent，无碰撞）。
  // 旧目录已存在而新目录尚未创建时继续沿用旧目录，避免存量会话"消失"。
  const storage = args.noSession
    ? undefined
    : createFileSessionStorage({
        baseDir: args.sessionDir ?? await resolveSessionDir(cwd),
      });
  const session = await resolveSessionKey(args, storage);

  // ── 审批与权限 ──
  const approvalsEnabled = options.approvalsEnabled ?? config.approvals?.enabled === true;
  const approvalCaps = new Set(config.approvals?.capabilities ?? DEFAULT_APPROVAL_CAPABILITIES);

  let approvalManager: ApprovalManager | undefined;
  if (approvalsEnabled) {
    approvalManager = createApprovalManager({
      store: new FileApprovalStore({
        baseDir: path.join(defaultConfigDir(), 'approvals'),
      }),
    });
    await approvalManager.restore();
  }

  const policy = buildPermissionPolicy({
    config,
    approvalCaps,
    approvalsEnabled,
    safe: args.safe === true,
    confirmFn: options.confirmFn,
  });

  // ── MCP 插件（.mcp.json：项目级 .mcp.json 优先于用户级 ~/.aipack/mcp.json）──
  const mcpConfig = await loadMcpConfig({ cwd });
  if (mcpConfig.diagnostics.length > 0) {
    for (const d of mcpConfig.diagnostics) {
      console.warn(`[aipack] MCP config ${d.type} [${d.server}]: ${d.message}`);
    }
  }
  const mcp = mcpConfig.servers.length > 0 ? createMcpPlugin({ servers: mcpConfig.servers }) : undefined;

  // ── Skills 插件（@aipack-ai/skills：Extension 零侵入接入；user → project，同名先注册者胜）──
  const skillsPlugin = createSkillsPlugin({ load: { cwd } });
  reportSkillDiagnostics(skillsPlugin.diagnostics);
  const skills = skillsPlugin.skills;

  // ── 项目记忆文件（用户级 + 项目级，@import 展开；无文件零改动）──
  const memory = await loadMemoryFiles(cwd);

  // ── 子 agent / task 工具（定义来自 aipack.config.js agents 字段 + 内置 general-purpose）──
  // 依赖权限策略与记忆内容，故在两者就绪后构建；子 agent 基础工具集为当前内置工具快照
  const subagents = loadSubagentConfigs(config.agents, BUILTIN_TOOLS.map(t => t.name));
  for (const w of subagents.warnings) {
    console.warn(`[aipack] ${w}`);
  }
  if (taskEnabled) {
    const subagentBaseTools = [...tools];
    /** 子 agent model 覆盖解析：provider/id（无 provider 前缀时沿用主模型提供商） */
    const resolveAgentModelSpec = (spec: string): AiModel | undefined => {
      const slash = spec.indexOf('/');
      const provider = slash !== -1 ? spec.slice(0, slash) : model.aiModel.provider;
      const id = slash !== -1 ? spec.slice(slash + 1) : spec;
      if (!id) return undefined;
      return getBuiltinModel(provider, id) ?? buildCustomModel(provider, id);
    };
    tools.push(createTaskTool({
      getModel: () => model.aiModel,
      resolveModelSpec: resolveAgentModelSpec,
      apiKey: args.apiKey,
      cwd,
      tools: subagentBaseTools,
      definitions: subagents.definitions,
      permissionPolicy: policy,
      approvals: approvalManager,
      memoryContent: memory.content,
      thinkingLevel: args.thinking,
    }));
  }

  // ── 系统提示词 ──
  const systemPrompt = buildSystemPrompt(args, memory.content);

  // ── 上下文压缩（策略管道 transformer + runtime 内置摘要兜底）──
  const compression = await buildCompressionTransformer({
    args,
    config,
    model,
    streamFn,
  });

  // ── 组装 Runtime ──
  // 用户 hooks（aipack.config.js 的 PreToolUse 等）：无配置时为 undefined，零开销
  const userHooksExtension = createUserHooksExtension(config.hooks);
  const extensions = [
    ...(mcp?.extensions ?? []),
    ...(userHooksExtension ? [userHooksExtension] : []),
    ...skillsPlugin.extensions,
  ];

  const runtime = await createRuntime({
    model: adaptAiModel(model.aiModel),
    streamFn,
    systemPrompt,
    tools,
    workspace: cwd,
    config: { cli: true, version: VERSION, cwd },
    sessionStorage: storage,
    thinkingLevel: args.thinking,
    permissionPolicy: policy,
    approvals: approvalManager,
    // 回合数上限：--max-turns > aipack.config.js > 默认 50
    maxTurns: args.maxTurns ?? config.maxTurns ?? 50,
    // task 工具启用时抬高单工具超时兜底：子 agent 完整运行受主 runtime 的
    // 单工具超时约束（默认 120s 不够），10 分钟与 bash 超时上限对齐
    ...(taskEnabled ? { toolTimeoutMs: TASK_TOOL_TIMEOUT_MS } : {}),
    transformers: compression ? [compression.transformer] : [],
    // MCP 插件 + 用户 hooks + skills：Extension 零侵入接入
    ...(extensions.length > 0 ? { extensions } : {}),
    // --no-compaction 时一并关闭内置摘要压缩（仅保留硬截断兜底）
    compaction: args.noCompaction ? { enabled: false } : { enabled: true },
  });

  return {
    runtime,
    sessionKey: session.sessionKey,
    resumed: session.resumed,
    storage,
    approvalManager,
    model,
    config,
    compressionTransformer: compression?.transformer,
    setCompressionModel: compression?.setModel ?? (() => {}),
    mcp,
    memoryFiles: memory.files,
    skills,
    subagents: subagents.definitions,
    taskEnabled,
  };
}

/** skills 加载诊断告警（error / collision 可见，warning 静默） */
function reportSkillDiagnostics(diagnostics: SkillDiagnostic[]): void {
  for (const d of diagnostics) {
    if (d.type === 'error') {
      console.warn(`[aipack] skill 加载错误: ${d.message}${d.path ? `（${d.path}）` : ''}`);
    } else if (d.type === 'collision') {
      console.warn(`[aipack] skill 同名冲突: ${d.message}`);
    }
  }
}

/**
 * 解析会话存储目录：优先新编码目录；旧编码目录已存在且新目录不存在时
 * 沿用旧目录（兼容存量会话，避免升级后 --continue 找不到历史）。
 */
async function resolveSessionDir(cwd: string): Promise<string> {
  const modern = defaultSessionDir(cwd);
  const legacy = path.join(defaultConfigDir(), 'cli-sessions', legacyEncodeDir(cwd));
  if (modern === legacy) return modern;
  try {
    await fs.access(legacy);
    try {
      await fs.access(modern);
    } catch {
      return legacy; // 旧目录存在、新目录不存在 → 继续用旧目录
    }
  } catch {
    // 旧目录不存在 → 新目录
  }
  return modern;
}

function buildPermissionPolicy(opts: {
  config: AipackCliConfig;
  approvalCaps: Set<string>;
  approvalsEnabled: boolean;
  safe: boolean;
  confirmFn?: (req: PermissionRequest) => Promise<boolean>;
}): PermissionPolicy {
  const { config, approvalCaps, approvalsEnabled, safe, confirmFn } = opts;

  const customRules = (config.permissionRules ?? []).map(r => ({
    name: `config:${r.permission ?? r.toolName ?? '*'}`,
    toolName: r.toolName ? new RegExp(`^${r.toolName}$`) : undefined,
    permission: r.permission,
    decision: r.decision,
  }));

  /**
   * 高风险能力默认决策（优先级：approvals > safe > 智能默认）：
   * - approvals.enabled → pending（异步审批）
   * - --safe → confirm（全部人工确认）
   * - 默认 → fs:write 放行（工作区防护兜底）、shell:exec 走 confirm，
   *   由 confirmFn 自动放行非危险命令（危险命令才弹选择器）
   */
  const highRiskRules = [...approvalCaps].flatMap(cap => {
    let decision: 'pending' | 'confirm' | 'allow';
    if (approvalsEnabled) decision = 'pending';
    else if (safe) decision = 'confirm';
    else decision = cap === 'fs:write' ? 'allow' : 'confirm';
    return [{ name: `builtin:${cap}:${decision}`, permission: cap, decision }];
  });

  // MCP 工具（permissions: mcp:<server>）：外部进程/网络调用，不可默认放行
  // - approvals.enabled → pending（异步审批）
  // - 否则 → confirm（内联确认）
  const mcpDecision: 'pending' | 'confirm' = approvalsEnabled ? 'pending' : 'confirm';
  const mcpRule = { name: `builtin:mcp:${mcpDecision}`, permission: 'mcp', decision: mcpDecision };

  return createPermissionPolicy({
    rules: [
      ...customRules,
      ...highRiskRules,
      mcpRule,
      { name: 'builtin:read', permission: 'fs:read', decision: 'allow' as const },
      // 未声明 permissions 的安全工具放行
      { name: 'builtin:safe-tools', decision: 'allow' as const },
    ],
    confirmFn,
    defaultDecision: 'deny',
  });
}

function buildSystemPrompt(args: Args, memoryContent: string): string {
  const base = args.systemPrompt ?? [
    '你是 aipack，一个终端里的 AI 编程助手。',
    '你可以使用工具读写文件、执行命令来完成用户的任务。',
    '回答保持简洁、技术化，使用与用户相同的语言。',
  ].join('\n');

  const appended = args.appendSystemPrompt ?? [];
  // 项目记忆注入尾部（--system-prompt 自定义时同样生效：记忆是项目事实，非人设）
  const memory = memoryContent.trim()
    ? ['以下项目记忆来自记忆文件（AIPACK.md / AGENTS.md / CLAUDE.md），是用户与团队的既定约定，请遵循：', memoryContent.trim()].join('\n')
    : '';
  return [base, ...appended, memory].filter(s => s !== '').join('\n\n');
}
