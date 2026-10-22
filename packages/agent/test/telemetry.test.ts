/**
 * Telemetry 可观测性测试：onRunEnd / onToolCall / onModelCall 触发与容错
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../runtime/index.ts';
import { createRequest } from '../core/index.ts';
import type {
  StreamFn,
  StreamEvent,
  Message,
  AssistantMessage,
  Tool,
} from '../core/index.ts';

// ─── mock streamFn ────────────────────────────────────────────────

function mockStreamFn(messages: Message[]): StreamFn {
  return async function* (): AsyncGenerator<StreamEvent> {
    for (const msg of messages) {
      yield { type: 'done', message: msg as AssistantMessage };
    }
  };
}

function assistant(text: string, usage?: { input: number; output: number }): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: usage?.input ?? 10, output: usage?.output ?? 5, total: (usage?.input ?? 10) + (usage?.output ?? 5) },
    timestamp: Date.now(),
  };
}

const echoTool: Tool = {
  name: 'echo',
  description: '回显参数',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
  execute: async (id, args) => ({ content: [{ type: 'text', text: String((args as any)?.msg ?? '') }] }),
};

// ─── onRunEnd ─────────────────────────────────────────────────────

describe('Telemetry: onRunEnd', () => {
  it('run 成功后触发，携带 request/durationMs/result', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello')]),
      telemetry: { onRunEnd },
    });

    const result = await runtime.run(createRequest('hi'));
    assert.equal(result.success, true);
    assert.equal(onRunEnd.mock.callCount(), 1);
    const info = onRunEnd.mock.calls[0].arguments[0];
    assert.equal(info.sessionKey, 'default');
    assert.ok(info.durationMs >= 0);
    assert.equal(info.result.success, true);
    assert.equal(info.request.message, 'hi');
  });

  it('run 失败（工具抛错被 catch）仍触发 onRunEnd', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const badTool: Tool = {
      name: 'boom',
      description: '总是抛错',
      inputSchema: { type: 'object' },
      execute: async () => {
        throw new Error('boom');
      },
    };
    const streamFn = mockToolStreamFn();
    const runtime = createRuntime({
      streamFn,
      tools: [badTool],
      telemetry: { onRunEnd },
    });

    await runtime.run(createRequest('go'));
    assert.equal(onRunEnd.mock.callCount(), 1);
  });

  it('遥测回调抛错不阻断主流程', async () => {
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello')]),
      telemetry: {
        onRunEnd: () => {
          throw new Error('telemetry broken');
        },
      },
    });

    const result = await runtime.run(createRequest('hi'));
    assert.equal(result.success, true, '遥测失败不应影响 run 结果');
  });

  it('run 成功时 errorClass 只看最后一条 assistant（会话历史中的旧模型错误不误判成功率）', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const authErrorMsg: AssistantMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: '[auth] 401 认证失败',
      timestamp: Date.now(),
    };
    // 队列：第一次 run 报错（auth 错误进入会话历史），第二次 run 正常回复（同会话继续）
    const queue: AssistantMessage[][] = [[authErrorMsg], [assistant('ok')]];
    const runtime = createRuntime({
      streamFn: () => (async function* (): AsyncGenerator<StreamEvent> {
        for (const m of queue.shift() ?? []) {
          yield { type: 'done', message: m as AssistantMessage };
        }
      })(),
      telemetry: { onRunEnd },
    });

    // 第一次 run：最后一条 assistant 即 auth 错误 → success=false、errorClass=auth
    const r1 = await runtime.run(createRequest('hi'));
    assert.equal(r1.success, false);
    assert.equal(onRunEnd.mock.calls[0].arguments[0].errorClass, 'auth');

    // 第二次 run：会话历史残留 [auth] 错误，但本次最后一条 assistant 正常
    // → success=true 且 errorClass=undefined（修复前会误判为 'auth'，成功率恒 0）
    const r2 = await runtime.run(createRequest('hi again'));
    assert.equal(r2.success, true);
    assert.equal(onRunEnd.mock.calls[1].arguments[0].success, true);
    assert.equal(onRunEnd.mock.calls[1].arguments[0].errorClass, undefined);
  });
  it('run 未显式指定 model 时补实际模型（模型排行不落入 unknown）', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const runtime = createRuntime({
      model: {
        id: 'deepseek-test',
        name: 'test',
        provider: 'test',
        contextWindow: 8192,
        maxTokens: 2048,
        reasoning: false,
      },
      streamFn: mockStreamFn([assistant('hello')]),
      telemetry: { onRunEnd },
    });

    // 未指定 model → 补 runtime 实际模型
    await runtime.run(createRequest('hi'));
    assert.equal(onRunEnd.mock.calls[0].arguments[0].request.model, 'deepseek-test');

    // 显式指定 model → 优先保留请求指定值
    await runtime.run(createRequest('hi', { model: 'custom-model' }));
    assert.equal(onRunEnd.mock.calls[1].arguments[0].request.model, 'custom-model');
  });
});

// ─── onToolCall ───────────────────────────────────────────────────

describe('Telemetry: onToolCall', () => {
  it('工具执行后触发，携带 toolName/args/durationMs/result', async () => {
    const onToolCall = mock.fn(() => undefined);
    const runtime = createRuntime({
      permissionFailOpen: true,
      streamFn: mockToolStreamFn(),
      tools: [echoTool],
      telemetry: { onToolCall },
    });

    const result = await runtime.run(createRequest('请回显 foo'));
    assert.equal(result.success, true);
    assert.equal(onToolCall.mock.callCount(), 1);
    const info = onToolCall.mock.calls[0].arguments[0];
    assert.equal(info.toolName, 'echo');
    assert.deepEqual(info.args, { msg: 'foo' });
    assert.ok(info.durationMs >= 0);
    assert.equal(info.result.content[0].text, 'foo');
  });
});

// ─── onModelCall ──────────────────────────────────────────────────

describe('Telemetry: onModelCall', () => {
  it('模型调用后触发，携带 token 用量与耗时', async () => {
    const onModelCall = mock.fn(() => undefined);
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello', { input: 33, output: 7 })]),
      telemetry: { onModelCall },
    });

    await runtime.run(createRequest('hi'));
    assert.equal(onModelCall.mock.callCount(), 1);
    const info = onModelCall.mock.calls[0].arguments[0];
    assert.equal(info.inputTokens, 33);
    assert.equal(info.outputTokens, 7);
    assert.ok(info.durationMs >= 0);
  });
});

// ─── S1: traceId 关联 ─────────────────────────────────────────────

describe('Telemetry: S1 traceId 关联', () => {
  it('runStart 与 runEnd 的 traceId 一致，且写入 Result.metadata', async () => {
    const ids: string[] = [];
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello')]),
      telemetry: {
        onRunStart: (i) => ids.push(i.traceId),
        onRunEnd: (i) => ids.push(i.traceId),
      },
    });

    const result = await runtime.run(createRequest('hi'));
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.equal(result.metadata.traceId, ids[0]);
  });

  it('traceIdGenerator 注入时使用确定性 id', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello')]),
      traceIdGenerator: () => 'fixed-trace',
      telemetry: { onRunEnd },
    });

    await runtime.run(createRequest('hi'));
    assert.equal(onRunEnd.mock.calls[0].arguments[0].traceId, 'fixed-trace');
  });
});

// ─── S1: step 长度与工具状态 ──────────────────────────────────────

describe('Telemetry: S1 turnCount / 工具状态', () => {
  it('工具循环 2 轮上报 turnCount=2', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const runtime = createRuntime({
      permissionFailOpen: true,
      streamFn: mockToolStreamFn(),
      tools: [echoTool],
      telemetry: { onRunEnd },
    });

    await runtime.run(createRequest('请回显 foo'));
    assert.equal(onRunEnd.mock.callCount(), 1);
    assert.equal(onRunEnd.mock.calls[0].arguments[0].turnCount, 2);
  });

  it('onToolCall 携带 success=true / status=ok / traceId / spanId', async () => {
    const onToolCall = mock.fn(() => undefined);
    const runtime = createRuntime({
      permissionFailOpen: true,
      streamFn: mockToolStreamFn(),
      tools: [echoTool],
      telemetry: { onToolCall },
    });

    await runtime.run(createRequest('请回显 foo'));
    const info = onToolCall.mock.calls[0].arguments[0];
    assert.equal(info.success, true);
    assert.equal(info.status, 'ok');
    assert.ok(info.traceId);
    assert.ok(info.spanId);
  });

  it('工具抛错时 onToolCall status=error / success=false / errorClass=tool_error', async () => {
    const onToolCall = mock.fn(() => undefined);
    const throwingTool: Tool = {
      name: 'echo',
      description: '总是抛错',
      inputSchema: { type: 'object' },
      execute: async () => {
        throw new Error('boom');
      },
    };
    const runtime = createRuntime({
      permissionFailOpen: true,
      streamFn: mockToolStreamFn(),
      tools: [throwingTool],
      telemetry: { onToolCall },
    });

    await runtime.run(createRequest('请回显 foo'));
    const info = onToolCall.mock.calls[0].arguments[0];
    assert.equal(info.status, 'error');
    assert.equal(info.success, false);
    assert.equal(info.errorClass, 'tool_error');
  });

  it('权限拒绝时 onPermissionDenied 携带 traceId', async () => {
    const denied = mock.fn(() => undefined);
    const runtime = createRuntime({
      permissionFailOpen: true,
      streamFn: mockToolStreamFn(),
      tools: [echoTool],
      permissionPolicy: { check: async () => 'deny' },
      telemetry: { onPermissionDenied: denied },
    });

    await runtime.run(createRequest('请回显 foo'));
    assert.equal(denied.mock.callCount(), 1);
    assert.ok(denied.mock.calls[0].arguments[0].traceId);
  });
});

// ─── S1: 重试次数 ─────────────────────────────────────────────────

describe('Telemetry: S1 重试次数', () => {
  it('provider 内部重试：attempts=2 且 onRetry 触发一次', async () => {
    const onModelCall = mock.fn(() => undefined);
    const onRetry = mock.fn(() => undefined);
    const runtime = createRuntime({
      streamFn: retryStreamFn(),
      telemetry: { onModelCall, onRetry },
    });

    await runtime.run(createRequest('hi'));
    assert.equal(onModelCall.mock.callCount(), 1);
    assert.equal(onModelCall.mock.calls[0].arguments[0].attempts, 2);
    assert.equal(onRetry.mock.callCount(), 1);
    const retry = onRetry.mock.calls[0].arguments[0];
    assert.equal(retry.attempt, 1);
    assert.equal(retry.willRetry, true);
    assert.ok(retry.traceId);
    assert.equal(retry.modelId, 'unknown');
  });
});

// ─── S1: 流式路径 ─────────────────────────────────────────────────

describe('Telemetry: S1 流式路径', () => {
  it('stream() 触发 onRunStart/onRunEnd/onModelCall，traceId 一致且 stream=true', async () => {
    const onRunStart = mock.fn(() => undefined);
    const onRunEnd = mock.fn(() => undefined);
    const onModelCall = mock.fn(() => undefined);
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello', { input: 11, output: 3 })]),
      telemetry: { onRunStart, onRunEnd, onModelCall },
    });

    const chunks: string[] = [];
    for await (const chunk of runtime.stream(createRequest('hi'))) {
      chunks.push(chunk.type);
    }
    assert.ok(chunks.includes('done'));
    assert.equal(onRunStart.mock.callCount(), 1);
    assert.equal(onRunEnd.mock.callCount(), 1);
    assert.equal(onModelCall.mock.callCount(), 1);
    assert.equal(onModelCall.mock.calls[0].arguments[0].stream, true);
    assert.equal(
      onRunStart.mock.calls[0].arguments[0].traceId,
      onRunEnd.mock.calls[0].arguments[0].traceId,
    );
  });

  it('流式上报 ttftMs（首 token 延迟）', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const runtime = createRuntime({
      streamFn: async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', delta: 'hel' };
        yield { type: 'done', message: assistant('hello') };
      },
      telemetry: { onRunEnd },
    });

    for await (const _chunk of runtime.stream(createRequest('hi'))) {
      /* 排空 */
    }
    const info = onRunEnd.mock.calls[0].arguments[0];
    assert.ok(typeof info.ttftMs === 'number');
  });
});

