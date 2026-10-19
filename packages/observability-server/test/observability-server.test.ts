/**
 * 收集服务端到端验收（@aipack-ai/observability-server，observability-s2.md §9）：
 * 起真实收集服务（createCollector + http server）→ SDK 埋点上报 → 查询 /metrics、/traces 断言。
 * 附加用例：鉴权失败丢弃、上报失败本地缓存补报。
 *
 * 存储层用内存 mock（MemoryTraceStore / MemoryAppStore / MemoryAlertStore）替代真实
 * MySQL/ClickHouse，验证 collector 的组装与查询链路；SQL 聚合语义由集成环境覆盖。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRuntime, createRequest } from '@aipack-ai/agent';
import type { StreamFn, StreamEvent, Message, AssistantMessage, Tool } from '@aipack-ai/agent';
import { createObservability, HttpReporter, ObservabilityTelemetry } from '@aipack-ai/observability';
import type { EventBatch, RunRecord, SpanRecord, ToolCallRecord, EventRecord, RetryRecord } from '@aipack-ai/observability';
import { createCollector, createCollectorServer } from '../src/index';
import { Aggregator } from '../src/aggregator';
import type {
  CollectorOptions,
  BusinessStores,
  TraceStore,
  TraceDetail,
  RunQueryFilter,
  RunListItem,
  VersionMetrics,
  VersionToolStat,
  AppStore,
  AppRecord,
  AlertStore,
  AlertRuleRow,
  AlertEventRow,
} from '../src/index';

// 测试豁免：mock webhook 监听 127.0.0.1，S3 安全修复默认拦截内网目标，测试显式放行
process.env.ALERTS_WEBHOOK_ALLOW_PRIVATE = '1';

// ─── mock streamFn（与 telemetry.test.ts 同手法）──────────────────

function mockStreamFn(messages: Message[]): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    for (const msg of messages) {
      yield { type: 'done', message: msg as AssistantMessage };
    }
  };
}

function assistant(
  text: string,
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: {
      input: usage?.input ?? 10,
      output: usage?.output ?? 5,
      total: (usage?.input ?? 10) + (usage?.output ?? 5),
      ...(usage?.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
      ...(usage?.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
    },
    timestamp: Date.now(),
  };
}

const echoTool: Tool = {
  name: 'echo',
  description: '回显参数',
  parameters: { type: 'object', properties: { msg: { type: 'string' } } },
  execute: async (_id, args) => ({
    content: [{ type: 'text', text: String((args as any)?.msg ?? '') }],
    details: {},
  }),
};

/** 第一轮返回工具调用，后续返回纯文本 */
function mockToolStreamFn(): StreamFn {
  let called = 0;
  return async function* (): AsyncGenerator<StreamEvent> {
    called += 1;
    if (called === 1) {
      const toolCall: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'echo', arguments: { msg: 'foo' } }],
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, total: 15 },
        timestamp: Date.now(),
      };
      yield { type: 'done', message: toolCall };
    } else {
      yield { type: 'done', message: assistant('done') };
    }
  };
}

/** 模拟 provider 内部重试：首次调用经 onRetryAttempt 通知后退避，随即成功 */
function retryStreamFn(): StreamFn {
  return async function* (_model, _context, options): AsyncGenerator<StreamEvent> {
    options?.onRetryAttempt?.({ attempt: 1, error: new Error('boom'), delayMs: 1 });
    yield { type: 'done', message: assistant('recovered') };
  };
}

// ─── 测试基础设施 ─────────────────────────────────────────────────

const APP_ID = 'test-app';
const APP_SECRET = 's3cret';
const ADMIN = { username: 'admin', password: 'admin123' };

let cleanup: Array<() => void> = [];

function tempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── 内存 mock Store（替代真实 MySQL / ClickHouse）────────────────

/** 线性插值分位（对齐原直查版聚合口径） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

/** TraceStore 内存实现：runs/spans/toolCalls/events/retries 全量留存，语义对齐 DB 直查 */
class MemoryTraceStore implements TraceStore {
  runs: RunRecord[] = [];
  spans: SpanRecord[] = [];
  toolCalls: ToolCallRecord[] = [];
  events: EventRecord[] = [];
  retries: RetryRecord[] = [];
  /** traceId → appId（flush 时盖戳） */
  appIds = new Map<string, string>();

  async insertRun(r: RunRecord): Promise<void> {
    this.runs.push({ ...r });
  }

  async insertSpan(s: SpanRecord): Promise<void> {
    this.spans.push({ ...s });
  }

  async insertToolCall(t: ToolCallRecord): Promise<void> {
    this.toolCalls.push({ ...t });
  }

  async queryRuns(filter: RunQueryFilter): Promise<{ total: number; items: RunListItem[] }> {
    const toolTraceIds = filter.tool
      ? new Set(this.toolCalls.filter((t) => t.toolName === filter.tool).map((t) => t.traceId))
      : undefined;
    const matched = this.runs
      .filter((r) => {
        if (filter.since !== undefined && r.startedAt < filter.since) return false;
        if (filter.until !== undefined && r.startedAt > filter.until) return false;
        if (filter.status && r.status !== filter.status) return false;
        if (filter.model && r.model !== filter.model) return false;
        if (filter.sessionKey && r.sessionKey !== filter.sessionKey) return false;
        if (filter.version && (r.appVersion ?? 'unknown') !== filter.version) return false;
        if (filter.appId && this.appIds.get(r.traceId) !== filter.appId) return false;
        if (toolTraceIds && !toolTraceIds.has(r.traceId)) return false;
        return true;
      })
      .sort((a, b) => b.startedAt - a.startedAt);
    const items: RunListItem[] = matched
      .slice(filter.offset, filter.offset + filter.limit)
      .map((r) => ({
        ...r,
        appId: this.appIds.get(r.traceId),
        retries: this.retries.filter((rt) => rt.traceId === r.traceId).length,
      }));
    return { total: matched.length, items };
  }

  async queryTrace(traceId: string): Promise<TraceDetail | undefined> {
    const run = this.runs.find((r) => r.traceId === traceId);
    if (!run) return undefined;
    return {
      run,
      spans: this.spans.filter((s) => s.traceId === traceId).sort((a, b) => a.startedAt - b.startedAt),
      tools: this.toolCalls.filter((t) => t.traceId === traceId),
      events: this.events.filter((e) => e.traceId === traceId).sort((a, b) => a.timestamp - b.timestamp),
      retries: this.retries.filter((r) => r.traceId === traceId).sort((a, b) => a.timestamp - b.timestamp),
    };
  }

  async getRunAppId(traceId: string): Promise<string | undefined> {
    return this.appIds.get(traceId);
  }

