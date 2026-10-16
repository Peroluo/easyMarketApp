/**
 * runtime/sandbox/default - 默认沙箱 provider 工厂（Tier 0/1 路由）
 *
 * 职责：
 * - supports 能力探测：inprocess（Tier 0 由 ToolExecutor 直跑，恒可用）、
 *   subprocess（worker 入口可解析时）、os（Tier 2：Linux bwrap / macOS Seatbelt
 *   平台分派）、microvm（Tier 3 预留，恒 false）；
 * - run 按 spec.strategy 路由：
 *   - subprocess → SubprocessSandboxProvider 执行；
 *   - os → 平台 OS provider（bwrap/Seatbelt）；能力不足时降级链
 *     microvm → os → subprocess（每级降级发 degraded 事件）；
 *   - inprocess → 明确 error（进程内直跑不经 provider，由 ToolExecutor 路由，
 *     到达 provider 的 inprocess 请求 = 路由错误，显式失败优于静默降级）。
 *
 * enforced 严格模式（禁止降级）由 ToolExecutor 持有配置判定（M3 接线）：
 * provider 只发降级事件并降级执行；enforced 下的拒绝在路由层完成。
 */

import type { SandboxProvider, SandboxRunRequest } from '../../core/sandbox';
import type { ToolResult } from '../../core/types';
import { createTextContent } from '../../core/types';
import { SubprocessSandboxProvider, type SubprocessSandboxProviderOptions } from './subprocess';
import { BwrapSandboxProvider, type BwrapSandboxProviderOptions } from './bwrap';
import {
  SeatbeltSandboxProvider,
  type SeatbeltSandboxProviderOptions,
} from './seatbelt';

export interface DefaultSandboxProviderOptions
  extends SubprocessSandboxProviderOptions, BwrapSandboxProviderOptions, SeatbeltSandboxProviderOptions {}

export function createDefaultSandboxProvider(
  options: DefaultSandboxProviderOptions = {},
): SandboxProvider {
  const subprocess = new SubprocessSandboxProvider(options);
  const bwrap = new BwrapSandboxProvider(options);
  const seatbelt = new SeatbeltSandboxProvider(options);
  /** 平台 OS provider 分派：Linux → bwrap（cgroup 配额），macOS → Seatbelt */
  const osProvider: SandboxProvider = process.platform === 'darwin' ? seatbelt : bwrap;

  return {
    async supports(strategy) {
      switch (strategy) {
        case 'inprocess':
          // Tier 0 概念存在（不经沙箱直跑），可用性恒真；实际路由在 ToolExecutor
          return true;
        case 'subprocess':
          return await subprocess.supports('subprocess');
        case 'os':
          // Tier 2：Linux → bwrap（cgroup 配额），macOS → Seatbelt（平台分派）
          return await osProvider.supports('os');
        default:
          // microvm（Tier 3）：仅契约预留，本期不实现
          return false;
      }
    },

    async run(req: SandboxRunRequest): Promise<ToolResult> {
      const { spec } = req;
      if (spec.strategy === 'subprocess') {
        return subprocess.run(req);
      }
      if (spec.strategy === 'inprocess') {
        const message =
          'sandbox inprocess strategy must be routed by ToolExecutor (direct host ' +
          'execution); a sandbox provider cannot execute tools in-process';
        req.onEvent?.(makeEvent(req, 'degraded', { reason: 'inprocess-routed-to-provider' }));
        return {
          content: [createTextContent(message)],
          details: { error: message },
        };
      }
      // os / microvm：能力探测 → 降级链 microvm → os → subprocess（每级降级发 degraded 事件）
      if (spec.strategy === 'os' && (await osProvider.supports('os'))) {
        return osProvider.run(req);
      }
      // microvm 能力不足：优先降 os（OS provider 可用时），再落 subprocess
      const next: 'os' | 'subprocess' =
        spec.strategy === 'os' ? 'subprocess'
          : (await osProvider.supports('os')) ? 'os' : 'subprocess';
      req.onEvent?.(makeEvent(req, 'degraded', { from: spec.strategy, to: next }));
      if (next === 'os') {
        return osProvider.run({ ...req, spec: { ...spec, strategy: 'os' } });
      }
      return subprocess.run({ ...req, spec: { ...spec, strategy: 'subprocess' } });
    },
  };
}

function makeEvent(
  req: SandboxRunRequest,
  type: 'degraded',
  detail: Record<string, unknown>,
) {
  return {
    type,
    toolName: req.toolName,
    toolCallId: req.toolCallId,
    strategy: req.spec.strategy,
    detail,
  };
}
