/**
 * 内置工具：read / write / edit / bash
 *
 * 参考 pi 的 coding-agent 默认工具集。每个工具声明 permissions 能力，
 * 供框架级 PermissionPolicy 裁决（如 fs:write → confirm / pending）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from '@aipack-ai/agent';
import { TASK_TOOL_NAME } from './subagents.js';

/** 工作区根目录：文件路径解析的基准（防止越界访问任意路径） */
export const workspaceRoot = process.cwd();

/** 判断 target 是否位于 root 内部（含 root 本身） */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

let cachedRealRoot: string | undefined;

/**
 * 将用户/模型提供的路径解析到工作区内。
 * - 先按字面路径做 relative 校验（防止 ../ 逃逸与前缀绕过，如 aipack-evil）
 * - 再做 realpath 校验（防止工作区内符号链接指向外部）
 * - write 新建文件时目标尚不存在，回退校验最近存在的祖先目录
 */
export async function resolveInWorkspace(p: string): Promise<string> {
  const abs = path.resolve(workspaceRoot, p);
  if (!isInside(workspaceRoot, abs)) {
    throw new Error(`路径越界：${p}（工作区：${workspaceRoot}）`);
  }
  const realRoot = (cachedRealRoot ??= await fs.realpath(workspaceRoot));
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    let dir = path.dirname(abs);
    for (;;) {
      try {
        real = await fs.realpath(dir);
        break;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error(`路径不可达：${p}`);
        dir = parent;
      }
    }
  }
  if (!isInside(realRoot, real)) {
    throw new Error(`路径越界（符号链接）：${p} → ${real}`);
  }
  return abs;
}

function textResult(text: string, details?: unknown): ToolResult {
  return { content: [{ type: 'text', text }], details: details ?? {} };
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `错误: ${message}` }],
    details: { error: message },
  };
}

/** 单文件读取上限（字符），超出截断 */
const MAX_READ_CHARS = 100_000;

// ─── read ─────────────────────────────────────────────────────────