  /** 按版本聚合（口径对齐 /metrics/versions）：lastSeenAt 倒序 */
  async queryVersionMetrics(filter: {
    since?: number;
    until?: number;
    appId?: string;
  }): Promise<VersionMetrics[]> {
    const runs = this.runs.filter((r) => {
      if (filter.since !== undefined && r.startedAt < filter.since) return false;
      if (filter.until !== undefined && r.startedAt > filter.until) return false;
      if (filter.appId && this.appIds.get(r.traceId) !== filter.appId) return false;
      return true;
    });
    const groups = new Map<string, RunRecord[]>();
    for (const r of runs) {
      const v = r.appVersion ?? 'unknown';
      const list = groups.get(v) ?? [];
      list.push(r);
      groups.set(v, list);
    }
    const items: VersionMetrics[] = [];
    for (const [version, rs] of groups) {
      const traceIds = new Set(rs.map((r) => r.traceId));
      const spans = this.spans.filter((s) => traceIds.has(s.traceId));
      const tools = this.toolCalls.filter((t) => traceIds.has(t.traceId));
      const durations = rs.map((r) => r.durationMs ?? 0).sort((a, b) => a - b);
      const successes = rs.filter((r) => r.status === 'success').length;
      const errorClasses: Record<string, number> = {};
      for (const r of rs) {
        if (r.status !== 'success' && r.errorClass) {
          errorClasses[r.errorClass] = (errorClasses[r.errorClass] ?? 0) + 1;
        }
      }
      const acc: Record<string, { calls: number; errors: number; msSum: number }> = {};
      for (const t of tools) {
        const st = acc[t.toolName] ?? { calls: 0, errors: 0, msSum: 0 };
        st.calls += 1;
        st.msSum += t.durationMs ?? 0;
        if (t.status === 'error') st.errors += 1;
        acc[t.toolName] = st;
      }
      const toolStats: Record<string, VersionToolStat> = {};
      for (const [name, st] of Object.entries(acc)) {
        toolStats[name] = {
          calls: st.calls,
          successRate: st.calls > 0 ? (st.calls - st.errors) / st.calls : 0,
          avgMs: st.calls > 0 ? st.msSum / st.calls : 0,
          errors: st.errors,
        };
      }
      items.push({
        version,
        lastSeenAt: Math.max(...rs.map((r) => r.startedAt)),
        requests: rs.length,
        successRate: rs.length > 0 ? successes / rs.length : 0,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        p99Ms: percentile(durations, 0.99),
        totalTokens: rs.reduce((sum, r) => sum + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0),
        avgTurns: rs.length > 0 ? rs.reduce((s, r) => s + (r.turns ?? 0), 0) / rs.length : 0,
        retryRate:
          spans.length > 0
            ? spans.reduce((s, x) => s + Math.max(0, (x.attempts ?? 1) - 1), 0) / spans.length
            : 0,
        errorClasses,
        tools: toolStats,
      });
    }
    return items.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  async queryErrorClassCounts(filter: {
    since?: number;
    until?: number;
    appId?: string;
    limit?: number;
  }): Promise<Array<{ errorClass: string; count: number }>> {
    const counts = new Map<string, number>();
    for (const r of this.runs) {
      if (filter.since !== undefined && r.startedAt < filter.since) continue;
      if (filter.until !== undefined && r.startedAt > filter.until) continue;
      if (filter.appId && this.appIds.get(r.traceId) !== filter.appId) continue;
      if (r.errorClass) counts.set(r.errorClass, (counts.get(r.errorClass) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([errorClass, count]) => ({ errorClass, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, filter.limit ?? 10);
  }

  async queryErrorClassDrill(filter: {
    since?: number;
    until?: number;
    appId?: string;
    errorClass: string;
  }): Promise<{
    errorClass: string;
    recentTraces: Array<{
      traceId: string;
      startedAt: number;
      durationMs: number;
      model?: string;
      appId?: string;
      sessionKey?: string;
    }>;
    byModel: Record<string, number>;
    byTool: Record<string, number>;
  }> {
    const runs = this.runs.filter((r) => r.errorClass === filter.errorClass);
    const traceIds = new Set(runs.map((r) => r.traceId));
    const byModel: Record<string, number> = {};
    for (const r of runs) {
      if (r.model) byModel[r.model] = (byModel[r.model] ?? 0) + 1;
    }
    const byTool: Record<string, number> = {};
    for (const t of this.toolCalls) {
      if (traceIds.has(t.traceId) && t.status === 'error') {
        byTool[t.toolName] = (byTool[t.toolName] ?? 0) + 1;
      }
    }
    return {
      errorClass: filter.errorClass,
      recentTraces: runs.slice(-10).map((r) => ({
        traceId: r.traceId,
        startedAt: r.startedAt,
        durationMs: r.durationMs ?? 0,
        model: r.model,
        appId: this.appIds.get(r.traceId),
        sessionKey: r.sessionKey,
      })),
      byModel,
      byTool,
    };
  }

  async flush(batch: EventBatch, appId: string): Promise<void> {
    for (const r of batch.runs) {
      this.runs.push({ ...r });
      this.appIds.set(r.traceId, appId);
    }
    for (const s of batch.spans) this.spans.push({ ...s });
    for (const t of batch.toolCalls) this.toolCalls.push({ ...t });
    for (const e of batch.events) this.events.push({ ...e });
    for (const rt of batch.retries) this.retries.push({ ...rt });
  }

  async prune(before: number): Promise<number> {
    const oldTraceIds = new Set(this.runs.filter((r) => r.startedAt < before).map((r) => r.traceId));
    const removedSpans = this.spans.filter((s) => oldTraceIds.has(s.traceId)).length;
    const removedTools = this.toolCalls.filter((t) => oldTraceIds.has(t.traceId)).length;
    const removedEvents = this.events.filter((e) => e.traceId !== undefined && oldTraceIds.has(e.traceId)).length;
    const removedRetries = this.retries.filter((r) => oldTraceIds.has(r.traceId)).length;
    const removedRuns = this.runs.length - this.runs.filter((r) => !oldTraceIds.has(r.traceId)).length;
    this.runs = this.runs.filter((r) => !oldTraceIds.has(r.traceId));
    this.spans = this.spans.filter((s) => !oldTraceIds.has(s.traceId));
    this.toolCalls = this.toolCalls.filter((t) => !oldTraceIds.has(t.traceId));
    this.events = this.events.filter((e) => e.traceId === undefined || !oldTraceIds.has(e.traceId));
    this.retries = this.retries.filter((r) => !oldTraceIds.has(r.traceId));
    return removedRuns + removedSpans + removedTools + removedEvents + removedRetries;
  }

  async backup(dir: string): Promise<string> {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `backup-${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        runs: this.runs,
        spans: this.spans,
        toolCalls: this.toolCalls,
        events: this.events,
        retries: this.retries,
      }),
    );
    return file;
  }

  async healthCheck(): Promise<void> {}

  async close(): Promise<void> {}
}

/** AppStore 内存实现（appId/appSecret 动态管理） */
class MemoryAppStore implements AppStore {
  private apps = new Map<string, AppRecord>();

  async createApp(name: string): Promise<AppRecord> {
    const rec: AppRecord = {
      appId: `app_${randomBytes(4).toString('hex')}`,
      appSecret: `sk_${randomBytes(12).toString('hex')}`,
      name,
      createdAt: Date.now(),
    };
    this.apps.set(rec.appId, rec);
    return rec;
  }

  async listApps(): Promise<AppRecord[]> {
    return [...this.apps.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async deleteApp(appId: string): Promise<boolean> {
    return this.apps.delete(appId);
  }

  async getApp(appId: string): Promise<AppRecord | undefined> {
    return this.apps.get(appId);
  }

  async verifyApp(appId: string, appSecret: string): Promise<boolean> {
    const app = this.apps.get(appId);
    return !!app && app.appSecret === appSecret;
  }

  async regenerateSecret(appId: string): Promise<string | undefined> {
    const app = this.apps.get(appId);
    if (!app) return undefined;
    app.appSecret = `sk_${randomBytes(12).toString('hex')}`;
    return app.appSecret;
  }

  async touchApp(appId: string, ts: number): Promise<void> {
    const app = this.apps.get(appId);
    if (app) app.lastSeenAt = ts;
  }

  async seedApps(apps: Record<string, string>): Promise<void> {
    for (const [appId, secret] of Object.entries(apps)) {
      if (!this.apps.has(appId)) {
        this.apps.set(appId, { appId, appSecret: secret, name: appId, createdAt: Date.now() });
      }
    }
  }

  async close(): Promise<void> {}
}

/** AlertStore 内存实现（alert_rules / alert_events CRUD） */
class MemoryAlertStore implements AlertStore {
  private rules = new Map<string, AlertRuleRow>();
  private events: AlertEventRow[] = [];
  private nextEventId = 1;

  async listAlertRules(): Promise<AlertRuleRow[]> {
    return [...this.rules.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  async getAlertRule(id: string): Promise<AlertRuleRow | undefined> {
    return this.rules.get(id);
  }

  async createAlertRule(rule: AlertRuleRow): Promise<void> {
    this.rules.set(rule.id, { ...rule });
  }

  async updateAlertRule(id: string, patch: Partial<AlertRuleRow>): Promise<AlertRuleRow | undefined> {
    const existing = this.rules.get(id);
    if (!existing) return undefined;
    const updated: AlertRuleRow = { ...existing, ...patch, id };
    this.rules.set(id, updated);
    return updated;
  }

  async deleteAlertRule(id: string): Promise<boolean> {
    return this.rules.delete(id);
  }

  async insertAlertEvent(ev: Omit<AlertEventRow, 'id'>): Promise<void> {
    this.events.push({ ...ev, id: this.nextEventId++ });
  }

  async listAlertEvents(opts: {
    offset: number;
    limit: number;
    status?: string;
  }): Promise<{ total: number; items: AlertEventRow[] }> {
    const filtered = (opts.status ? this.events.filter((e) => e.status === opts.status) : [...this.events])
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    return { total: filtered.length, items: filtered.slice(opts.offset, opts.offset + opts.limit) };
  }
}

/** 单用户模式不使用的多用户 store（误用时抛错） */
function notUsedStore(): never {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('单用户模式不应调用此 store');
      },
    },
  ) as never;
}

/** 组装一组内存 Store（traceStore / appStore / alertStore + BusinessStores） */
function buildStores(): {
  traceStore: MemoryTraceStore;
  appStore: MemoryAppStore;
  alertStore: MemoryAlertStore;
  businessStores: BusinessStores;
} {
  const traceStore = new MemoryTraceStore();
  const appStore = new MemoryAppStore();
  const alertStore = new MemoryAlertStore();
  const businessStores: BusinessStores = {
    appStore,
    alertStore,
    userStore: notUsedStore(),
    projectStore: notUsedStore(),
    agentDefinitionStore: notUsedStore(),
    aclStore: notUsedStore(),
    close: async () => {},
  };
  return { traceStore, appStore, alertStore, businessStores };
}

/** 启动真实收集服务，返回 baseUrl + 面板 token + mock stores + collector */
async function startCollector(
  apps: Record<string, string> = { [APP_ID]: APP_SECRET },
  extraOpts: Partial<CollectorOptions> = {},
  reuse?: ReturnType<typeof buildStores>,
): Promise<{
  baseUrl: string;
  token: string;
  collector: ReturnType<typeof createCollector>;
  traceStore: MemoryTraceStore;
  appStore: MemoryAppStore;
  alertStore: MemoryAlertStore;
}> {
  const stores = reuse ?? buildStores();
  const collector = createCollector({
    apps,
    admin: ADMIN,
    businessStores: stores.businessStores,
    traceStore: stores.traceStore,
    ...extraOpts,
  });
  const server = http.createServer((req, res) => void collector.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await collector.close();
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = await login(baseUrl);
  return {
    baseUrl,
    token,
    collector,
    traceStore: stores.traceStore,
    appStore: stores.appStore,
    alertStore: stores.alertStore,
  };
}

/** 面板登录，返回 Bearer token */
async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(res.status, 200, '面板登录应成功');
  const body = (await res.json()) as { token?: string };
  assert.ok(body.token, '应返回 token');
  return body.token as string;
}

async function requestJson(
  baseUrl: string,
  urlPath: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const getJson = (baseUrl: string, urlPath: string, token?: string) =>
  requestJson(baseUrl, urlPath, { token });

/** 直接 POST /api/v1/ingest，返回状态码（空批次也可，服务端返回 200） */
async function postIngest(
  baseUrl: string,
  appId: string,
  appSecret: string,
  runs: RunRecord[] = [],
): Promise<number> {
  const res = await fetch(`${baseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-id': appId, 'x-app-secret': appSecret },
    body: JSON.stringify({ appId, runs, spans: [], toolCalls: [], permissions: [] }),
  });
  return res.status;
}

async function runOnce(telemetry: any, opts: { streamFn: StreamFn; tools?: Tool[]; permissionPolicy?: any } = {
  streamFn: mockStreamFn([assistant('hello')]),
}) {
  const runtime = createRuntime({
    streamFn: opts.streamFn,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.permissionPolicy ? { permissionPolicy: opts.permissionPolicy } : {}),
    // 本套件验证指标管线而非权限语义：显式放行（运行时默认 fail-closed，未配置策略会拒绝所有工具调用）
    permissionFailOpen: true,
    telemetry,
  });
  return runtime.run(createRequest('hi'));
}

afterEach(() => {
  const fns = cleanup;
  cleanup = [];
  for (const fn of fns) fn();
});

// ─── 用例 ─────────────────────────────────────────────────────────

describe('S2 收集服务端到端', () => {
  it('run 成功：summary.requests=1、successRate=1，trace 含 run + model span', async () => {
    const { baseUrl, token, traceStore } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const result = await runOnce(obs.telemetry);
    assert.equal(result.success, true);
    await obs.close(); // 等上报完成

    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.requests, 1);
    assert.equal(summary.body.successRate, 1);
    assert.equal(summary.body.avgTurns, 1);

    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    assert.equal(detail.status, 200);
    const kinds = detail.body.spans.map((s: any) => s.kind);
    assert.ok(kinds.includes('run'));
    assert.ok(kinds.includes('model'));

    // 落盘持久化：trace 已写入 traceStore，可直接查询
    assert.ok(await traceStore.queryTrace(String(result.metadata.traceId)), 'trace 应已持久化');
  });

  it('工具循环 2 轮：avgTurns=2，/metrics/tools 工具 successRate=1', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs.telemetry, { streamFn: mockToolStreamFn(), tools: [echoTool] });
    await obs.close();

    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.body.avgTurns, 2);
    const tools = await getJson(baseUrl, '/metrics/tools', token);
    assert.equal(tools.body.length, 1);
    assert.equal(tools.body[0].tool, 'echo');
    assert.equal(tools.body[0].calls, 1);
    assert.equal(tools.body[0].successRate, 1);
  });

  it('工具抛错：该工具 successRate=0、errors=1，tool span status=error', async () => {
    const throwingTool: Tool = {
      name: 'echo',
      description: '总是抛错',
      parameters: { type: 'object' },
      execute: async () => {
        throw new Error('boom');
      },
    };
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const result = await runOnce(obs.telemetry, { streamFn: mockToolStreamFn(), tools: [throwingTool] });
    await obs.close();

    const tools = await getJson(baseUrl, '/metrics/tools', token);
    assert.equal(tools.body[0].successRate, 0);
    assert.equal(tools.body[0].errors, 1);

    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    const toolSpan = detail.body.spans.find((s: any) => s.kind === 'tool');
    assert.equal(toolSpan.status, 'error');
  });

  it('权限拒绝：permissionDenied=1，且工具统计不计入', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs.telemetry, {
      streamFn: mockToolStreamFn(),
      tools: [echoTool],
      permissionPolicy: { check: async () => 'deny' },
    });
    await obs.close();

    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.body.permissionDenied, 1);
    const tools = await getJson(baseUrl, '/metrics/tools', token);
    assert.equal(tools.body.length, 0, '被拒调用不计入工具统计分母');
  });

  it('模型重试：span.attempts=2、retryRate=1', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const result = await runOnce(obs.telemetry, { streamFn: retryStreamFn() });
    await obs.close();

    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.body.retryRate, 1);
    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    const modelSpan = detail.body.spans.find((s: any) => s.kind === 'model');
    assert.equal(modelSpan.attempts, 2);
  });

  it('流式请求：run 落库可查询（durationMs）', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const runtime = createRuntime({
      streamFn: async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', delta: 'hel' };
        yield { type: 'done', message: assistant('hello') };
      },
      telemetry: obs.telemetry,
    });
    for await (const _chunk of runtime.stream(createRequest('hi'))) {
      /* 排空 */
    }
    await obs.close();

    const list = await getJson(baseUrl, '/traces', token);
    assert.equal(list.body.total, 1);
    assert.ok(typeof list.body.items[0].durationMs === 'number');
  });

  it('校验失败请求：/traces?status=validation 命中', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello')]),
      telemetry: obs.telemetry,
    });
    await runtime.run(createRequest(''));
    await obs.close();

    const list = await getJson(baseUrl, '/traces?status=validation', token);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0].status, 'validation');
    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.body.requests, 1);
    assert.equal(summary.body.successRate, 0);
  });

  it('token 透传：input/output/cache 汇总进 summary.totalTokens 与 span tokens', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const result = await runOnce(obs.telemetry, {
      streamFn: mockStreamFn([assistant('hello', { input: 100, output: 200, cacheRead: 10, cacheWrite: 5 })]),
    });
    await obs.close();

    const summary = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(summary.body.totalTokens, 315, 'totalTokens = input+output+cacheRead+cacheWrite');
    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    const modelSpan = detail.body.spans.find((s: any) => s.kind === 'model');
    assert.deepEqual(modelSpan.tokens, { input: 100, output: 200, cacheRead: 10, cacheWrite: 5 });
  });

  it('鉴权失败：错误 secret 被拒(401)，客户端丢弃且不缓存', async () => {
    const { baseUrl, token } = await startCollector();
    const cacheDir = tempDir('obs-cache');
    const obs = createObservability({ appId: APP_ID, appSecret: 'wrong-secret', endpoint: baseUrl, cacheDir });
    await runOnce(obs.telemetry);
    await obs.close();

    const list = await getJson(baseUrl, '/traces', token);
    assert.equal(list.body.total, 0, '未鉴权的数据不应入库');
    const cacheFile = path.join(cacheDir, `${APP_ID}.json`);
    assert.ok(!fs.existsSync(cacheFile), '4xx 不应写入缓存（重试无意义）');
  });

  it('上报失败本地缓存补报：断网落缓存 → 收集服务恢复后补报成功', async () => {
    const cacheDir = tempDir('obs-cache');

    // 1. endpoint 指向未监听端口 → 上报失败 → 写缓存
    // 起一个 http server 拿端口后立刻关闭，该端口即"死端口"
    const deadServer = http.createServer();
    await new Promise<void>((r) => deadServer.listen(0, '127.0.0.1', r));
    const deadPort = (deadServer.address() as AddressInfo).port;
    await new Promise<void>((r) => deadServer.close(() => r()));

    const reporter = new HttpReporter({
      endpoint: `http://127.0.0.1:${deadPort}`,
      appId: APP_ID,
      appSecret: APP_SECRET,
      cacheDir,
    });
    const telemetry = new ObservabilityTelemetry(reporter, { intervalMs: 10 ** 9 });
    const result = await runOnce(telemetry);
    await telemetry.close(); // 网络失败 → 缓存
    const cacheFile = path.join(cacheDir, `${APP_ID}.json`);
    assert.ok(fs.existsSync(cacheFile), '上报失败应写入本地缓存');

    // 2. 真实收集服务起来，用同一 cacheDir 的 reporter 补报
    const { baseUrl, token } = await startCollector();
    const reporter2 = new HttpReporter({
      endpoint: baseUrl,
      appId: APP_ID,
      appSecret: APP_SECRET,
      cacheDir,
    });
    const ok = await reporter2.send({ runs: [], spans: [], toolCalls: [], permissions: [], retries: [], events: [] } satisfies EventBatch);
    assert.equal(ok, true, '缓存补报应成功');
    assert.ok(!fs.existsSync(cacheFile), '补报成功后缓存应删除');

    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    assert.equal(detail.status, 200, '补报的数据应可查询');
    assert.equal(detail.body.traceId, result.metadata.traceId);
  });
});

