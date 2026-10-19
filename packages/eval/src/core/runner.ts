/**
 * packages/eval/src/core/runner.ts - Eval Runner
 *
 * 两种模式共用同一条执行链路（Runtime → 轨迹 → 评分器）：
 *   mock —— fixture replay：createMockStreamFn 注入脚本化 LLM 响应
 *   live —— 真实 LLM：createLiveLlm 装配 provider streamFn（M3）
 *
 * 工程保障：
 *   - 用例间完全隔离（独立 runtime / 独立 fs 副本 / 独立 sessionKey）
 *   - 墙钟超时（Promise.race）
 *   - 步数上限（映射 RuntimeOptions.maxTurns）
 *   - 预算熔断（case.metadata.maxTokens + RunConfig.maxTotalTokens 全局）
 *   - repeats 消随机性：mock 1；live 默认 3 并取 pass@k（适配层不支持 seed）
 *   - 并发受控（简单队列实现）
 */

import { createRuntime, createRequest } from '@aipack-ai/agent';
import type { Model, StreamFn, Tool } from '@aipack-ai/agent';
import { createMockStreamFn } from './mock-stream';
import { createMockTools } from './mock-tools';
import { countTurns, extractTrajectory } from './trajectory';
import { resolveScorers, scoreTrace, type ScorerDeps } from './scorer';
import { createOpenAiCompatibleEmbedFn } from './embedding';
import { createJudgeDeps } from './judge-llm';
import {
  assertJudgeDistinct,
  assertLiveReady,
  describeLiveLlm,
  parseModelSpec,
  resolveJudgeLlm,
  resolveLiveLlm,
} from './live';
import type {
  CaseResult,
  EvalCase,
  EvalReport,
  RunConfig,
  RunTrace,
  ScoreResult,
  SuiteSummary,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STEPS = 50;
const DEFAULT_CONCURRENCY = 8;
/** live 模式缺省 repeats：无 seed 可用，靠多次采样消噪 */
const LIVE_DEFAULT_REPEATS = 3;

/** live 模式装配产物 */
interface RuntimeBundle {
  streamFn: StreamFn;
  model?: Model;
  /** 报告展示的模型标识 */
  label?: string;
}

/** 全局 token 预算计数器 */
interface BudgetState {
  spent: number;
}

/** sanitize sessionKey（用例 id 可能含 '/'） */
function sessionKeyFor(caseId: string, repeat: number): string {
  return `eval:${caseId.replace(/[^a-zA-Z0-9_-]/g, '_')}#r${repeat}`;
}

/** bundle.label（'provider/modelId'）→ spec；解析失败不阻断（mock / 注入 streamFn 场景） */
function parseModelSpecSafe(label: string): { provider: string; modelId: string } | undefined {
  try {
    return parseModelSpec(label);
  } catch {
    return undefined;
  }
}

/**
 * 模式不匹配 → 跳过（不计入通过率，避免出现"必然失败"的噪音）。
 * 返回 undefined 表示该用例在当前模式下可跑。
 */
export function skipReason(c: EvalCase, mode: 'mock' | 'live'): string | undefined {
  if (mode === 'mock' && c.mode === 'live') return 'live-only 用例（mock 模式跳过）';
  if (mode === 'live' && c.mode === 'mock') return 'mock-only 用例（live 模式跳过）';
  if (mode === 'live' && c.input.mock) return 'fixture replay 用例（live 模式跳过）';
  return undefined;
}

/** live 模式：装配真实 LLM（缺配置直接抛错，由 CLI 转 usage 错误） */
function resolveRuntimeBundle(config: RunConfig): RuntimeBundle | undefined {
  if (config.mode !== 'live') return undefined;
  if (config.streamFn) {
    return { streamFn: config.streamFn, model: config.frameworkModel };
  }
  const llm = resolveLiveLlm({
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    timeoutMs: config.requestTimeoutMs,
  });
  assertLiveReady(llm.spec);
  return {
    streamFn: llm.streamFn,
    model: llm.model,
    label: describeLiveLlm(llm.spec),
  };
}

/** 单用例单次运行：返回轨迹（失败时返回 error 字符串） */
async function runCaseOnce(
  c: EvalCase,
  config: RunConfig,
  repeat: number,
  bundle?: RuntimeBundle,
): Promise<{ trace?: RunTrace; error?: string }> {
  const isLive = config.mode === 'live';
  if (!isLive && !c.input.mock) {
    return { error: 'mock 模式要求 input.mock 脚本（live 模式用 --mode live）' };
  }

  const timeoutMs = c.metadata?.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSteps = c.metadata?.maxSteps ?? config.maxSteps ?? DEFAULT_MAX_STEPS;

  const tools: Tool[] = createMockTools(c.input.fs ?? {}, c.input.tools);
  const runtime = createRuntime({
    systemPrompt: c.input.systemPrompt ?? '',
    streamFn: isLive ? bundle!.streamFn : createMockStreamFn(c.input.mock!),
    ...(isLive && bundle?.model ? { model: bundle.model } : {}),
    tools,
    maxTurns: maxSteps,
    traceIdGenerator: () => sessionKeyFor(c.id, repeat),
    // eval 聚焦轨迹/输出质量而非权限语义：显式放行（运行时默认 fail-closed，
    // 未配置策略会拒绝所有工具调用，导致轨迹断言全挂）
    permissionFailOpen: true,
  });

  const sessionKey = sessionKeyFor(c.id, repeat);
  const startedAt = Date.now();

  type RunOk = {
    ok: true;
    result: Awaited<ReturnType<typeof runtime.run>>;
    messages: ReturnType<typeof runtime.getMessages>;
    trajectory: RunTrace['trajectory'];
    turns: number;
    durationMs: number;
    usageTotal: number;
  };
  type RunOutcome = RunOk | { ok: false; error: string };

  let run: Promise<RunOutcome>;

  try {
    run = runtime
      .run(createRequest(c.input.message, { sessionKey }))
      .then((result): RunOutcome => {
        const messages = runtime.getMessages(sessionKey);
        const trajectory = extractTrajectory(messages);
        const turns = countTurns(messages);
        const durationMs = Date.now() - startedAt;
        const usageTotal =
          typeof result.usage?.total === 'number' ? result.usage.total : 0;
        return {
          ok: true,
          result,
          messages,
          trajectory,
          turns,
          durationMs,
          usageTotal,
        };
      })
      .catch((e: unknown): RunOutcome => ({
        ok: false,
        error: `框架异常: ${(e as Error).message}`,
      }));

    // 墙钟超时：到期时把 pending 的 run 替换为失败结果
    const timeoutOutcome = new Promise<RunOutcome>((resolve) => {
      const t = setTimeout(
        () => resolve({ ok: false, error: `超时（${timeoutMs}ms）` }),
        timeoutMs,
      );
      (t as { unref?: () => void }).unref?.();
    });

    const outcome = await Promise.race([run, timeoutOutcome]);
    if (!outcome.ok) return { error: outcome.error };

    const trace: RunTrace = {
      caseId: c.id,
      suite: c.suite,
      origin: c.origin,
      result: outcome.result,
      trajectory: outcome.trajectory,
      messages: outcome.messages,
      durationMs: outcome.durationMs,
      usageTotal: outcome.usageTotal,
      turns: outcome.turns,
    };

    // 预算熔断：token 超限直接判失败
    const maxTokens = c.metadata?.maxTokens;
    if (maxTokens !== undefined && trace.usageTotal > maxTokens) {
      return { error: `预算熔断：usage.total=${trace.usageTotal} > maxTokens=${maxTokens}` };
    }

    return { trace };
  } finally {
    await runtime.close().catch(() => undefined);
  }
}

/**
 * M5：按需装配评分器依赖（lazy 检测——只有用例真的用了 semantic /
 * llm-judge 才装配，配置缺失时抛可操作错误，由 CLI 转为用法错误）。
 */
function resolveScorerDeps(
  config: RunConfig,
  needs: { judge: boolean; embed: boolean },
  targetSpec?: { provider: string; modelId: string },
): ScorerDeps {
  const deps: ScorerDeps = {};
  if (needs.judge) {
    const judge = config.judgeStreamFn
      ? { streamFn: config.judgeStreamFn, model: config.judgeFrameworkModel }
      : (() => {
          const llm = resolveJudgeLlm({
            model: config.judgeModel,
            apiKey: config.judgeApiKey,
            baseUrl: config.judgeBaseUrl,
            timeoutMs: config.requestTimeoutMs,
          });
          assertJudgeDistinct(targetSpec, llm.spec);
          return llm;
        })();
    deps.judge = createJudgeDeps(judge.streamFn, judge.model, config.judgeStreamFn ? 'injected-judge' : undefined);
  }
  if (needs.embed) {
    deps.embed = createOpenAiCompatibleEmbedFn({
      model: config.embedModel,
      apiKey: config.embedApiKey,
      baseUrl: config.embedBaseUrl,
    });
  }
  return deps;
}

/** 单用例（含 repeats） */
async function runCase(
  c: EvalCase,
  config: RunConfig,
  bundle: RuntimeBundle | undefined,
  budget: BudgetState,
  scorerDeps: ScorerDeps,
): Promise<CaseResult> {
  const isLive = config.mode === 'live';
  const repeats =
    c.metadata?.repeats ?? config.repeats ?? (isLive ? LIVE_DEFAULT_REPEATS : 1);
  const scorers = resolveScorers(c.expected, c.scorers);

  // 全局预算熔断：已超限时剩余用例直接判失败，不再烧钱
  if (config.maxTotalTokens !== undefined && budget.spent > config.maxTotalTokens) {
    return {
      caseId: c.id,
      suite: c.suite,
      origin: c.origin,
      passed: false,
      score: 0,
      scores: [],
      error: `总预算熔断：累计 usage.total=${budget.spent} > maxTotalTokens=${config.maxTotalTokens}`,
      durationMs: 0,
      steps: 0,
      usageTotal: 0,
      repeats,
      passCount: 0,
    };
  }

  let scoreSum = 0;
  let scoreCount = 0;
  let passCount = 0;
  const failedScores: ScoreResult[] = [];
  let runError: string | undefined;
  let steps = 0;
  let usageTotal = 0;
  let durationMs = 0;
  let lastTraceUsage = 0;

  for (let r = 0; r < repeats; r++) {
    const t0 = Date.now();
    const { trace, error } = await runCaseOnce(c, config, r, bundle);
    durationMs += Date.now() - t0;

    if (error || !trace) {
      runError = runError ?? error;
      continue;
    }

    steps = trace.trajectory.length;
    lastTraceUsage = trace.usageTotal;
    usageTotal += trace.usageTotal;
    budget.spent += trace.usageTotal;

    const caseScore = await scoreTrace(trace, scorers, scorerDeps);
    scoreSum += caseScore.score;
    scoreCount += 1;
    if (caseScore.passed) passCount += 1;
    else failedScores.push(...caseScore.scores.filter((s) => !s.passed));
  }

  if (scoreCount === 0 && runError) {
    return {
      caseId: c.id,
      suite: c.suite,
      origin: c.origin,
      passed: false,
      score: 0,
      scores: [
        { scorer: 'success', score: 0, passed: false, reason: `运行失败: ${runError}` },
      ],
      error: runError,
      durationMs,
      steps,
      usageTotal,
      repeats,
      passCount: 0,
    };
  }

  // live：pass@k（k 次里至少过一次）；mock：每次都必须过
  const passed = isLive ? passCount > 0 : passCount === scoreCount && scoreCount > 0;
  if (scoreCount < repeats) {
    runError = runError ?? `${repeats - scoreCount}/${repeats} 次运行异常`;
  }

  return {
    caseId: c.id,
    suite: c.suite,
    origin: c.origin,
    passed,
    score: scoreCount === 0 ? 0 : scoreSum / scoreCount,
    scores: passed ? [] : failedScores,
    error: runError,
    durationMs,
    steps,
    usageTotal: usageTotal || lastTraceUsage,
    repeats,
    passCount,
  };
}

/** 简单并发队列（避免引入依赖） */
async function runAllConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(results: CaseResult[]): Record<string, SuiteSummary> {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) {
    const list = groups.get(r.suite) ?? [];
    list.push(r);
    groups.set(r.suite, list);
  }
  const out: Record<string, SuiteSummary> = {};
  for (const [key, list] of groups) {
    const total = list.length;
    const passed = list.filter((r) => r.passed).length;
    out[key] = {
      total,
      passed,
      passRate: total === 0 ? 0 : passed / total,
      avgScore: total === 0 ? 0 : list.reduce((a, r) => a + r.score, 0) / total,
    };
  }
  return out;
}

