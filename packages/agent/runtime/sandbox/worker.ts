/**
 * sandbox worker 进程入口（Tier 1 subprocess provider 的执行端）。
 *
 * 以 `node <pkg-dist>/sandbox/worker.js` 独立进程启动（宿主绝不内联脚本），
 * 环境变量由宿主白名单构造（不继承宿主 env）。
 *
 * 隔离语义（Tier 1，如实声明，防误判安全强度）：
 * - fs 约束是**软约束**（本进程内 facade 拦截），非安全边界——
 *   工具经 child_process 派生的进程不经本 facade，硬边界由 Tier 2（OS 沙箱）提供；
 * - 网络无拦截（Tier 1；net 强约束是 Tier 2 --unshare-net 的职责）；
 * - abort 语义 = 宿主强杀本进程（非软信号传播）。
 *
 * 协议见 ./protocol.ts。工具不得直接写 stdout（NDJSON 协议通道）：
 * console.log 等写入被转发到 stderr 诊断通道。
 */

import * as nodeFs from 'node:fs';
import { register } from 'node:module';
import * as nodePath from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPathWithin } from '../../core/sandbox';
import type { SandboxSpec, SandboxEvent, SandboxEventType } from '../../core/sandbox';
import { SANDBOX_GLOBAL_KEY } from '../../core/sandbox';
import type { SandboxGlobalApi } from '../../core/sandbox';
import type { Tool, ToolResult } from '../../core/types';
import { createTextContent } from '../../core/types';
import {
  HEARTBEAT_INTERVAL_MS,
  type ExecMessage,
  type InitMessage,
  type SecretMessage,
  type WorkerMessage,
} from './protocol';

// ─── fs ESM 拦截 hook 注册（顶层，先于工具模块加载）────────────────
// 本文件自身的静态 import（上方 nodeFs 等）在模块实例化时解析，先于本
// 语句执行 → worker 自身的 fs 绑定保持原生（facade 校验依赖真 realpathSync）。
// 工具模块在 main() 中动态 import（晚于此处）→ 其 named fs import 被重定向
// 到 fs-hook 生成的 facade（快照 patched 函数），补齐 CJS patch 覆盖不到的
// ESM named import 形态。
try {
  // 产物形态 ./fs-hook.js（dist/sandbox/）；源码形态 ./fs-hook.ts（tsx 转译）
  const hookJs = new URL('./fs-hook.js', import.meta.url);
  const hookTs = new URL('./fs-hook.ts', import.meta.url);
  if (nodeFs.existsSync(hookJs)) register(hookJs);
  else if (nodeFs.existsSync(hookTs)) register(hookTs);
  // 两者皆缺（异常构建）→ 静默降级：CJS/default 形态 patch 仍生效
} catch {
  // module.register 不可用（Node < 20.6）→ 静默降级，同上
}

// ─── stdout 协议通道保护 ────────────────────────────────────────────
// 必须最先执行：协议消息只经 rawStdoutWrite 发送；工具的任何 stdout 写入
// （含 console.log，console 绑定 process.stdout.write）全部转发 stderr，
// 防止污染 NDJSON 协议流。
type RawWrite = typeof process.stdout.write;
const rawStdoutWrite: RawWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk: Uint8Array | string, ...rest: unknown[]) {
  const forwarded =
    typeof chunk === 'string' ? `[worker-stdout] ${chunk}` : (chunk as Uint8Array);
  const cb = rest.find(r => typeof r === 'function') as
    | ((err?: Error | null) => void)
    | undefined;
  process.stderr.write(forwarded, cb);
  return true;
} as unknown as RawWrite;

/** 协议消息发送（每行一条 JSON） */
function send(msg: WorkerMessage): void {
  rawStdoutWrite(JSON.stringify(msg) + '\n');
}

function errorResult(message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: [createTextContent(message)], details: { error: message, ...extra } };
}

/** flush 机会后退出：工具可能留下未清理 handle 阻止自然退出，定时器兜底强退 */
function exitAfter(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 100).unref();
}

// ─── fs facade（Tier 1 软约束，⚠️ 非安全边界）───────────────────────
// node:fs 是 CJS 模块：ESM namespace 的 named export 是指向 exports 对象
// 属性的 live getter，patch exports 对象（nodeFs.default）后，本进程内后续
// 动态 import 的工具模块立即生效。realpath* 不在 patch 面（facade 自身消解用）。

class SandboxFsViolation extends Error {
  constructor(
    readonly violationPath: string,
    readonly mode: 'read' | 'write',
  ) {
    super(`sandbox fs violation: ${mode} denied outside spec.fs: ${violationPath}`);
    this.name = 'SandboxFsViolation';
  }
}