// ─── S1: 校验失败与成本 ───────────────────────────────────────────

describe('Telemetry: S1 校验失败 / 成本', () => {
  it('空 message 触发 onRunEnd errorClass=validation', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello')]),
      telemetry: { onRunEnd },
    });

    await runtime.run(createRequest(''));
    assert.equal(onRunEnd.mock.callCount(), 1);
    const info = onRunEnd.mock.calls[0].arguments[0];
    assert.equal(info.success, false);
    assert.equal(info.errorClass, 'validation');
  });

  it('token 用量透传到 onModelCall.inputTokens/outputTokens 与 onRunEnd.tokens', async () => {
    const onModelCall = mock.fn(() => undefined);
    const onRunEnd = mock.fn(() => undefined);
    const msg = assistant('hello');
    msg.usage = { ...msg.usage!, input: 100, output: 200, total: 300, cacheRead: 10 };
    const runtime = createRuntime({
      streamFn: mockStreamFn([msg]),
      telemetry: { onModelCall, onRunEnd },
    });

    await runtime.run(createRequest('hi'));
    assert.equal(onModelCall.mock.calls[0].arguments[0].inputTokens, 100);
    assert.equal(onModelCall.mock.calls[0].arguments[0].outputTokens, 200);
    assert.deepEqual(onRunEnd.mock.calls[0].arguments[0].tokens, {
      input: 100,
      output: 200,
      cacheRead: 10,
      cacheWrite: undefined,
    });
  });
});

