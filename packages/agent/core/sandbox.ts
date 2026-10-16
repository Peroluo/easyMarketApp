/**
 * core/sandbox - 工具执行隔离层契约（Sandbox）
 *
 * 与 PermissionPolicy 同构定位：接口定义在 core（契约层），实现按平台分层
 * （subprocess provider / OS 沙箱 provider），经 RuntimeOptions.sandbox 注入。
 *
 * 职责划分（两层正交）：
 * - Permission（已有）= 事前授权：这次调用允不允许（fail-closed）
 * - Sandbox（本契约） = 事中约束：允许后在哪个笼子里执行（能力不足降级 + 告警）
 *
 * 隔离强度分级（SandboxStrategy，强度递增）：
 *   inprocess(0) < subprocess(1) < os(2) < microvm(3)
 * 降级链：平台能力不足时 microvm → os → subprocess → inprocess 逐级回退，
 * 每级降级须发 degraded 事件；enforced 严格模式下禁止降级（M3 接线）。
 *
 * 设计原则：
 * - 零迁移保证：未声明 Tool.sandbox 的工具不进入隔离链路，行为零变化；
 * - 收紧语义：mergeSpec 保证运行时（defaults）只能比工具声明更严，不能更宽；
 * - fail-open（与权限层 fail-closed 相反）：沙箱是加固层而非授权层，
 *   能力不足时降级放行 + 遥测告警，授权层（PermissionPolicy）仍是安全底线。
 */

import type { ToolResult } from './types';

// ─── 执行环境规格 ─────────────────────────────────────────────────

/** 隔离策略（强度递增：inprocess < subprocess < os < microvm） */
export type SandboxStrategy = 'inprocess' | 'subprocess' | 'os' | 'microvm';

/** 文件系统约束：路径前缀白名单（provider 侧 resolve/realpath 后词法前缀匹配） */
export interface SandboxFsSpec {
  /** 可读路径前缀（含自身）。工具侧缺省 = 回填 workspace 根（见 mergeSpec） */
  readable: string[];
  /** 可写路径前缀（含自身）。工具侧缺省 = 回填 workspace 根 */
  writable: string[];
  /** 显式拒绝路径前缀，优先级高于 readable/writable（如 ~/.ssh、.env） */
  deny?: string[];
}

export type SandboxNetMode = 'deny' | 'allow' | 'proxy';

export interface SandboxNetSpec {
  /**
   * 网络约束。严格度 deny < proxy < allow，mergeSpec 取更严值。
   * deny：默认（deny-by-default）；proxy：经审计代理 + hosts 白名单；
   * allow：直连（仅限显式声明，发遥测告警提示收敛）。
   */
  mode: SandboxNetMode;
  /** proxy 模式下经审计代理放行的域名白名单（大小写不敏感；
   *  proxy 未提供 hosts = 代理全拒，等效 deny） */
  hosts?: string[];
}

/** 资源限额（全部可选；数值语义为"上限"，mergeSpec 逐字段取双方更小值） */
export interface SandboxResourceSpec {
  /** 墙钟（毫秒）。provider 侧与 toolTimeoutMs 取 min */
  wallClockMs?: number;
  /** CPU 时间（毫秒；Tier 2 cgroup/Job Object 硬配额，Tier 1 采样近似） */
  cpuMs?: number;
  /** 内存上限（MB） */
  memoryMb?: number;
  /** 并发进程数上限（防 fork 炸弹；Tier 1 为事后审计，Tier 2 为硬配额） */
  processes?: number;
  /** stdout+stderr 字节数上限（防输出爆炸；provider 侧超限截断 + kill） */
  outputBytes?: number;
  /** 磁盘写入上限（Tier 2+ 配额；Tier 1 以输出量近似） */
  diskWriteBytes?: number;
}

/** 一次沙箱化工具调用的完整执行环境规格（mergeSpec 产出的完备形态） */
export interface SandboxSpec {
  strategy: SandboxStrategy;
  fs: SandboxFsSpec;
  net: SandboxNetSpec;
  /** 显式注入 worker 进程的环境变量（不继承宿主 env）。
   *  框架保留变量（PATH/HOME/TMPDIR 等）由 provider 白名单构造，spec.env 不可覆盖（M2 接线）。 */
  env: Record<string, string>;
  resources: SandboxResourceSpec;
}

// ─── 工具侧声明（Tool.sandbox 字段类型）────────────────────────────

/** 工具沙箱声明的解析上下文（工厂形参 ctx） */
export interface ToolSandboxContext {
  /** RuntimeOptions.workspace，fs 缺省回填根 */
  workspace?: string;
}

/**
 * 工具侧沙箱声明：允许 Partial（缺省字段由 mergeSpec 回填默认值），
 * 或基于 args 的动态工厂（如按命令参数授予不同可写路径）。
 * 未声明（undefined）= 不进入隔离链路，直跑（零迁移保证）。
 */