type FsMode = 'read' | 'write';
/** patch 规则：read/write 单路径；read,write 双路径（src,dst）；flag 按 open flag 判定；symlink 第二参数为写入目标 */
type PathSpec = FsMode | 'read,write' | 'flag' | 'symlink' | 'mkdtemp';

const FS_PATCHES: Record<string, PathSpec> = {
  // 读
  access: 'read', accessSync: 'read', existsSync: 'read',
  lstat: 'read', lstatSync: 'read', readdir: 'read', readdirSync: 'read',
  readFile: 'read', readFileSync: 'read', readlink: 'read', readlinkSync: 'read',
  stat: 'read', statSync: 'read', createReadStream: 'read', watch: 'read', watchFile: 'read',
  // 写
  appendFile: 'write', appendFileSync: 'write', chmod: 'write', chmodSync: 'write',
  chown: 'write', chownSync: 'write', createWriteStream: 'write',
  mkdir: 'write', mkdirSync: 'write', rm: 'write', rmSync: 'write',
  rmdir: 'write', rmdirSync: 'write', truncate: 'write', truncateSync: 'write',
  unlink: 'write', unlinkSync: 'write', utimes: 'write', utimesSync: 'write',
  writeFile: 'write', writeFileSync: 'write',
  mkdtemp: 'mkdtemp', mkdtempSync: 'mkdtemp',
  // 双路径：第一参数须可读，第二参数须可写
  copyFile: 'read,write', copyFileSync: 'read,write',
  rename: 'read,write', renameSync: 'read,write',
  link: 'read,write', linkSync: 'read,write',
  // symlink(target, path)：path（第二参数）须可写；target 可为不存在的虚拟目标，不校验
  symlink: 'symlink', symlinkSync: 'symlink',
  // open(path, flag)：按 flag 判定（'r' 无 '+' 为读，其余视为写）
  open: 'flag', openSync: 'flag',
};

/** 路径消解：resolve 词法归一后尽力 realpath（消解 symlink / 8.3 短名 / ..），
 *  尚不存在的路径退回词法结果（创建类操作的目标路径常不存在） */