/** 执行一次评测 */
export async function runEval(
  cases: EvalCase[],
  config: RunConfig,
): Promise<EvalReport> {
  const startedAt = Date.now();
  const bundle = resolveRuntimeBundle(config);

  const bySuite =
    config.suites && config.suites.length > 0
      ? cases.filter((c) => config.suites!.includes(c.suite))
      : cases;

  const skipped: NonNullable<EvalReport['skipped']> = [];
  const runnable = bySuite.filter((c) => {
    const reason = skipReason(c, config.mode);
    if (reason) {
      skipped.push({ caseId: c.id, suite: c.suite, reason });
      return false;
    }
    return true;
  });

  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const budget: BudgetState = { spent: 0 };

  // M5：只有用例真的使用 semantic / llm-judge 才装配对应依赖（配置缺失抛错 → CLI 用法错误）
  const usesScorer = (type: string) =>
    runnable.some((c) => resolveScorers(c.expected, c.scorers).some((s) => s.type === type));
  const scorerDeps = resolveScorerDeps(
    config,
    { judge: usesScorer('llm-judge'), embed: usesScorer('semantic') },
    bundle?.label ? parseModelSpecSafe(bundle.label) : undefined,
  );

  const results = await runAllConcurrent(runnable, concurrency, (c) =>
    runCase(c, config, bundle, budget, scorerDeps),
  );

  const casesPassed = results.filter((r) => r.passed).length;
  return {
    runId: `run_${new Date().toISOString().replace(/[:.]/g, '-')}`,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    mode: config.mode,
    model: bundle?.label ?? (config.mode === 'live' ? config.model : undefined),
    totals: {
      cases: results.length,
      passed: casesPassed,
      skipped: skipped.length,
      passRate: results.length === 0 ? 0 : casesPassed / results.length,
      avgScore:
        results.length === 0
          ? 0
          : results.reduce((a, r) => a + r.score, 0) / results.length,
      usageTotal: results.reduce((a, r) => a + r.usageTotal, 0),
    },
    bySuite: summarize(results),
    byOrigin: summarize(results.map((r) => ({ ...r, suite: r.origin }))),
    results,
    skipped,
  };
}
