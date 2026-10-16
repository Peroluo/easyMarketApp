/**
 * 会话持久化（从 AgentRuntime 拆出）：
 * - 懒加载（hydrate）/整体保存（persist，含实时落盘 persistSafe）
 * - 存储级锁（读-改-写全程持锁，防多进程并发写丢消息）
 */

import type {
  Model,
  Message,
  AssistantMessage,
  Usage,
  Request,
  ResultChunk,
} from '../core';
import type {
  SessionStorage,
  StoredSession,
  SessionModel,
} from '../core';
import { SESSION_VERSION, createEmptyUsage } from '../core';
import type { SessionState } from './shared';
import type { SessionStore } from './session-store';

export class SessionPersistence {
  constructor(
    private readonly _storage: SessionStorage | undefined,
    /** 默认模型（deriveModel 兜底 provider） */
    private readonly _defaultModel: () => Model,
    private readonly _store: SessionStore,
  ) {}

  get storage(): SessionStorage | undefined {
    return this._storage;
  }

  /** 从存储懒加载会话（串行化后无竞态，每个会话仅恢复一次） */
  async hydrate(sessionKey: string, session: SessionState): Promise<void> {
    if (!this._storage) return;
    if (session.hydrated) return;
    session.hydrated = true;

    const stored = await this._storage.load(sessionKey);
    if (!stored) return;

    session.messages = stored.messages;
    session.createdAt = stored.createdAt;
    session.title = stored.title;
  }

  /** 整体保存指定会话（ephemeral 跳过；失败不影响运行结果） */
  async persist(sessionKey: string, session: SessionState): Promise<void> {
    if (!this._storage) return;

    const stored: StoredSession = {
      key: sessionKey,
      version: SESSION_VERSION,
      ...(session.title !== undefined ? { title: session.title } : {}),
      messages: session.messages,
      model: this.deriveModel(session.messages),
      usage: this.sumUsage(session.messages),
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this._storage.save(sessionKey, stored);
  }

  /**
   * 实时持久化指定会话：每轮 assistant 回复/工具结果完成后调用，
   * 让运行中的会话随时可被持久化数据观测到。ephemeral 跳过；
   * 存储失败仅告警，不影响对话循环继续。
   */
  async persistSafe(request: Request, sessionKey: string): Promise<void> {
    if (request.ephemeral || !this._storage) return;
    try {
      const session = this._store.peek(sessionKey);
      if (!session) return; // 会话已被淘汰/删除，跳过
      await this.persist(sessionKey, session);
    } catch (err) {
      console.warn('[Runtime] 会话持久化失败:', (err as Error)?.message);
    }
  }

  /** 从消息中推导最后使用的模型 */
  private deriveModel(messages: Message[]): SessionModel | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && (msg as AssistantMessage).model) {
        return {
          provider: (msg as AssistantMessage).provider ?? this._defaultModel().provider,
          modelId: (msg as AssistantMessage).model as string,
        };
      }
    }
    return null;
  }

  /** 汇总所有 assistant 消息的 token 用量（含 cache） */
  private sumUsage(messages: Message[]): Usage {
    const usage = createEmptyUsage();
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const u = (msg as AssistantMessage).usage;
        if (u) {
          usage.input += u.input;
          usage.output += u.output;
          usage.total += u.total;
          usage.cacheRead = (usage.cacheRead ?? 0) + (u.cacheRead ?? 0);
          usage.cacheWrite = (usage.cacheWrite ?? 0) + (u.cacheWrite ?? 0);
          usage.reasoning = (usage.reasoning ?? 0) + (u.reasoning ?? 0);
        }
      }
    }
    return usage;
  }

  /**
   * 非 ephemeral 请求在"读(load)-改(run)-写(save)"全程持有存储级锁，
   * 防止多进程并发写同一会话导致 last-write-wins 丢消息。
   * ephemeral / 无锁支持 / 无存储时直接执行。
   */
  async withStorageLock<T>(
    request: Request,
    sessionKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (request.ephemeral || !this._storage?.withLock) return fn();
    return this._storage.withLock(sessionKey, fn);
  }

  /** 流式版本：无法用回调包住生成器，改用手动锁（acquire/release） */
  async *streamWithStorageLock(
    request: Request,
    sessionKey: string,
    gen: () => AsyncGenerator<ResultChunk>,
  ): AsyncGenerator<ResultChunk> {
    if (request.ephemeral || !this._storage?.acquireLock) {
      yield* gen();
      return;
    }
    const lock = await this._storage.acquireLock(sessionKey);
    try {
      yield* gen();
    } finally {
      await lock.release();
    }
  }
}