describe('S2 面板 API（登录 + 应用管理 + 数据隔离）', () => {
  it('登录：正确凭证签发 token、/api/auth/me 可用；错误凭证 401', async () => {
    const { baseUrl, token } = await startCollector();

    const me = await getJson(baseUrl, '/api/auth/me', token);
    assert.equal(me.status, 200);
    assert.equal(me.body.username, ADMIN.username);

    const bad = await requestJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: ADMIN.username, password: 'wrong' },
    });
    assert.equal(bad.status, 401, '错误密码应被拒');
  });

  it('查询端点需登录：无 token 访问 /metrics/summary 返回 401', async () => {
    const { baseUrl } = await startCollector();
    const res = await getJson(baseUrl, '/metrics/summary');
    assert.equal(res.status, 401);
  });

  it('创建应用 → 生成 appId/appSecret → 新应用上报 → 按 appId 数据隔离', async () => {
    const { baseUrl, token } = await startCollector();

    // 面板创建新应用
    const created = await requestJson(baseUrl, '/api/apps', {
      method: 'POST',
      token,
      body: { name: '新应用' },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.appId.startsWith('app_'), 'appId 应自动生成');
    assert.ok(created.body.appSecret.startsWith('sk_'), 'appSecret 应自动生成');

    // 用种子应用上报一条
    const obs1 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs1.telemetry);
    await obs1.close();

    // 用新应用上报一条
    const obs2 = createObservability({ appId: created.body.appId, appSecret: created.body.appSecret, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs2.telemetry);
    await obs2.close();

    // 全局 = 2；按应用过滤各为 1
    const all = await getJson(baseUrl, '/metrics/summary', token);
    assert.equal(all.body.requests, 2);
    const byNew = await getJson(baseUrl, `/metrics/summary?appId=${created.body.appId}`, token);
    assert.equal(byNew.body.requests, 1);
    const bySeed = await getJson(baseUrl, `/metrics/summary?appId=${APP_ID}`, token);
    assert.equal(bySeed.body.requests, 1);

    // /traces 列表带 appId，且新应用 trace 标记来源
    const traces = await getJson(baseUrl, `/traces?appId=${created.body.appId}`, token);
    assert.equal(traces.body.total, 1);
    assert.equal(traces.body.items[0].appId, created.body.appId);
  });

  it('删除应用后 ingest 被拒(401)', async () => {
    const { baseUrl, token } = await startCollector({});
    const created = await requestJson(baseUrl, '/api/apps', {
      method: 'POST',
      token,
      body: { name: '临时应用' },
    });
    assert.equal(created.status, 201);

    const del = await requestJson(baseUrl, `/api/apps/${created.body.appId}`, { method: 'DELETE', token });
    assert.equal(del.status, 200);

    const status = await postIngest(baseUrl, created.body.appId, created.body.appSecret);
    assert.equal(status, 401, '已删除应用的上报应被拒');
    const list = await getJson(baseUrl, '/traces', token);
    assert.equal(list.body.total, 0, '被删应用的上报不应入库');
  });

  it('重置 secret：旧 secret 失效、新 secret 生效', async () => {
    const { baseUrl, token } = await startCollector();
    const created = await requestJson(baseUrl, '/api/apps', {
      method: 'POST',
      token,
      body: { name: '密钥应用' },
    });
    const oldSecret = created.body.appSecret;

    const regen = await requestJson(baseUrl, `/api/apps/${created.body.appId}/regenerate-secret`, { method: 'POST', token });
    assert.equal(regen.status, 200);
    assert.notEqual(regen.body.appSecret, oldSecret, '新 secret 应不同');

    // 旧 secret 上报 → 401
    assert.equal(await postIngest(baseUrl, created.body.appId, oldSecret), 401, '旧 secret 应被拒');
    const list = await getJson(baseUrl, '/traces', token);
    assert.equal(list.body.total, 0, '旧 secret 数据不应入库');

    // 新 secret 上报 → 200
    assert.equal(await postIngest(baseUrl, created.body.appId, regen.body.appSecret), 200, '新 secret 应生效');
  });
});