function resolveForCheck(p: unknown): string {
  let raw: string;
  if (p instanceof URL) raw = fileURLToPath(p);
  else raw = String(p);
  const resolved = nodePath.resolve(raw);
  try {
    return nodeFs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function checkPath(p: unknown, mode: FsMode, spec: SandboxSpec): void {
  if (p === null || p === undefined) return; // fd 形态重载（fstat 等）无法回溯路径，不拦
  const real = resolveForCheck(p);
  const deny = spec.fs.deny ?? [];
  if (deny.some(d => isPathWithin(real, d))) {
    throw new SandboxFsViolation(real, mode);
  }
  // 读语义放宽半档：可写前缀隐含可读（写者需读回），其余按白名单匹配
  const allowed =
    mode === 'write' ? spec.fs.writable : [...spec.fs.readable, ...spec.fs.writable];
  if (!allowed.some(a => isPathWithin(real, a))) {
    throw new SandboxFsViolation(real, mode);
  }
}

function flagMode(flag: unknown): FsMode {
  const f = typeof flag === 'string' ? flag : 'r';
  // 'r' 纯读；'r+'/'w*'/'a*' 均可写
  return f === 'r' || (f.startsWith('r') && !f.includes('+')) ? 'read' : 'write';
}

/**
 * 安装 fs facade。必须在 import 工具模块之前调用。
 * fd 形态 API（fstat/ftruncate/read/write 等）不拦截：fd 无法回溯路径。
 */
function installFsFacade(
  spec: SandboxSpec,
  onViolation: (v: SandboxFsViolation) => void,
): void {
  // CJS exports 对象（与 ESM default import / named live getter 同源，patch 即全量生效）
  const fsExports = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;
  const wrap = (target: Record<string, unknown>, name: string, ps: PathSpec): void => {
    const orig = target[name];
    if (typeof orig !== 'function') return;
    target[name] = function (this: unknown, first: unknown, second: unknown, ...rest: unknown[]) {
      try {
        if (ps === 'read') checkPath(first, 'read', spec);
        else if (ps === 'write' || ps === 'mkdtemp') checkPath(first, 'write', spec);
        else if (ps === 'read,write') { checkPath(first, 'read', spec); checkPath(second, 'write', spec); }
        else if (ps === 'symlink') checkPath(second, 'write', spec);
        else if (ps === 'flag') checkPath(first, flagMode(second), spec);
      } catch (err) {
        if (err instanceof SandboxFsViolation) onViolation(err);
        throw err;
      }
      return (orig as (...args: unknown[]) => unknown).apply(this, [first, second, ...rest]);
    };
  };
  for (const [name, ps] of Object.entries(FS_PATCHES)) {
    wrap(fsExports, name, ps);
    const promises = fsExports['promises'] as Record<string, unknown> | undefined;
    if (promises && typeof promises[name] === 'function') wrap(promises, name, ps);
  }
}

// ─── secrets broker client（M6）──────────────────────────────────────
// 沙箱环境内永远不存在全量凭证：工具经 globalThis[SANDBOX_GLOBAL_KEY]
// .requestSecret(name) 按需请求，宿主按 spec.secrets 白名单裁决后单条
// 发放（stdin 回 SecretMessage）；发放值同时注入自身 process.env[name]，
// 不改造的工具请求后即可直接读 env。未声明名 → 宿主拒绝 + violation。

/** worker 等待宿主凭证响应的防御性超时（正常毫秒级；防宿主 bug 挂死执行） */
const SECRET_TIMEOUT_MS = 10_000;

const pendingSecrets = new Map<
  string,
  { resolve: (v: string) => void; reject: (e: Error) => void }
>();
let secretSeq = 0;

/** 宿主 SecretMessage 响应分发（消费循环调用） */
function handleSecretResponse(msg: SecretMessage): void {
  const p = pendingSecrets.get(msg.id);
  if (p === undefined) return; // 未知/已超时 id：忽略
  pendingSecrets.delete(msg.id);
  if (msg.error !== undefined) {
    p.reject(new Error(msg.error));
  } else if (msg.value !== undefined) {
    process.env[msg.name] = msg.value; // 单条发放 → 注入自身 env（§7.4）
    p.resolve(msg.value);
  } else {
    p.reject(new Error(`secret broker: malformed response for "${msg.name}"`));
  }
}

/** 挂载工具侧 API（init 后、loadTools 前：工具模块顶层即可用） */
function installSecretsApi(): void {
  const api: SandboxGlobalApi = {
    requestSecret(name: string): Promise<string> {
      const id = `sec_${++secretSeq}`;
      return new Promise<string>((resolve, reject) => {
        pendingSecrets.set(id, { resolve, reject });
        setTimeout(() => {
          const p = pendingSecrets.get(id);
          if (p === undefined) return;
          pendingSecrets.delete(id);
          p.reject(new Error(`request-secret timeout: "${name}" (host unresponsive?)`));
        }, SECRET_TIMEOUT_MS).unref();
        send({ op: 'request-secret', id, name });
      });
    },
  };
  (globalThis as Record<string, unknown>)[SANDBOX_GLOBAL_KEY] = api;
}

// ─── 工具注册表重建 ─────────────────────────────────────────────────

function isToolLike(v: unknown): v is Tool {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as Tool).name === 'string' &&
    typeof (v as Tool).execute === 'function'
  );
}

/**
 * 按 toolModules 重建工具注册表：闭包式工具无法跨进程传递（关键可行性约束），
 * worker 按名字加载同一注册表。收集形态：
 * - default 导出：单个 Tool / Tool 数组 / { name -> Tool } 映射对象；
 * - 命名导出中的 Tool 形态对象。
 * 模块加载失败不致命：收集错误后回 ready（发 degraded 事件），仅该模块工具不可用。
 */
async function loadTools(
  toolModules: string[],
): Promise<{ tools: Map<string, Tool>; errors: Record<string, string> }> {
  const tools = new Map<string, Tool>();
  const errors: Record<string, string> = {};
  for (const m of toolModules) {
    try {
      const href = m.startsWith('file://') ? m : pathToFileURL(nodePath.resolve(m)).href;
      const mod = (await import(href)) as Record<string, unknown>;
      const candidates: unknown[] = [];
      const def = mod['default'];
      if (isToolLike(def)) candidates.push(def);
      else if (Array.isArray(def)) candidates.push(...def);
      else if (def && typeof def === 'object') candidates.push(...Object.values(def));
      for (const v of Object.values(mod)) {
        if (v !== def) candidates.push(v);
      }
      let count = 0;
      for (const c of candidates) {
        if (isToolLike(c)) {
          tools.set(c.name, c);
          count++;
        }
      }
      if (count === 0) errors[m] = 'no tool-like exports found';
    } catch (err) {
      errors[m] = (err as Error)?.message ?? String(err);
    }
  }
  return { tools, errors };
}

// ─── 主流程 ─────────────────────────────────────────────────────────

/** 当前执行上下文（exec 前的事件归属 worker 自身） */
let execCtx: { toolName: string; toolCallId: string } = {
  toolName: '(worker)',
  toolCallId: '-',
};
/** 事件归属策略：init.spec.strategy（Tier 1 = 'subprocess'，Tier 2 = 'os'） */
let strategy: SandboxSpec['strategy'] = 'subprocess';