export type ToolSandboxDeclaration =
  | Partial<SandboxSpec>
  | ((args: unknown, ctx: ToolSandboxContext) => Partial<SandboxSpec>);

// ─── Provider 接口 ─────────────────────────────────────────────────

export interface SandboxRunRequest {
  toolName: string;
  toolCallId: string;
  args: unknown;
  spec: SandboxSpec;
  signal: AbortSignal;
  /** 沙箱事件回调（violation / 降级 / 限额触发，provider 内部上报，透传遥测） */
  onEvent?: (event: SandboxEvent) => void;
}

export interface SandboxProvider {
  /** 能力探测：当前平台/环境是否支持该 strategy（降级链判定依据） */
  supports(strategy: SandboxStrategy): Promise<boolean>;

  /** 在 spec 约束下执行工具，返回 ToolResult（兼容现有 resourcesToMessages 契约） */
  run(req: SandboxRunRequest): Promise<ToolResult>;
}

// ─── 沙箱事件（遥测）─────────────────────────────────────────────

export type SandboxEventType =
  | 'spawn'      // worker 进程启动
  | 'exit'       // worker 正常退出
  | 'killed'     // 超时/abort/限额触发强杀（detail 含原因）
  | 'violation'  // 越界尝试（路径/网络/env 被拦截）
  | 'degraded'   // 策略降级（os → subprocess → inprocess）
  | 'limit';     // 资源限额触发（未致死的软限制）

export interface SandboxEvent {
  type: SandboxEventType;
  toolName: string;
  toolCallId: string;
  strategy: SandboxStrategy;
  detail?: Record<string, unknown>;
}

// ─── RuntimeOptions.sandbox 配置 ─────────────────────────────────

export interface SandboxOptions {
  /** 沙箱 provider。缺省 = createDefaultSandboxProvider（M2 提供，内置 Tier 0/1） */
  provider?: SandboxProvider;
  /** 全局默认覆盖：与工具声明的 spec 合并，仅收紧不放宽（见 mergeSpec） */
  defaults?: Partial<SandboxSpec>;
  /** 严格模式：true 时声明 os/microvm 的工具在能力不足时拒绝执行（不降级） */
  enforced?: boolean;
  /**
   * worker 进程加载的工具模块路径（Tier 1 subprocess 用，M2 接线）。
   * 缺省自动收集内置工具模块；声明了 sandbox 的闭包工具无法跨进程解析，
   * worker 内按名找不到时返回 error 结果 + degraded 事件。
   */
  toolModules?: string[];
}

// ─── 路径词法匹配 ─────────────────────────────────────────────────

const IS_WIN = process.platform === 'win32';

/** 词法归一（匹配用）：统一分隔符 / 去尾分隔符；win32 大小写不敏感 */
function normalizeForMatch(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (s === '') s = '/';
  if (IS_WIN) s = s.toLowerCase();
  return s;
}

/**
 * child 是否落在 parent 前缀内（含相等）。词法匹配，不做 IO：
 * `..`、symlink、8.3 短名的消解是 provider 侧（M2 facade）的职责，
 * 调用方应传入 resolve/realpath 之后的路径。
 * win32 大小写不敏感；其余平台大小写敏感。
 */
export function isPathWithin(child: string, parent: string): boolean {
  const c = normalizeForMatch(child);
  const p = normalizeForMatch(parent);
  if (p === '/') return c.startsWith('/');
  return c === p || c.startsWith(p + '/');
}

function isPathWithinAny(child: string, parents: readonly string[]): boolean {
  return parents.some(parent => isPathWithin(child, parent));
}

// ─── 工具声明解析 ─────────────────────────────────────────────────

/**
 * 解析 Tool.sandbox 声明为 Partial<SandboxSpec>：
 * - undefined → {}（不进入隔离链路的判定由调用方 ToolExecutor 负责）
 * - 工厂 → 以 (args, { workspace }) 调用，返回值 null/undefined 防御性视作 {}
 * - 静态 Partial → 原样返回
 */
export function resolveToolSandbox(
  declaration: ToolSandboxDeclaration | undefined,
  args: unknown,
  workspace?: string,
): Partial<SandboxSpec> {
  if (declaration === undefined) return {};
  if (typeof declaration === 'function') {
    const spec = declaration(args, { workspace });
    return spec ?? {};
  }
  return declaration;
}

// ─── spec 合并（收紧语义）────────────────────────────────────────

/** 隔离强度序（数值越大隔离越强） */
const STRATEGY_STRENGTH: Record<SandboxStrategy, number> = {
  inprocess: 0,
  subprocess: 1,
  os: 2,
  microvm: 3,
};

/** 网络严格度序（数值越小越严：deny < proxy < allow） */
const NET_MODE_STRICTNESS: Record<SandboxNetMode, number> = {
  deny: 0,
  proxy: 1,
  allow: 2,
};