// ─── 辅助 ─────────────────────────────────────────────────────────

/** 第一轮返回工具调用，后续返回纯文本 */
function mockToolStreamFn(): StreamFn {
  let called = 0;
  return async function* (): AsyncGenerator<StreamEvent> {
    called += 1;
    if (called === 1) {
      const toolCall: AssistantMessage = {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'echo',
            arguments: { msg: 'foo' },
          },
        ],
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
  return async function* (
    _model,
    _context,
    options,
  ): AsyncGenerator<StreamEvent> {
    options?.onRetryAttempt?.({ attempt: 1, error: new Error('boom'), delayMs: 1 });
    yield { type: 'done', message: assistant('recovered') };
  };
}

// ─── ExtensionContext.telemetry 访问器 ─────────────────────────────

describe('Telemetry: Extension 包装（ExtensionContext.telemetry）', () => {
  it('Extension 可在 apply 阶段包装底层 Telemetry，后续事件流向包装层且原实现仍被转发', async () => {
    const onRunEnd = mock.fn(() => undefined);
    const wrapper = {
      name: 'telemetry-wrapper',
      apply(
        _hooks: unknown,
        context: {
          telemetry?: {
            get(): unknown;
            set(next: unknown): void;
          };
        },
      ) {
        const original = context.telemetry!.get() as {
          onRunEnd?: (info: Record<string, unknown>) => void;
        };
        context.telemetry!.set({
          onRunEnd: (info: Record<string, unknown>) => {
            info.wrapped = true;
            original?.onRunEnd?.(info);
          },
        });
      },
    };

    const runtime = createRuntime({
      streamFn: mockStreamFn([assistant('hello')]),
      telemetry: { onRunEnd },
      extensions: [wrapper],
    });

    await runtime.run(createRequest('hi'));
    assert.equal(onRunEnd.mock.callCount(), 1);
    const info = onRunEnd.mock.calls[0].arguments[0] as Record<string, unknown>;
    assert.equal(info.wrapped, true);
    assert.equal(info.sessionKey, 'default');
  });
});