export const readTool: Tool = {
  name: 'read',
  description: '读取文件内容。返回文本内容，超长自动截断。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '文件路径（相对工作区）' },
      offset: { type: 'number', description: '起始行号（从 1 开始，可选）' },
      limit: { type: 'number', description: '读取行数（可选）' },
    },
    required: ['file'],
  },
  permissions: ['fs:read'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { file: string; offset?: number; limit?: number };
    try {
      const abs = await resolveInWorkspace(args.file);
      const buf = await fs.readFile(abs);
      // 二进制检测（与 grep 一致）：避免图片/编译产物把乱码灌进上下文
      if (buf.includes(0)) {
        return errorResult(`${args.file} 是二进制文件，read 工具仅支持文本（图片请用 @引用 走多模态）`);
      }
      let content = buf.toString('utf8');
      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = content.split('\n');
        const start = Math.max(0, (args.offset ?? 1) - 1);
        const end = args.limit !== undefined ? start + args.limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      // 截断标志在截断时显式置位（此前用 content.length >= 上限反推：
      // 恰好等于上限的未截断文件会被误标 truncated）
      let truncated = false;
      if (content.length > MAX_READ_CHARS) {
        content = content.slice(0, MAX_READ_CHARS) + `\n...[截断，共 ${content.length} 字符]`;
        truncated = true;
      }
      return textResult(content, { file: args.file, truncated });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── write ────────────────────────────────────────────────────────

export const writeTool: Tool = {
  name: 'write',
  description: '写入文件（创建或覆盖）。自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '文件路径（相对工作区）' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['file', 'content'],
  },
  permissions: ['fs:write'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { file: string; content: string };
    try {
      const abs = await resolveInWorkspace(args.file);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, args.content, 'utf8');
      return textResult(`已写入 ${args.file}（${args.content.length} 字符）`, { file: args.file });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── edit ─────────────────────────────────────────────────────────

export const editTool: Tool = {
  name: 'edit',
  description: '编辑文件：将 oldString 的首次出现替换为 newString。oldString 必须唯一匹配。',
  parameters: {
    type: 'object',
    properties: {
      file: { type: 'string', description: '文件路径（相对工作区）' },
      oldString: { type: 'string', description: '被替换的文本（须在文件中唯一）' },
      newString: { type: 'string', description: '替换后的文本' },
    },
    required: ['file', 'oldString', 'newString'],
  },
  permissions: ['fs:write'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { file: string; oldString: string; newString: string };
    try {
      // 空 oldString 防御：indexOf('') 恒为 0，会静默在文件头插入 newString
      if (!args.oldString) {
        return errorResult('oldString 不能为空（空串会匹配文件开头，请提供要替换的文本）');
      }
      if (args.oldString === args.newString) {
        return errorResult('newString 与 oldString 相同，无需编辑');
      }
      const abs = await resolveInWorkspace(args.file);
      const content = await fs.readFile(abs, 'utf8');
      const first = content.indexOf(args.oldString);
      if (first === -1) {
        return errorResult(`在 ${args.file} 中未找到 oldString`);
      }
      if (content.indexOf(args.oldString, first + 1) !== -1) {
        return errorResult(`oldString 在 ${args.file} 中出现多次，请提供更长的上下文使其唯一`);
      }
      const updated = content.slice(0, first) + args.newString + content.slice(first + args.oldString.length);
      await fs.writeFile(abs, updated, 'utf8');
      return textResult(`已编辑 ${args.file}`, { file: args.file });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── bash ─────────────────────────────────────────────────────────

/** stdout/stderr 捕获上限：防止超长输出撑爆内存（结果输出另有截断） */
const MAX_CAPTURE_BYTES = 1024 * 1024;

/** bash 超时边界：低于下限立即被杀（无意义），高于上限等同永不超时 */
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

/** 模型提供的 timeoutMs 钳制到合理区间（非法/缺省回退默认值） */
function clampTimeout(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(v), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * 允许透传给子进程的环境变量白名单。
 * 不再整体透传 process.env：API Key（OPENAI_API_KEY 等）会泄露给
 * 任意被执行的 shell 命令（模型诱导 `env` 即可读走密钥）。
 * 如需向命令暴露变量，用 AIPACK_ 前缀（自动透传）。
 */
const SAFE_ENV_KEYS = new Set([
  // Unix 常用
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  // 网络代理（构建/下载依赖，URL 形式无密钥）
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  // Windows 常用
  'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'COMMONPROGRAMFILES',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'HOMEDRIVE', 'HOMEPATH', 'WINDIR',
]);

function buildSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    const upper = k.toUpperCase();
    if (SAFE_ENV_KEYS.has(upper) || k.startsWith('AIPACK_')) env[k] = v;
  }
  env.AIPACK_CLI = 'true';
  return env;
}

function pickShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec ?? 'cmd.exe';
  }
  return process.env.SHELL ?? '/bin/bash';
}

function runShell(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise(resolve => {
    // detached：独立进程组，超时可连同 shell 派生的子孙进程一并终止
    const child = spawn(command, {
      shell: pickShell(),
      cwd: workspaceRoot,
      env: buildSafeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let stdoutDropped = false;
    let stderrDropped = false;
    let settled = false;

    /** 终止整个进程组（Windows 无进程组，退化为直接 kill） */
    const killTree = (): void => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // 进程组可能已退出 → 回退直接 kill
        }
      }
      child.kill('SIGKILL');
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        killTree();
        resolve({ stdout, stderr: stderr + `\n[命令超时（${timeoutMs}ms）被终止]`, code: 124 });
      }
    }, timeoutMs);

    child.stdout.on('data', d => {
      if (stdout.length >= MAX_CAPTURE_BYTES) { stdoutDropped = true; return; }
      stdout += d.toString();
    });
    child.stderr.on('data', d => {
      if (stderr.length >= MAX_CAPTURE_BYTES) { stderrDropped = true; return; }
      stderr += d.toString();
    });
    child.on('close', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (stdoutDropped) stdout += '\n[输出超过捕获上限，已截断]';
        if (stderrDropped) stderr += '\n[输出超过捕获上限，已截断]';
        resolve({ stdout, stderr, code: code ?? 0 });
      }
    });
    child.on('error', err => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: String(err), code: -1 });
      }
    });
  });
}