function sendEvent(type: SandboxEventType, detail?: Record<string, unknown>): void {
  const event: SandboxEvent = {
    type,
    toolName: execCtx.toolName,
    toolCallId: execCtx.toolCallId,
    strategy,
    ...(detail !== undefined ? { detail } : {}),
  };
  send({ op: 'event', event });
}

async function main(): Promise<void> {
  // 心跳立即启动：覆盖 init 等待、toolModules 加载、工具执行全程
  const heartbeat = setInterval(() => send({ op: 'heartbeat' }), HEARTBEAT_INTERVAL_MS);

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();

  // ── init 握手 ──
  const first = await iterator.next();
  if (first.done) throw new Error('worker stdin closed before init');
  const init = JSON.parse(first.value as string) as InitMessage;
  if (init.op !== 'init') throw new Error(`expected init, got "${String(init.op)}"`);
  strategy = init.spec.strategy;

  // ── fs facade 先于工具模块加载安装（覆盖模块顶层 fs 调用），
  //    secrets API 同理先挂载（工具模块顶层即可请求），
  //    再重建注册表（闭包工具无法跨进程，按 toolModules 按名重建）──
  installFsFacade(init.spec, v =>
    sendEvent('violation', { op: v.mode, path: v.violationPath }),
  );
  installSecretsApi();
  const { tools, errors } = await loadTools(init.toolModules);

  if (Object.keys(errors).length > 0) {
    sendEvent('degraded', { reason: 'tool-module-load', modules: errors });
  }
  send({ op: 'ready' });

  // ── exec 单请求 ──
  const second = await iterator.next();
  if (second.done) throw new Error('worker stdin closed before exec');
  const exec = JSON.parse(second.value as string) as ExecMessage;
  if (exec.op !== 'exec') throw new Error(`expected exec, got "${String(exec.op)}"`);
  execCtx = { toolName: exec.toolName, toolCallId: exec.toolCallId };

  // ── broker 响应消费循环（M6）：exec 期间宿主回发的 SecretMessage 在此分发。
  //    主流程已不再读 stdin；result 后 lines.close() 使循环随 done 退出 ──
  const consumeBroker = (async (): Promise<void> => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      try {
        const msg = JSON.parse(next.value as string) as SecretMessage;
        if (msg !== null && typeof msg === 'object' && msg.op === 'secret') {
          handleSecretResponse(msg);
        }
      } catch {
        // 畸形行（协议容错）：忽略
      }
    }
  })();
  void consumeBroker; // 不 await：与工具执行并发，异常面由 unhandledRejection 兜底

  const tool = tools.get(exec.toolName);
  if (tool === undefined) {
    // 闭包/未注册工具：跨进程无法解析（degraded 路径，非静默失败）
    sendEvent('degraded', {
      reason: 'tool-not-resolvable',
      toolName: exec.toolName,
      hint: 'tools declared with sandbox must be registered from named modules (RuntimeOptions.sandbox.toolModules)',
    });
    send({
      op: 'result',
      toolResult: errorResult(
        `Tool "${exec.toolName}" is not available in the sandbox worker: ` +
        `it is not exported by any configured toolModule. Closure-based tools cannot ` +
        `be executed in a sandbox; register the tool from a named module and list ` +
        `that module in RuntimeOptions.sandbox.toolModules.`,
      ),
    });
  } else {
    let result: ToolResult;
    try {
      // abort 语义 = 宿主杀本进程；worker 内不传播软信号
      result = await tool.execute(exec.toolCallId, exec.args, undefined);
    } catch (err) {
      result = errorResult(
        `sandboxed tool "${exec.toolName}" threw: ${(err as Error)?.message ?? String(err)}`,
      );
    }
    send({ op: 'result', toolResult: result });
  }

  clearInterval(heartbeat);
  lines.close(); // 关闭 stdin 读取，事件循环可自然退出（定时器兜底仍在）
  exitAfter(0);
}

// 兜底：任何未捕获异常快速失败（显式 error 优于让宿主等心跳超时）
process.on('uncaughtException', err => {
  send({ op: 'error', message: (err as Error)?.message ?? String(err), code: 'uncaught' });
  exitAfter(1);
});
process.on('unhandledRejection', err => {
  send({ op: 'error', message: String(err), code: 'unhandled-rejection' });
  exitAfter(1);
});

main().catch(err => {
  send({ op: 'error', message: (err as Error)?.message ?? String(err), code: 'worker-init' });
  exitAfter(1);
});