// ─── P0 retention / alerting 测试数据构造 ─────────────────────────

function makeRun(traceId: string, startedAt: number): RunRecord {
  return {
    traceId,
    startedAt,
    endedAt: startedAt + 1000,
    sessionKey: 's',
    model: 'gpt-4o-mini',
    status: 'success',
    turns: 1,
    durationMs: 1000,
    activeMs: 900,
    queuedMs: 100,
    inputTokens: 10,
    outputTokens: 5,
  };
}

function makeSpan(traceId: string, startedAt: number): SpanRecord {
  return {
    traceId,
    spanId: `span-${traceId}`,
    kind: 'model',
    name: 'model:gpt-4o-mini',
    startedAt,
    durationMs: 800,
    status: 'ok',
    attempts: 1,
    inputTokens: 10,
    outputTokens: 5,
    sessionKey: 's',
  };
}

function makeTool(traceId: string): ToolCallRecord {
  return { traceId, spanId: `span-${traceId}`, toolName: 'echo', status: 'ok', durationMs: 100 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 本地 mock webhook：捕获收到的告警通知载荷 */
function startWebhookServer(): Promise<{
  url: string;
  posts: any[];
  close: () => Promise<void>;
}> {
  const posts: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      try {
        posts.push(JSON.parse(raw));
      } catch {
        /* 忽略非法载荷 */
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      cleanup.push(async () => {
        await new Promise<void>((r) => server.close(() => r()));
      });
      resolve({ url: `http://127.0.0.1:${port}`, posts, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

// ─── 版本维度聚合（/metrics/versions）─────────────────────────────

describe('版本维度聚合 /metrics/versions', () => {
  it('两版本上报 → 按版本聚合（请求量/成功率/工具），缺版本归 unknown，appId 隔离', async () => {
    const { baseUrl, token } = await startCollector();

    // 1.2.0：工具循环 2 轮（avgTurns=2，1 次 echo 调用）
    const obs12 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache'), version: '1.2.0' });
    await runOnce(obs12.telemetry, { streamFn: mockToolStreamFn(), tools: [echoTool] });
    await obs12.close();

    // 1.3.0：单轮成功（无工具）
    const obs13 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache'), version: '1.3.0' });
    await runOnce(obs13.telemetry);
    await obs13.close();

    // 缺版本（旧 SDK / 未配置）→ unknown
    const obsNone = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obsNone.telemetry);
    await obsNone.close();

    const versions = await getJson(baseUrl, '/metrics/versions', token);
    assert.equal(versions.status, 200);
    assert.equal(versions.body.items.length, 3);
    const v12 = versions.body.items.find((v: any) => v.version === '1.2.0');
    const v13 = versions.body.items.find((v: any) => v.version === '1.3.0');
    const unk = versions.body.items.find((v: any) => v.version === 'unknown');
    assert.ok(v12 && v13 && unk, '应返回 1.2.0 / 1.3.0 / unknown 三行');

    assert.equal(v12.requests, 1);
    assert.equal(v12.successRate, 1);
    assert.equal(v12.avgTurns, 2, '工具循环 2 轮');
    assert.equal(v12.tools.echo.calls, 1);
    assert.equal(v12.tools.echo.successRate, 1);
    assert.equal(v12.tools.echo.errors, 0);

    assert.equal(v13.requests, 1);
    assert.equal(v13.successRate, 1);
    assert.equal(v13.avgTurns, 1);
    assert.deepEqual(v13.tools, {}, '无工具调用的版本 tools 为空');

    assert.equal(unk.requests, 1);
    assert.equal(unk.version, 'unknown');

    // appId 隔离：新应用只上报 1 条 → 过滤后仅 1 版本；种子应用仍为 3 版本
    const created = await requestJson(baseUrl, '/api/apps', { method: 'POST', token, body: { name: '版本应用' } });
    const obsNew = createObservability({ appId: created.body.appId, appSecret: created.body.appSecret, endpoint: baseUrl, cacheDir: tempDir('obs-cache'), version: '2.0.0' });
    await runOnce(obsNew.telemetry);
    await obsNew.close();

    const byNew = await getJson(baseUrl, `/metrics/versions?appId=${created.body.appId}`, token);
    assert.equal(byNew.body.items.length, 1);
    assert.equal(byNew.body.items[0].version, '2.0.0');
    const bySeed = await getJson(baseUrl, `/metrics/versions?appId=${APP_ID}`, token);
    assert.equal(bySeed.body.items.length, 3, '种子应用只见自己的 3 个版本');
  });

  it('queryVersionMetrics 精确聚合：tokens/分位/错误分类/工具成功率/重试率，version NULL 归 unknown', async () => {
    const store = new MemoryTraceStore();
    const now = Date.now();
    await store.insertRun({ ...makeRun('r1', now), appVersion: '1.0.0', durationMs: 100, inputTokens: 10, outputTokens: 5, status: 'success' });
    await store.insertRun({ ...makeRun('r2', now + 1), appVersion: '1.0.0', durationMs: 300, inputTokens: 100, outputTokens: 50, status: 'error', errorClass: 'rate_limit' });
    await store.insertSpan({ ...makeSpan('r2', now + 1), attempts: 3 }); // 2 次重试
    await store.insertToolCall({ traceId: 'r1', spanId: 's1', toolName: 'echo', status: 'ok', durationMs: 100 });
    await store.insertToolCall({ traceId: 'r2', spanId: 's2', toolName: 'scrape', status: 'error', durationMs: 50, errorClass: 'network' });
    await store.insertRun({ ...makeRun('r3', now + 2), durationMs: 200, status: 'success' }); // 无版本 → unknown

    const items = await store.queryVersionMetrics({});
    assert.equal(items.length, 2, '1.0.0 + unknown');
    const v1 = items.find((v) => v.version === '1.0.0')!;
    const unk = items.find((v) => v.version === 'unknown')!;

    assert.equal(v1.requests, 2);
    assert.equal(v1.successRate, 0.5);
    assert.equal(v1.p50Ms, 200, '[100,300] p50 线性插值');
    assert.equal(v1.p95Ms, 290);
    assert.equal(v1.p99Ms, 298);
    assert.equal(v1.totalTokens, 165, '15 + 150');
    assert.equal(v1.avgTurns, 1);
    assert.equal(v1.retryRate, 2, '2 次重试 / 1 次模型调用');
    assert.deepEqual(v1.errorClasses, { rate_limit: 1 });
    assert.equal(v1.tools.echo.calls, 1);
    assert.equal(v1.tools.echo.successRate, 1);
    assert.equal(v1.tools.echo.errors, 0);
    assert.equal(v1.tools.scrape.calls, 1);
    assert.equal(v1.tools.scrape.successRate, 0);
    assert.equal(v1.tools.scrape.errors, 1);

    assert.equal(unk.requests, 1);
    assert.equal(unk.successRate, 1);
    assert.equal(unk.totalTokens, 15);
  });

  it('聚合器 version 维度：run/model span/tool call 按 traceId 归入版本；缺版本归 unknown；不污染全局', async () => {
    const agg = new Aggregator({ windowMs: 10 * 60_000, bucketMs: 60_000 });
    const now = Date.now();
    // v1：1 run + 1 model span（attempts=2 → 1 次重试）+ 1 次工具调用
    agg.ingestRun({ ...makeRun('t1', now), appVersion: '1.0.0', durationMs: 100, inputTokens: 10, outputTokens: 5 });
    agg.ingestModelCall({ ...makeSpan('t1', now), attempts: 2 });
    agg.ingestToolCall(makeTool('t1'));
    // v2：1 run（无 span/tool）
    agg.ingestRun({ ...makeRun('t2', now + 1), appVersion: '2.0.0', durationMs: 200, inputTokens: 20, outputTokens: 10 });
    // 无版本 run → unknown
    agg.ingestRun({ ...makeRun('t3', now + 2), durationMs: 300 });

    const filter = { since: now, until: now + 60_000 };
    const all = (await agg.summary(filter)) as any;
    assert.equal(all.requests, 3, '全局 = 3 run（工具调用不计入 requests，口径=run 计数）');
    assert.equal(all.successRate, 1, '3 run 全成功 → 100%（分母不再混入工具调用）');

    const v1 = (await agg.summary({ ...filter, version: '1.0.0' })) as any;
    assert.equal(v1.requests, 1, 'v1 = 1 run（工具调用只进 per-tool 统计）');
    assert.equal(v1.successRate, 1, 'success=1 / requests=1');
    assert.equal(v1.retryRate, 1, '1 次重试 / 1 次模型调用');
    assert.equal(v1.totalTokens, 15, 'model span tokens 10+5');

    const v2 = (await agg.summary({ ...filter, version: '2.0.0' })) as any;
    assert.equal(v2.requests, 1);
    assert.equal(v2.totalTokens, 0, 'v2 无 model span → tokens 0');

    const unk = (await agg.summary({ ...filter, version: 'unknown' })) as any;
    assert.equal(unk.requests, 1, '缺版本归 unknown');

    // groupBy=tool：工具维度桶 requests = 调用次数
    const byTool = (await agg.summary(filter, 'tool')) as any;
    assert.equal(byTool.echo.requests, 1, 'groupBy=tool 时 requests=调用次数');

    // timeseries / tools 同样支持版本过滤
    const ts = await agg.timeseries({ ...filter, version: '1.0.0' }, 60_000, 'requests');
    assert.equal(ts[0].v, 1);
    const tools = await agg.tools({ ...filter, version: '1.0.0' });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool, 'echo');

    // 不指定版本 = 全局，不因 version 维度受影响
    assert.equal(((await agg.summary(filter)) as any).requests, all.requests);
  });

  it('版本筛选 E2E：/metrics/summary?version= 与 /traces?version= 过滤，traces 带 appVersion', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache'), version: '1.2.0' });
    await runOnce(obs.telemetry);
    await obs.close();

    const sum = await getJson(baseUrl, '/metrics/summary?version=1.2.0', token);
    assert.equal(sum.body.requests, 1, '版本筛选命中上报的 run');
    const sumOther = await getJson(baseUrl, '/metrics/summary?version=2.0.0', token);
    assert.equal(sumOther.body.requests, 0, '不存在的版本返回空聚合');

    const traces = await getJson(baseUrl, '/traces?version=1.2.0', token);
    assert.equal(traces.body.items.length, 1);
    assert.equal(traces.body.items[0].appVersion, '1.2.0');
    const tracesOther = await getJson(baseUrl, '/traces?version=2.0.0', token);
    assert.equal(tracesOther.body.items.length, 0);
  });
});

// ─── P0-1 retention ───────────────────────────────────────────────

describe('P0 retention 数据保留', () => {
  it('prune 只删除过期明细（runs/spans/tool_calls），备份快照可生成', async () => {
    const store = new MemoryTraceStore();
    const now = Date.now();
    await store.insertRun(makeRun('old', now - 40 * 86400_000));
    await store.insertSpan(makeSpan('old', now - 40 * 86400_000));
    await store.insertToolCall(makeTool('old'));
    await store.insertRun(makeRun('new', now));

    const backupDir = tempDir('obs-backup');
    const backupFile = await store.backup(backupDir);
    assert.ok(fs.existsSync(backupFile), '备份快照文件应存在');

    const cleared = await store.prune(now - 10 * 86400_000); // 保留 10 天
    assert.equal(cleared, 3, '应删除 3 条过期记录');
    assert.equal(await store.queryTrace('old'), undefined, '过期 trace 应被删除');
    assert.ok(await store.queryTrace('new'), '新 trace 应保留');
  });

  it('collector 定时清理：过期数据被 prune，startup 清理不误删', async () => {
    // days 极小 → before≈now，过期数据（1h 前）立即被清
    const { baseUrl, traceStore, token } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { retention: { days: 0.000001, intervalMs: 20 } },
    );
    await traceStore.insertRun(makeRun('old', Date.now() - 3600_000));

    await sleep(150);
    const list = await getJson(baseUrl, '/traces', token);
    assert.equal(list.body.total, 0, '过期数据应被定时清理');
  });
});

// ─── P0-2 alerting ────────────────────────────────────────────────

const RULE_BODY = (webhookUrl?: string, extra: Record<string, unknown> = {}) => ({
  name: '成功率过低',
  metric: 'successRate',
  operator: 'lt',
  threshold: 0.95,
  lookbackMs: 60_000,
  cooldownMs: 0,
  webhookUrl,
  ...extra,
});

describe('P0 alerting 告警规则 API', () => {
  it('规则 CRUD + 鉴权 + 校验', async () => {
    const { baseUrl, token } = await startCollector();

    // 未登录 → 401
    assert.equal((await requestJson(baseUrl, '/api/alerts/rules', { method: 'POST', body: RULE_BODY() })).status, 401);

    // 非法 metric → 400
    const bad = await requestJson(baseUrl, '/api/alerts/rules', { method: 'POST', token, body: { ...RULE_BODY(), metric: 'nope' } });
    assert.equal(bad.status, 400);

    // 创建
    const created = await requestJson(baseUrl, '/api/alerts/rules', { method: 'POST', token, body: RULE_BODY() });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.ok(id, '应生成规则 id');
    assert.equal(created.body.lookbackMs, 60_000);
    assert.equal(created.body.enabled, true);

    // 列表
    const list = await getJson(baseUrl, '/api/alerts/rules', token);
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    // 更新
    const updated = await requestJson(baseUrl, `/api/alerts/rules/${id}`, {
      method: 'PUT',
      token,
      body: { threshold: 0.99 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.threshold, 0.99);
    assert.equal(updated.body.name, '成功率过低', '合并更新不应丢字段');

    // 删除
    const del = await requestJson(baseUrl, `/api/alerts/rules/${id}`, { method: 'DELETE', token });
    assert.equal(del.status, 200);
    assert.equal((await getJson(baseUrl, '/api/alerts/rules', token)).body.length, 0);
  });

  it('alert test 端点：未启用告警返回 400', async () => {
    const { baseUrl, token } = await startCollector(); // 未配置 alerts
    const created = await requestJson(baseUrl, '/api/alerts/rules', { method: 'POST', token, body: RULE_BODY() });
    const res = await requestJson(baseUrl, `/api/alerts/rules/${created.body.id}/test`, { method: 'POST', token });
    assert.equal(res.status, 400, '未启用告警时测试通知应报错');
  });
});

describe('P0 alerting 评估器（firing / recovered / 冷却 / webhook）', () => {
  it('触发 → firing + webhook 收到 payload；恢复 → recovered + 恢复通知', async () => {
    const webhook = await startWebhookServer();
    const { baseUrl, token, collector } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { alerts: { evaluateIntervalMs: 3600_000, defaultWebhookUrl: webhook.url } },
    );
    assert.ok(collector.alerts, 'alerts 配置时应装配评估器');

    // 成功率 < 50% 规则（lookback 60s；窗口内旧数据保留，阈值取 0.5 便于状态迁移）
    const created = await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST',
      token,
      body: RULE_BODY(webhook.url, { threshold: 0.5 }),
    });
    assert.equal(created.status, 201);

    // 阶段一：1 条失败（validation → successRate=0）→ 触发 firing
    const obs1 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const runtime1 = createRuntime({ streamFn: mockStreamFn([assistant('hello')]), telemetry: obs1.telemetry });
    await runtime1.run(createRequest(''));
    await obs1.close();

    const transitions = await collector.alerts!.evaluateOnce();
    assert.equal(transitions, 1, '本轮应恰好 1 条规则状态变化');

    const events = await getJson(baseUrl, '/api/alerts/events', token);
    assert.equal(events.body.total, 1);
    assert.equal(events.body.items[0].status, 'fired');
    assert.ok(events.body.items[0].value < 0.5, '事件应记录触发时的指标值');

    // webhook 收到 fired
    assert.equal(webhook.posts.length, 1);
    assert.equal(webhook.posts[0].status, 'fired');
    assert.equal(webhook.posts[0].rule.metric, 'successRate');

    // 阶段二：补 3 条成功 → 3/4=0.75 > 0.5 → 恢复
    const obs2 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs2.telemetry);
    await runOnce(obs2.telemetry);
    await runOnce(obs2.telemetry);
    await obs2.close();
    await collector.alerts!.evaluateOnce();

    const events2 = await getJson(baseUrl, '/api/alerts/events', token);
    assert.equal(events2.body.total, 2);
    assert.equal(events2.body.items[0].status, 'recovered', '最新事件应为 recovered');
    assert.equal(webhook.posts.length, 2);
    assert.equal(webhook.posts[1].status, 'recovered');
  });

  it('冷却期内不重复通知（事件照常记录）', async () => {
    const webhook = await startWebhookServer();
    const { baseUrl, token, collector } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { alerts: { evaluateIntervalMs: 3600_000 } },
    );

    // cooldown 1h：fired/recovered/fired 都发生在冷却内
    await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST',
      token,
      body: RULE_BODY(webhook.url, { threshold: 0.5, cooldownMs: 3600_000 }),
    });

    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const runtime = createRuntime({ streamFn: mockStreamFn([assistant('hello')]), telemetry: obs.telemetry });
    await runtime.run(createRequest('')); // 失败 → 0/1=0 < 0.5 → fire
    await obs.close();

    await collector.alerts!.evaluateOnce();
    assert.equal(webhook.posts.length, 1, '首次触发应通知');

    const obs2 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs2.telemetry); // 成功 → 1/2=0.5 → recover
    await obs2.close();
    await collector.alerts!.evaluateOnce();

    const obs3 = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const runtime3 = createRuntime({ streamFn: mockStreamFn([assistant('hello')]), telemetry: obs3.telemetry });
    await runtime3.run(createRequest('')); // 又失败 → 1/3=0.33 < 0.5 → fire again
    await obs3.close();
    await collector.alerts!.evaluateOnce();

    // 3 次状态变化（fired/recovered/fired）但冷却内只有首次通知
    const events = await getJson(baseUrl, '/api/alerts/events', token);
    assert.equal(events.body.total, 3);
    assert.equal(webhook.posts.length, 1, '冷却期内不应重复通知');
  });
});

