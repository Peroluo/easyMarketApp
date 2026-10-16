/**
 * runtime/sandbox/audit-win - Windows 进程树资源审计（M5）
 *
 * 评估结论（Windows Job Object 原生配额未采纳，理由见 SANDBOX_PLAN §10-M5）：
 * Job Object 需要 Win32 API（CreateJobObject / SetInformationJobObject），
 * Node 生态无维护良好的零依赖封装；手写 N-API 或 koffi-FFI 引入原生依赖，
 * 违背零依赖原则（R4）且 x64/arm64 prebuilds 发布链复杂度不成比例。
 *
 * 顶替方案：**进程树事后审计**（非硬配额，如实声明语义差距）——
 * 周期（1s）经 PowerShell CIM 查询全进程表，宿主内自 worker pid 沿
 * ParentProcessId 建 BFS 树，聚合进程数与 WorkingSetSize：
 * - processes 超限（fork 炸弹形态）→ kill('process-limit')
 * - memoryMb 超限 → kill('memory-limit')
 * 强杀复用既有 taskkill /T 进程树基建。采样失败静默跳过（审计不成为故障源）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SandboxResourceSpec } from '../../core/sandbox';
import type { ResourceAudit } from './subprocess';

const execFileAsync = promisify(execFile);

/** 采样间隔：PowerShell 冷启动 ~300ms，1s 周期开销可接受（仅限额声明时启用） */
const AUDIT_INTERVAL_MS = 1000;

/** kill 原因常量（killed 事件 detail.reason） */
export const PROCESS_LIMIT_REASON = 'process-limit';
export const MEMORY_LIMIT_REASON = 'memory-limit';

/** CSV 行解析（处理 PowerShell ConvertTo-Csv 的双引号转义 ""） */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * 自 root 起 BFS 建树聚合。rows: {pid, ppid, workingSetBytes?}（pid/ppid
 * 无效行自动跳过）。pid 复用竞态下的错误挂接属审计近似误差，可接受。
 */
export function aggregateTree(
  rootPid: number,
  rows: ReadonlyArray<{ pid: number; ppid: number; workingSetBytes?: number }>,
): { processes: number; memoryBytes: number } {
  const childrenOf = new Map<number, number[]>();
  for (const r of rows) {
    const list = childrenOf.get(r.ppid) ?? [];
    list.push(r.pid);
    childrenOf.set(r.ppid, list);
  }
  const workingSet = new Map<number, number>();
  for (const r of rows) {
    if (r.workingSetBytes !== undefined) workingSet.set(r.pid, r.workingSetBytes);
  }
  let processes = 0;
  let memoryBytes = 0;
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    processes++;
    memoryBytes += workingSet.get(pid) ?? 0;
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child)) continue; // 环防御（pid 复用竞态）
      seen.add(child);
      queue.push(child);
    }
  }
  return { processes, memoryBytes };
}

/** 阈值判定（纯函数）：processes 优先（fork 炸弹比内存超限更紧急） */
export function checkResourceLimits(
  s: { processes: number; memoryBytes: number },
  resources: SandboxResourceSpec,
): string | undefined {
  if (resources.processes !== undefined && s.processes > resources.processes) {
    return PROCESS_LIMIT_REASON;
  }
  if (resources.memoryMb !== undefined && s.memoryBytes > resources.memoryMb * 1024 * 1024) {
    return MEMORY_LIMIT_REASON;
  }
  return undefined;
}

/**
 * 创建 Windows 进程树审计（注入 runProtocolSession 的 ResourceAudit）。
 * root 已不存在时 sample 返回 undefined（正常退出路径），不误杀。
 * single-flight：上一轮采样未完成时跳过本轮（interval 1s < 采样耗时时会
 * 堆积多个 PowerShell 进程，高负载下雪崩），采样超时返回 undefined 跳过。
 */
export function createWindowsProcessAudit(
  rootPid: number,
  resources: SandboxResourceSpec,
): ResourceAudit {
  const needsMemory = resources.memoryMb !== undefined;
  const psCommand =
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId' +
    (needsMemory ? ',WorkingSetSize' : '') +
    ' | ConvertTo-Csv -NoTypeInformation';

  let sampling = false;
  return {
    intervalMs: AUDIT_INTERVAL_MS,
    async sample() {
      if (sampling) return undefined; // single-flight：防 PowerShell 进程堆积
      sampling = true;
      try {
        return await sampleOnce();
      } finally {
        sampling = false;
      }
    },
    check: s => checkResourceLimits(s, resources),
  };

  async function sampleOnce(): Promise<{ processes: number; memoryBytes: number } | undefined> {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCommand],
      { windowsHide: true, timeout: 8000 },
    );
    const lines = stdout.split(/\r?\n/).filter(l => l.includes(','));
    if (lines.length < 2) return undefined; // 无进程表数据
    const header = parseCsvLine(lines[0]);
    const iPid = header.indexOf('ProcessId');
    const iPpid = header.indexOf('ParentProcessId');
    const iWs = header.indexOf('WorkingSetSize');
    if (iPid < 0 || iPpid < 0) return undefined;
    const rows: { pid: number; ppid: number; workingSetBytes?: number }[] = [];
    for (const line of lines.slice(1)) {
      const cols = parseCsvLine(line);
      const pid = Number.parseInt(cols[iPid] ?? '', 10);
      const ppid = Number.parseInt(cols[iPpid] ?? '', 10);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      const ws = iWs >= 0 ? Number.parseInt(cols[iWs] ?? '', 10) : undefined;
      rows.push({ pid, ppid, workingSetBytes: Number.isFinite(ws as number) ? ws : 0 });
    }
    // root 已不在进程表（正常退出竞态）→ 本轮无数据，不误杀
    if (!rows.some(r => r.pid === rootPid)) return undefined;
    return aggregateTree(rootPid, rows);
  }
}
