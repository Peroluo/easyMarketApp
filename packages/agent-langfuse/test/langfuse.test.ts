/**
 * LangfuseTransport 测试（离线：注入 fake Langfuse client）
 * - root → trace（sessionKey → sessionId 映射）
 * - tool 子 run → TOOL（tool-create 事件）；llm 子 run → generation（tokens → usage）
 * - 错误 → level ERROR + statusMessage
 * - 缺凭据且未注入 client 时抛错
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LangfuseTransport } from '../index.js';
import type { Langfuse } from 'langfuse';

interface Recorded {
  calls: Array<{ method: string; body: Record<string, unknown> }>;
}

function makeFakeLangfuse(): { client: Langfuse; rec: Recorded } {
  const rec: Recorded = { calls: [] };

  // 核心客户端：tool-create 经 protected enqueue 直发，fake 记录原始事件
  const core = {
    enqueue: (type: string, body: Record<string, unknown>) => {
      rec.calls.push({ method: type, body });
    },
  };

  const makeObservation = (
    kind: 'span' | 'generation',
    ctx: { traceId: string; observationId: string | null },
  ) => {
    const obs = {
      // SDK LangfuseObjectClient 的公共字段：transport 依赖其定位父子关系
      client: core,
      id: ctx.observationId,
      traceId: ctx.traceId,
      observationId: ctx.observationId,
      update: (body: Record<string, unknown>) => {
        rec.calls.push({ method: `${kind}.update`, body });
        return obs;
      },
      end: (body?: Record<string, unknown>) => {
        rec.calls.push({ method: `${kind}.end`, body: body ?? {} });
        return obs;
      },
      span: (body: Record<string, unknown>) => {
        rec.calls.push({ method: 'span', body });
        return makeObservation('span', {
          traceId: ctx.traceId,
          observationId: (body.id as string) ?? 'obs-span',
        });
      },
      generation: (body: Record<string, unknown>) => {
        rec.calls.push({ method: 'generation', body });
        return makeObservation('generation', {
          traceId: ctx.traceId,
          observationId: (body.id as string) ?? 'obs-gen',
        });
      },
      event: () => obs,
      score: () => obs,
      getTraceUrl: () => 'http://x',
    };
    return obs;
  };

  const client = {
    trace: (body: Record<string, unknown>) => {
      rec.calls.push({ method: 'trace', body });
      return makeObservation('span', { traceId: (body.id as string) ?? 'trace-x', observationId: null });
    },
    flushAsync: async () => undefined,
  } as unknown as Langfuse;

  return { client, rec };
}

describe('LangfuseTransport', () => {
  it('缺凭据且未注入 client 时抛错', () => {
    const prevPk = process.env.LANGFUSE_PUBLIC_KEY;
    const prevSk = process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    assert.throws(() => new LangfuseTransport(), /LANGFUSE_PUBLIC_KEY/);
    if (prevPk !== undefined) process.env.LANGFUSE_PUBLIC_KEY = prevPk;
    if (prevSk !== undefined) process.env.LANGFUSE_SECRET_KEY = prevSk;
  });

  it('root → trace（sessionKey → sessionId），tool → span，llm → generation（usage 映射）', async () => {
    const { client, rec } = makeFakeLangfuse();
    const transport = new LangfuseTransport({ client });

    const root = transport.createRoot({
      id: 'run-1',
      name: 'aipack.demo',
      run_type: 'chain',
      inputs: { message: 'hi' },
      start_time: 1_000,
      extra: { metadata: { traceId: 'trace-1', sessionKey: 'default' } },
    });
    const tool = root.createChild({
      id: 'tool-1',
      name: 'get_weather',
      run_type: 'tool',
      inputs: { city: '上海' },
      start_time: 1_010,
      extra: { metadata: { spanId: 'span-tool-1' } },
    });
    const llm = root.createChild({
      id: 'llm-1',
      name: 'demo-mock',
      run_type: 'llm',
      inputs: { messages: [] },
      start_time: 1_020,
      extra: { metadata: { spanId: 'span-model-1' } },
    });

    await tool.end({ content: 'ok' }, undefined, 1_050);
    await llm.end(
      { input_tokens: 100, output_tokens: 50 },
      undefined,
      1_060,
    );
    await root.end({ output: 'done' }, undefined, 1_100, { tokens: {} });
    await transport.flush();

    const trace = rec.calls.find(c => c.method === 'trace');
    assert.ok(trace);
    assert.equal(trace.body.id, 'run-1');
    assert.equal(trace.body.sessionId, 'default');
    assert.equal(trace.body.name, 'aipack.demo');

    assert.ok(rec.calls.some(c => c.method === 'tool-create' && c.body.id === 'tool-1'));
    assert.ok(rec.calls.some(c => c.method === 'generation' && c.body.id === 'llm-1'));

    // tool：一次性完整 TOOL 事件（v4 tool-create）
    const toolCreate = rec.calls.find(c => c.method === 'tool-create') as {
      body: Record<string, unknown>;
    };
    assert.ok(toolCreate);
    assert.equal(toolCreate.body.traceId, 'run-1');
    assert.equal(toolCreate.body.parentObservationId, undefined); // 挂在 trace 根下
    assert.equal(toolCreate.body.name, 'get_weather');
    assert.deepEqual(toolCreate.body.input, { city: '上海' });
    assert.deepEqual(toolCreate.body.output, { content: 'ok' });
    assert.equal((toolCreate.body.startTime as Date).getTime(), 1010);
    assert.equal((toolCreate.body.endTime as Date).getTime(), 1050);
    assert.equal(toolCreate.body.level, undefined);

    const genUpdate = rec.calls.find(c => c.method === 'generation.update') as {
      body: Record<string, unknown>;
    };
    assert.ok(genUpdate);
    assert.deepEqual(genUpdate.body.usage, { input: 100, output: 50, total: 150 });
    assert.deepEqual(genUpdate.body.output, {}); // tokens 已从 outputs 移入 usage
  });

  it('错误 run：level ERROR + statusMessage', async () => {
    const { client, rec } = makeFakeLangfuse();
    const transport = new LangfuseTransport({ client });

    const root = transport.createRoot({
      id: 'run-err',
      name: 'aipack.demo',
      run_type: 'chain',
      inputs: {},
      extra: { metadata: {} },
    });
    const tool = root.createChild({
      id: 'tool-err',
      name: 'boom_tool',
      run_type: 'tool',
      extra: { metadata: {} },
    });
    await tool.end({}, 'tool crashed', Date.now());
    await flush();

    const toolCreate = rec.calls.find(c => c.method === 'tool-create') as {
      body: Record<string, unknown>;
    };
    assert.ok(toolCreate);
    assert.equal(toolCreate.body.level, 'ERROR');
    assert.equal(toolCreate.body.statusMessage, 'tool crashed');
  });
});

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