// ─── P0-3 告警版本回归检测（阶段 3）──────────────────────────────

describe('P0-3 alerting 版本回归检测', () => {
  it('规则校验：regress_by 只能配版本回归指标；threshold 必须为正', async () => {
    const { baseUrl, token } = await startCollector();

    // 合法：versionSuccessRate + regress_by
    const ok = await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST',
      token,
      body: { name: '版本成功率回归', metric: 'versionSuccessRate', operator: 'regress_by', threshold: 0.1, lookbackMs: 3600_000, cooldownMs: 0 },
    });
    assert.equal(ok.status, 201);

    // regress_by 配普通指标 → 400
    const bad1 = await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST', token,
      body: { name: 'x', metric: 'successRate', operator: 'regress_by', threshold: 0.1 },
    });
    assert.equal(bad1.status, 400, 'regress_by 配普通指标应拒绝');

    // 版本回归指标配普通算子 → 400
    const bad2 = await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST', token,
      body: { name: 'x', metric: 'versionSuccessRate', operator: 'gt', threshold: 0.1 },
    });
    assert.equal(bad2.status, 400, '版本回归指标必须配 regress_by');

    // threshold ≤ 0 → 400
    const bad3 = await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST', token,
      body: { name: 'x', metric: 'versionP95Ms', operator: 'regress_by', threshold: 0 },
    });
    assert.equal(bad3.status, 400, '退化幅度阈值必须为正');
  });

  it('评估：新版本成功率相对旧版本退化超阈值 → firing，webhook 载荷携带 vA/vB/delta', async () => {
    const webhook = await startWebhookServer();
    const { baseUrl, token, collector } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { alerts: { evaluateIntervalMs: 3600_000, defaultWebhookUrl: webhook.url } },
    );
    await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST', token,
      body: { name: '版本成功率回归', metric: 'versionSuccessRate', operator: 'regress_by', threshold: 0.2, lookbackMs: 3600_000, cooldownMs: 0 },
    });

    const now = Date.now();
    // 旧版本 2.0.0：20 条成功（successRate=1）
    // 新版本 2.1.0：15 成功 + 5 失败（successRate=0.75 → 退化 0.25 > 0.2）
    const oldRuns = Array.from({ length: 20 }, (_, i) => ({
      ...makeRun(`old-${i}`, now - 60_000), appVersion: '2.0.0', status: 'success' as const,
    }));
    const newOk = Array.from({ length: 15 }, (_, i) => ({
      ...makeRun(`new-ok-${i}`, now - 59_000), appVersion: '2.1.0', status: 'success' as const,
    }));
    const newFail = Array.from({ length: 5 }, (_, i) => ({
      ...makeRun(`new-fail-${i}`, now - 58_999), appVersion: '2.1.0', status: 'error' as const, errorClass: 'validation',
    }));
    const ingest = await postIngest(baseUrl, APP_ID, APP_SECRET, [...oldRuns, ...newOk, ...newFail]);
    assert.equal(ingest, 200, '版本数据上报应成功');

    const transitions = await collector.alerts!.evaluateOnce();
    assert.equal(transitions, 1, '版本退化超阈值应触发 1 条规则');

    const events = await getJson(baseUrl, '/api/alerts/events', token);
    assert.equal(events.body.total, 1);
    assert.equal(events.body.items[0].status, 'fired');
    assert.ok(events.body.items[0].value < -0.2, '事件 value = delta（新-旧）≈ -0.25');

    assert.equal(webhook.posts.length, 1);
    assert.equal(webhook.posts[0].status, 'fired');
    assert.equal(webhook.posts[0].regression.vA, '2.1.0');
    assert.equal(webhook.posts[0].regression.vB, '2.0.0');
    assert.ok(webhook.posts[0].regression.delta < -0.2, 'webhook delta 与事件 value 一致');
  });

  it('冷启动防护：仅一个版本 / 任一侧请求量不足 → 不评估', async () => {
    const webhook = await startWebhookServer();
    const { baseUrl, token, collector } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { alerts: { evaluateIntervalMs: 3600_000, defaultWebhookUrl: webhook.url } },
    );
    await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST', token,
      body: { name: '版本成功率回归', metric: 'versionSuccessRate', operator: 'regress_by', threshold: 0.1, lookbackMs: 3600_000, cooldownMs: 0 },
    });

    const now = Date.now();
    // 仅一个版本（即使全失败）
    const only = await postIngest(
      baseUrl,
      APP_ID,
      APP_SECRET,
      Array.from({ length: 12 }, (_, i) => ({ ...makeRun(`only-${i}`, now - 60_000), appVersion: '3.0.0' })),
    );
    assert.equal(only, 200);
    assert.equal(await collector.alerts!.evaluateOnce(), 0, '窗口内不足两个版本不评估');

    // 第二个版本请求量不足（5 < MIN_VERSION_REQUESTS=10）
    const low = await postIngest(
      baseUrl,
      APP_ID,
      APP_SECRET,
      Array.from({ length: 5 }, (_, i) => ({ ...makeRun(`low-${i}`, now - 59_000), appVersion: '3.1.0', status: 'error' as const, errorClass: 'validation' })),
    );
    assert.equal(low, 200);
    assert.equal(await collector.alerts!.evaluateOnce(), 0, '任一侧请求量不足不评估');

    const events = await getJson(baseUrl, '/api/alerts/events', token);
    assert.equal(events.body.total, 0, '冷启动不产生事件');
    assert.equal(webhook.posts.length, 0, '冷启动不通知');
  });

  it('版本回归恢复：hotfix 发布后新版本指标回升 → recovered', async () => {
    const webhook = await startWebhookServer();
    const { baseUrl, token, collector } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { alerts: { evaluateIntervalMs: 3600_000, defaultWebhookUrl: webhook.url } },
    );
    await requestJson(baseUrl, '/api/alerts/rules', {
      method: 'POST', token,
      body: { name: '版本成功率回归', metric: 'versionSuccessRate', operator: 'regress_by', threshold: 0.2, lookbackMs: 3600_000, cooldownMs: 0 },
    });

    const now = Date.now();
    // 阶段一：2.1.0 相对 2.0.0 退化（0.5 vs 1）→ 触发
    await postIngest(baseUrl, APP_ID, APP_SECRET, [
      ...Array.from({ length: 20 }, (_, i) => ({ ...makeRun(`old-${i}`, now - 60_000), appVersion: '2.0.0' })),
      ...Array.from({ length: 10 }, (_, i) => ({ ...makeRun(`f-ok-${i}`, now - 59_000), appVersion: '2.1.0' })),
      ...Array.from({ length: 10 }, (_, i) => ({ ...makeRun(`f-fail-${i}`, now - 58_999), appVersion: '2.1.0', status: 'error' as const, errorClass: 'validation' })),
    ]);
    assert.equal(await collector.alerts!.evaluateOnce(), 1, '退化应触发');

    // 阶段二：hotfix 2.1.1（20 成功 2 失败 ≈ 0.909）成为最新 → 相对 2.1.0 不退化 → 恢复
    await postIngest(baseUrl, APP_ID, APP_SECRET, [
      ...Array.from({ length: 20 }, (_, i) => ({ ...makeRun(`fix-ok-${i}`, now - 30_000), appVersion: '2.1.1' })),
      ...Array.from({ length: 2 }, (_, i) => ({ ...makeRun(`fix-fail-${i}`, now - 29_999), appVersion: '2.1.1', status: 'error' as const, errorClass: 'validation' })),
    ]);
    await collector.alerts!.evaluateOnce();

    const events = await getJson(baseUrl, '/api/alerts/events', token);
    assert.equal(events.body.total, 2);
    assert.equal(events.body.items[0].status, 'recovered', '最新事件应为 recovered');
    assert.equal(webhook.posts.length, 2);
    assert.equal(webhook.posts[1].status, 'recovered');
    assert.equal(webhook.posts[1].regression.vA, '2.1.1', '恢复通知应携带修复后的版本对');
  });
});