export const bashTool: Tool = {
  name: 'bash',
  description: '在工作区执行 shell 块命令并返回输出。适用于文件搜索、构建、测试等操作。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeoutMs: { type: 'number', description: '超时毫秒数（默认 60000，钳制到 1000-600000）' },
    },
    required: ['command'],
  },
  permissions: ['shell:exec'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { command: string; timeoutMs?: number };
    // 钳制超时：模型可能传 0/负数（命令刚启动就被杀）或 Infinity（永不超时）
    const timeout = clampTimeout(args.timeoutMs);
    try {
      const { stdout, stderr, code } = await runShell(args.command, timeout);
      const parts: string[] = [];
      if (stdout.trim()) parts.push(`[stdout]\n${stdout.slice(0, MAX_READ_CHARS)}`);
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.slice(0, MAX_READ_CHARS)}`);
      parts.push(`[退出码 ${code}]`);
      return textResult(parts.join('\n'), { command: args.command, code });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── 文件检索辅助 ─────────────────────────────────────────────────

/** 遍历时剪枝的目录（依赖产物与版本控制元数据） */
const PRUNED_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage']);

/** 单文件读取上限（grep 用，跳过超大文件） */
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

/** glob → RegExp：支持 **（跨目录）、*（单段）、?（单字符） */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++; // "**/" 吞掉分隔符
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** 递归遍历目录，返回相对搜索根的 posix 路径（剪枝 PRUNED_DIRS） */
async function walkFiles(root: string, maxEntries: number): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [''];
  // 索引推进代替 shift()：shift 为 O(n) 出队，大目录遍历退化为 O(n²)
  for (let qi = 0; qi < queue.length && out.length < maxEntries; qi++) {
    const rel = queue[qi];
    const abs = path.join(root, rel);
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue; // 无权限等 → 跳过
    }
    for (const e of entries) {
      if (out.length >= maxEntries) break;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!PRUNED_DIRS.has(e.name)) queue.push(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  return out;
}

// ─── find ─────────────────────────────────────────────────────────

export const findTool: Tool = {
  name: 'find',
  description: '按 glob 模式查找文件。支持 ** 跨目录匹配。示例: "**/*.ts"、"src/**/*.spec.ts"',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 "*.md" 或 "**/*.ts"' },
      path: { type: 'string', description: '搜索目录（相对工作区，默认 .）' },
      limit: { type: 'number', description: '最大结果数（默认 1000）' },
    },
    required: ['pattern'],
  },
  permissions: ['fs:read'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { pattern: string; path?: string; limit?: number };
    const limit = args.limit ?? 1000;
    try {
      const root = await resolveInWorkspace(args.path ?? '.');
      const re = globToRegExp(args.pattern);
      // 遍历上限与结果上限解耦：遍历足够多文件后再过滤，避免低匹配率时提前截断
      const files = await walkFiles(root, Math.max(limit * 10, 10_000));
      const matches = files.filter(f => re.test(f));
      const limited = matches.slice(0, limit);
      if (limited.length === 0) {
        return textResult(`未找到匹配 "${args.pattern}" 的文件`, { pattern: args.pattern });
      }
      const suffix = matches.length > limited.length ? `\n...[共 ${matches.length} 个，已截断至 ${limit}]` : '';
      return textResult(`${limited.join('\n')}${suffix}`, {
        pattern: args.pattern,
        count: matches.length,
        truncated: matches.length > limited.length,
      });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── grep ─────────────────────────────────────────────────────────

export const grepTool: Tool = {
  name: 'grep',
  description: '在文件内容中搜索模式（默认正则）。自动跳过二进制/超大文件与 node_modules。输出 file:line: text',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则，或配合 literal 使用字面量）' },
      path: { type: 'string', description: '搜索的目录或文件（相对工作区，默认 .）' },
      glob: { type: 'string', description: '文件名过滤 glob，如 "*.ts"' },
      ignoreCase: { type: 'boolean', description: '忽略大小写（默认 false）' },
      literal: { type: 'boolean', description: '按字面量而非正则解释 pattern（默认 false）' },
      context: { type: 'number', description: '每个匹配前后显示的行数（默认 0）' },
      limit: { type: 'number', description: '最大匹配数（默认 100）' },
    },
    required: ['pattern'],
  },
  permissions: ['fs:read'],
  async execute(_id, rawArgs) {
    const args = rawArgs as {
      pattern: string; path?: string; glob?: string;
      ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number;
    };
    const limit = args.limit ?? 100;
    const context = args.context ?? 0;
    try {
      const target = await resolveInWorkspace(args.path ?? '.');
      const re = new RegExp(
        args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : args.pattern,
        args.ignoreCase ? 'i' : '',
      );
      const globRe = args.glob ? globToRegExp(args.glob) : undefined;

      // 确定待搜文件清单（相对工作区）
      let files: Array<{ rel: string; abs: string }>;
      const stat = await fs.stat(target);
      if (stat.isFile()) {
        files = [{ rel: path.relative(workspaceRoot, target), abs: target }];
      } else if (stat.isDirectory()) {
        files = (await walkFiles(target, 20_000))
          .filter(f => !globRe || globRe.test(f) || globRe.test(f.split('/').pop()!))
          .map(f => ({ rel: f, abs: path.join(target, f) }));
      } else {
        return errorResult(`不是文件或目录: ${args.path}`);
      }

      const out: string[] = [];
      let matchCount = 0;
      let truncated = false;

      for (const file of files) {
        if (matchCount >= limit) { truncated = true; break; }
        let buf: Buffer;
        try {
          const st = await fs.stat(file.abs);
          if (st.size > MAX_GREP_FILE_BYTES) continue;
          buf = await fs.readFile(file.abs);
        } catch {
          continue;
        }
        if (buf.includes(0)) continue; // 二进制文件
        const lines = buf.toString('utf8').split('\n');

        // 收集本文件匹配行号（Set：marker 判定 O(1)，避免 includes 的 O(n²)）
        const hitLines = new Set<number>();
        for (let i = 0; i < lines.length && matchCount + hitLines.size < limit; i++) {
          if (re.test(lines[i])) hitLines.add(i);
        }
        if (hitLines.size === 0) continue;
        matchCount += hitLines.size;

        // 带去重的行号区间（context 展开）
        const show = new Set<number>();
        for (const h of hitLines) {
          for (let i = Math.max(0, h - context); i <= Math.min(lines.length - 1, h + context); i++) {
            show.add(i);
          }
        }
        for (const i of [...show].sort((a, b) => a - b)) {
          const marker = hitLines.has(i) ? '>' : ' ';
          out.push(`${file.rel}:${i + 1}:${marker} ${lines[i].slice(0, 500)}`);
        }
      }

      if (out.length === 0) {
        return textResult(`未找到匹配 "${args.pattern}" 的内容`, { pattern: args.pattern, count: 0 });
      }
      const suffix = truncated ? `\n...[已达 ${limit} 个匹配上限，截断]` : '';
      return textResult(`${out.join('\n')}${suffix}`, {
        pattern: args.pattern,
        count: matchCount,
        truncated,
      });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── ls ───────────────────────────────────────────────────────────

export const lsTool: Tool = {
  name: 'ls',
  description: '列出目录内容（目录带 / 后缀，目录在前）。探索项目结构时优先使用。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径（相对工作区，默认 .）' },
      limit: { type: 'number', description: '最大条目数（默认 500）' },
    },
  },
  permissions: ['fs:read'],
  async execute(_id, rawArgs) {
    const args = rawArgs as { path?: string; limit?: number };
    const limit = args.limit ?? 500;
    try {
      const abs = await resolveInWorkspace(args.path ?? '.');
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) {
        return textResult(path.relative(workspaceRoot, abs) || abs);
      }
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const sorted = entries
        .filter(e => e.isDirectory() || e.isFile() || e.isSymbolicLink())
        .sort((a, b) => {
          const ad = a.isDirectory() ? 0 : 1;
          const bd = b.isDirectory() ? 0 : 1;
          return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
        });
      const limited = sorted.slice(0, limit);
      if (limited.length === 0) {
        return textResult('（空目录）', {});
      }
      const lines = limited.map(e =>
        e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name}@` : e.name,
      );
      const suffix = sorted.length > limited.length ? `\n...[共 ${sorted.length} 项，已截断至 ${limit}]` : '';
      return textResult(`${lines.join('\n')}${suffix}`, {
        path: args.path ?? '.',
        count: sorted.length,
        truncated: sorted.length > limited.length,
      });
    } catch (err) {
      return errorResult(String(err instanceof Error ? err.message : err));
    }
  },
};