function mergeStrategy(
  a: SandboxStrategy | undefined,
  b: SandboxStrategy | undefined,
): SandboxStrategy | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  // 取隔离强度更高者：运行时基线不可被工具声明降级
  return STRATEGY_STRENGTH[a] >= STRATEGY_STRENGTH[b] ? a : b;
}

function mergeNetMode(
  a: SandboxNetMode | undefined,
  b: SandboxNetMode | undefined,
): SandboxNetMode | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  // 取更严值
  return NET_MODE_STRICTNESS[a] <= NET_MODE_STRICTNESS[b] ? a : b;
}

/**
 * fs 前缀交集：保留 toolPaths 中落在 allowed 前缀内的路径。
 * tool 侧声明是"工具需要什么"，defaults 侧是"运行时允许什么"，
 * 合并结果 = 需要 ∩ 允许（运行时只能收紧，不放宽）。
 */
function intersectPaths(
  toolPaths: readonly string[],
  allowed: readonly string[] | undefined,
): string[] {
  if (allowed === undefined) return [...toolPaths];
  return toolPaths.filter(p => isPathWithinAny(p, allowed));
}

/** deny 前缀并集（更严 = 更多拒绝），按归一形式去重、保留首次拼写 */
function unionDeny(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of [...(a ?? []), ...(b ?? [])]) {
    const key = normalizeForMatch(p);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}

/** proxy hosts 交集（大小写不敏感，保留 tool 侧拼写） */
function intersectHosts(
  toolHosts: readonly string[] | undefined,
  allowedHosts: readonly string[] | undefined,
): string[] | undefined {
  if (toolHosts === undefined) return allowedHosts === undefined ? undefined : [...allowedHosts];
  if (allowedHosts === undefined) return [...toolHosts];
  const allowed = new Set(allowedHosts.map(h => h.toLowerCase()));
  return toolHosts.filter(h => allowed.has(h.toLowerCase()));
}

/** 数值上限合并：双方都定义取 min（更严），单方取单方，都缺省 undefined */
function mergeMin(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * 合并运行时 defaults 与工具声明（已 resolveToolSandbox 解析）为完备 SandboxSpec。
 *
 * 收紧语义（运行时只能比工具声明更严，不能更宽）：
 * - strategy：取隔离强度更高者；双方都缺省回填 'subprocess'（跨平台基线）；
 * - fs.readable/writable：工具侧缺省回填 [workspace]（无 workspace → []），
 *   defaults 定义时取交集（丢弃工具侧越界路径）；
 * - fs.deny：并集（更严）；
 * - net.mode：取更严值（deny < proxy < allow）；双方都缺省回填 'deny'（deny-by-default）；
 * - net.hosts：双方都定义取大小写不敏感交集；单方取单方；
 * - env：{ ...defaults, ...tool }（工具逐键覆盖 —— 非收紧字段；
 *   框架保留变量由 provider 层强制，spec.env 不可覆盖）；
 * - resources：逐字段取双方都定义时的 min（更严），单方取单方。
 */
export function mergeSpec(
  defaults: Readonly<Partial<SandboxSpec>> | undefined,
  tool: Readonly<Partial<SandboxSpec>> | undefined,
  workspace?: string,
): SandboxSpec {
  const d = defaults ?? {};
  const t = tool ?? {};

  const strategy = mergeStrategy(d.strategy, t.strategy) ?? 'subprocess';

  // fs：工具侧缺省回填 workspace 根；defaults 侧存在则交集收紧
  const wsRoot = workspace !== undefined ? [workspace] : [];
  const readable = intersectPaths(t.fs?.readable ?? wsRoot, d.fs?.readable);
  const writable = intersectPaths(t.fs?.writable ?? wsRoot, d.fs?.writable);
  const deny = unionDeny(t.fs?.deny, d.fs?.deny);

  // net：更严值；hosts 交集
  const netMode = mergeNetMode(d.net?.mode, t.net?.mode) ?? 'deny';
  const hosts = intersectHosts(t.net?.hosts, d.net?.hosts);

  // env：非收紧字段，工具逐键覆盖
  const env: Record<string, string> = { ...d.env, ...t.env };

  // resources：逐字段 min，仅保留有值字段（避免显式 undefined 键）
  const dr = d.resources ?? {};
  const tr = t.resources ?? {};
  const resources: SandboxResourceSpec = {};
  for (const key of [
    'wallClockMs', 'cpuMs', 'memoryMb', 'processes', 'outputBytes', 'diskWriteBytes',
  ] as const) {
    const v = mergeMin(dr[key], tr[key]);
    if (v !== undefined) resources[key] = v;
  }

  return {
    strategy,
    fs: {
      readable,
      writable,
      ...(deny.length > 0 ? { deny } : {}),
    },
    net: {
      mode: netMode,
      ...(hosts !== undefined ? { hosts } : {}),
    },
    env,
    resources,
  };
}