// ─── P1 Prometheus / 限流 / 元信息 / TLS ──────────────────────────

/** POST /api/v1/ingest 并返回状态 + 响应头（供限流断言 Retry-After） */
async function postIngestWithHeaders(
  baseUrl: string,
  appId: string,
  appSecret: string,
): Promise<{ status: number; headers: Record<string, string | undefined> }> {
  const res = await fetch(`${baseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-id': appId, 'x-app-secret': appSecret },
    body: JSON.stringify({ appId, runs: [], spans: [], toolCalls: [], permissions: [] }),
  });
  const headers: Record<string, string | undefined> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers };
}

describe('P1-2 Prometheus 抓取端点', () => {
  it('/metrics/prometheus：无鉴权、text/plain version=0.0.4、含全局与 per-app 指标', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs.telemetry);
    await obs.close();

    // 无 token 直接抓取（设计上无鉴权）
    const res = await fetch(`${baseUrl}/metrics/prometheus`);
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') || '';
    assert.match(ct, /text\/plain/);
    assert.match(ct, /version=0\.0\.4/);
    const text = await res.text();

    // 全局指标
    assert.match(text, /^# HELP aipack_requests_total .*$/m);
    assert.match(text, /^# TYPE aipack_requests_total counter$/m);
    assert.match(text, /^aipack_requests_total 1$/m, '全局窗口应有 1 次请求');
    assert.match(text, /^aipack_success_ratio 1$/m);
    assert.match(text, /^aipack_p50_ms \d+(\.\d+)?$/m);

    // per-app 标签（种子应用 test-app）
    assert.match(text, /aipack_requests_total\{app_id="test-app"\} 1/);
  });
});

describe('P1-3 ingest 限流（per-app 令牌桶）', () => {
  it('超限返回 429 + Retry-After；令牌补充后恢复 200', async () => {
    const { baseUrl } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { rateLimit: { rate: 1, burst: 1 } },
    );

    // 第一次放行（桶初始满）
    const first = await postIngestWithHeaders(baseUrl, APP_ID, APP_SECRET);
    assert.equal(first.status, 200);
    // 第二次桶空 → 429 + Retry-After
    const second = await postIngestWithHeaders(baseUrl, APP_ID, APP_SECRET);
    assert.equal(second.status, 429);
    assert.equal(second.headers['retry-after'], '1');
    // 按 rate=1/s 补充 1 个令牌后恢复
    await sleep(1100);
    const third = await postIngestWithHeaders(baseUrl, APP_ID, APP_SECRET);
    assert.equal(third.status, 200);
  });

  it('限流不误伤其他应用（per-app 桶隔离）', async () => {
    const { baseUrl } = await startCollector(
      { [APP_ID]: APP_SECRET, 'app-2': 'secret-2' },
      { rateLimit: { rate: 1, burst: 1 } },
    );
    // app-1 占满自己的桶
    assert.equal((await postIngestWithHeaders(baseUrl, APP_ID, APP_SECRET)).status, 200);
    assert.equal((await postIngestWithHeaders(baseUrl, APP_ID, APP_SECRET)).status, 429);
    // app-2 不受影响
    assert.equal((await postIngestWithHeaders(baseUrl, 'app-2', 'secret-2')).status, 200);
  });
});

describe('P1-1 面板元信息 /api/meta', () => {
  it('配置 logStreamUrlTemplate 时返回模板；未配置时缺省', async () => {
    const { baseUrl, token } = await startCollector(
      { [APP_ID]: APP_SECRET },
      { logStreamUrlTemplate: 'https://loki.example.com/query?traceId=%s' },
    );
    const meta = await getJson(baseUrl, '/api/meta', token);
    assert.equal(meta.status, 200);
    assert.equal(meta.body.logStreamUrlTemplate, 'https://loki.example.com/query?traceId=%s');

    // 未配置模板的 collector → 字段缺省
    const plain = await startCollector();
    const meta2 = await getJson(plain.baseUrl, '/api/meta', plain.token);
    assert.equal(meta2.body.logStreamUrlTemplate, undefined);
  });

  it('/api/meta 需登录', async () => {
    const { baseUrl } = await startCollector();
    const res = await getJson(baseUrl, '/api/meta');
    assert.equal(res.status, 401);
  });
});

describe('P1-3 TLS（HTTPS 传输）', () => {
  it('createCollectorServer：无 tls → http；带 tls → https，且 HTTPS 上报/查询可用', async t => {
    // openssl 非常驻环境（如 Windows）跳过：证书生成是环境依赖，TLS 语义已在有 openssl 的平台覆盖
    let opensslOk = false;
    try {
      execFileSync('openssl', ['version'], { stdio: 'pipe' });
      opensslOk = true;
    } catch {
      // ENOENT / spawn 失败
    }
    if (!opensslOk) return t.skip('openssl 不可用，跳过 HTTPS 传输用例');

    const stores = buildStores();
    const collector = createCollector({
      apps: { [APP_ID]: APP_SECRET },
      admin: ADMIN,
      businessStores: stores.businessStores,
      traceStore: stores.traceStore,
    });

    // 无 tls → http.Server
    const plain = createCollectorServer(collector);
    assert.ok(plain instanceof http.Server);
    assert.ok(!(plain instanceof https.Server));
    await new Promise<void>((r) => plain.close(() => r()));

    // 自签证书 → https.Server（openssl 生成，macOS/Linux 自带）
    const dir = tempDir('obs-tls');
    const tls = makeSelfSignedCert(dir);
    const secured = createCollectorServer(collector, tls);
    assert.ok(secured instanceof https.Server);
    await new Promise<void>((r) => secured.listen(0, '127.0.0.1', r));
    const port = (secured.address() as AddressInfo).port;
    const baseUrl = `https://127.0.0.1:${port}`;

    // HTTPS 上报（自签证书 → rejectUnauthorized: false）
    const ingest = await httpsRequestJson(baseUrl, '/api/v1/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-app-id': APP_ID,
        'x-app-secret': APP_SECRET,
      },
      body: JSON.stringify({ appId: APP_ID, runs: [], spans: [], toolCalls: [], permissions: [] }),
    });
    assert.equal(ingest.status, 200, 'HTTPS ingest 应成功');

    // HTTPS 查询（面板登录 + summary）
    const login = await httpsRequestJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    assert.equal(login.status, 200);
    const summary = await httpsRequestJson(baseUrl, '/metrics/summary', {
      headers: { authorization: `Bearer ${login.body.token}` },
    });
    assert.equal(summary.status, 200);

    cleanup.push(async () => {
      await new Promise<void>((r) => secured.close(() => r()));
      await collector.close();
    });
  });
});