// ─── 工具集组装 ───────────────────────────────────────────────────

export const BUILTIN_TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool, findTool, grepTool, lsTool];

/**
 * 按白名单/黑名单过滤内置工具。
 * - tools: 仅保留白名单中的工具
 * - excludeTools: 移除黑名单中的工具
 * - noTools: 返回空数组
 * 返回选中的工具与未知工具名（白/黑名单中拼写错误静默失效会让用户误以为配置生效，
 * 黑名单拼错尤其危险——等于扩大了工具权限范围）
 * 注：task（子 agent）工具由 builder 按依赖注入，此处仅参与名称校验与过滤。
 */
export function selectTools(options: {
  tools?: string[];
  excludeTools?: string[];
  noTools?: boolean;
}): { tools: Tool[]; unknown: string[] } {
  if (options.noTools) return { tools: [], unknown: [] };
  const builtinNames = new Set([...BUILTIN_TOOLS.map(t => t.name), TASK_TOOL_NAME]);
  const unknown = new Set<string>();
  if (options.tools) {
    for (const name of options.tools) {
      if (!builtinNames.has(name)) unknown.add(name);
    }
  }
  if (options.excludeTools) {
    for (const name of options.excludeTools) {
      if (!builtinNames.has(name)) unknown.add(name);
    }
  }

  let selected = [...BUILTIN_TOOLS];
  if (options.tools && options.tools.length > 0) {
    const allow = new Set(options.tools);
    selected = selected.filter(t => allow.has(t.name));
  }
  if (options.excludeTools && options.excludeTools.length > 0) {
    const deny = new Set(options.excludeTools);
    selected = selected.filter(t => !deny.has(t.name));
  }
  return { tools: selected, unknown: [...unknown] };
}