// ─── P1 测试辅助（openssl 自签证书 / HTTPS 请求）──────────────────

function makeSelfSignedCert(dir: string): { key: Buffer; cert: Buffer } {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'],
    { stdio: 'pipe' },
  );
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

function httpsRequestJson(
  baseUrl: string,
  urlPath: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      baseUrl + urlPath,
      {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        rejectUnauthorized: false, // 自签证书仅用于测试
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// ─── P2 自定义事件 / 重试明细 / 健康检查 / 会话持久化 ───────────────

describe('P2 自定义事件与重试明细', () => {
  it('emit 事件 + onRetry：/traces/:id 返回 events 时间轴与 retries 重试链', async () => {
    const { baseUrl, token } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    const result = await runOnce(obs.telemetry, { streamFn: retryStreamFn() });
    // run 结束后显式 emit（显式 traceId，等价 run 内自动注入上下文）
    obs.emit('user.input', { text: '你好，世界' }, { traceId: String(result.metadata.traceId), sessionKey: 'sess-1' });
    await obs.close();

    const detail = await getJson(baseUrl, `/traces/${result.metadata.traceId}`, token);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.events.length, 1);
    assert.equal(detail.body.events[0].name, 'user.input');
    assert.deepEqual(detail.body.events[0].data, { text: '你好，世界' });
    assert.equal(detail.body.events[0].sessionKey, 'sess-1');
    assert.equal(typeof detail.body.events[0].timestamp, 'number');

    assert.equal(detail.body.retries.length, 1, 'retryStreamFn 触发 1 次 onRetryAttempt');
    const r = detail.body.retries[0];
    assert.equal(r.attempt, 1);
    assert.equal(r.delayMs, 1);
    assert.ok(r.modelId, '重试记录应带 modelId');
    assert.equal(typeof r.timestamp, 'number');
  });

  it('Prometheus 输出 P2-2 重试指标：aipack_retries_total{status=} 与 aipack_retry_backoff_p50_ms', async () => {
    const { baseUrl } = await startCollector();
    const obs = createObservability({ appId: APP_ID, appSecret: APP_SECRET, endpoint: baseUrl, cacheDir: tempDir('obs-cache') });
    await runOnce(obs.telemetry, { streamFn: retryStreamFn() });
    await obs.close();

    const res = await fetch(`${baseUrl}/metrics/prometheus`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /^# HELP aipack_retries_total .*$/m);
    assert.match(text, /^# TYPE aipack_retries_total counter$/m);
    assert.match(text, /^# TYPE aipack_retry_backoff_p50_ms gauge$/m);
    // mock Error 无 HTTP status 属性 → 归入 'unknown'
    assert.match(text, /^aipack_retries_total\{status="unknown"\} 1$/m);
    assert.match(text, /^aipack_retry_backoff_p50_ms \d+(\.\d+)?$/m);
  });

  it('/healthz：无鉴权 200 {ok:true}', async () => {
    const { baseUrl } = await startCollector();
    const res = await fetch(`${baseUrl}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe('P2-3 会话持久化（SESSION_SECRET 无状态签名 token）', () => {
  /** 以同一组 store 启动 collector，返回 baseUrl + 关闭函数（模拟服务重启） */
  async function startWith(stores: ReturnType<typeof buildStores>, opts: { sessionSecret?: string }) {
    const collector = createCollector({
      apps: { [APP_ID]: APP_SECRET },
      admin: ADMIN,
      businessStores: stores.businessStores,
      traceStore: stores.traceStore,
      ...opts,
    });
    const server = http.createServer((req, res) => void collector.handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const close = async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await collector.close();
    };
    return { baseUrl: `http://127.0.0.1:${port}`, close };
  }

  it('配置 sessionSecret：重启后旧 token 仍有效（无需重新登录），篡改 token 被拒', async () => {
    const stores = buildStores();
    const secret = 'test-session-secret-0123456789abcdef';
    const a = await startWith(stores, { sessionSecret: secret });
    const loginRes = await fetch(`${a.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    assert.equal(loginRes.status, 200);
    const token = ((await loginRes.json()) as { token: string }).token;
    assert.equal((await getJson(a.baseUrl, '/api/auth/me', token)).status, 200, '签名 token 登录后应可用');
    await a.close();

    // 重启（同一组 store + 同一 secret）
    const b = await startWith(stores, { sessionSecret: secret });
    cleanup.push(() => b.close());
    const me = await getJson(b.baseUrl, '/api/auth/me', token);
    assert.equal(me.status, 200, '无状态签名 token 重启后应仍有效');
    assert.equal(me.body.username, ADMIN.username);

    // 篡改签名 → 验签失败
    const forged = await getJson(b.baseUrl, '/api/auth/me', `${token.slice(0, -2)}xx`);
    assert.equal(forged.status, 401, '篡改 token 应被拒');
  });

  it('未配置 sessionSecret：内存会话，重启后 token 失效（P1 行为回归）', async () => {
    const stores = buildStores();
    const a = await startWith(stores, {});
    const loginRes = await fetch(`${a.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ADMIN),
    });
    const token = ((await loginRes.json()) as { token: string }).token;
    await a.close();

    const b = await startWith(stores, {});
    cleanup.push(() => b.close());
    assert.equal((await getJson(b.baseUrl, '/api/auth/me', token)).status, 401, '内存会话重启后应失效');
  });
});

describe('P2 retention 覆盖新表（events/retry_attempts）', () => {
  it('prune 删除过期 events/retries，保留新明细', async () => {
    const store = new MemoryTraceStore();
    const now = Date.now();
    await store.flush(
      {
        runs: [makeRun('old', now - 40 * 86400_000), makeRun('new', now)],
        spans: [],
        toolCalls: [],
        permissions: [],
        events: [
          { traceId: 'old', name: 'evt-old', data: 'v', timestamp: now - 40 * 86400_000 },
          { traceId: 'new', name: 'evt-new', data: 'v', timestamp: now },
        ],
        retries: [
          { traceId: 'old', spanId: 'span-old', provider: 'deepseek', modelId: 'm', attempt: 1, status: 429, delayMs: 100, timestamp: now - 40 * 86400_000 },
          { traceId: 'new', spanId: 'span-new', provider: 'deepseek', modelId: 'm', attempt: 1, status: 429, delayMs: 100, timestamp: now },
        ],
      },
      APP_ID,
    );

    const cleared = await store.prune(now - 10 * 86400_000); // 保留 10 天
    assert.equal(cleared, 3, '应删除 1 run + 1 event + 1 retry');
    assert.equal(await store.queryTrace('old'), undefined, '过期 trace 应整体删除');

    const kept = await store.queryTrace('new');
    assert.ok(kept, '新 trace 应保留');
    assert.equal(kept.events.length, 1, '新 trace 的 events 应保留');
    assert.equal(kept.events[0].name, 'evt-new');
    assert.equal(kept.retries.length, 1, '新 trace 的 retries 应保留');
    assert.equal(kept.retries[0].status, 429);
  });
});
