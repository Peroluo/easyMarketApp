/**
 * packages/core/session.ts - 会话持久化契约层
 *
 * 定义会话存储的数据格式与适配器接口。
 * 实现（memory/file）位于 packages/session/，遵循单向依赖：session → core。
 *
 * 设计要点：
 * - 线性结构：messages 平铺 + 元数据（模型、用量），不做树形分支（YAGNI）
 * - version 字段预留兼容，未来结构升级可平滑迁移
 * - 存储接口仿 src/storage 的 adapter 模式，但不依赖 src/
 */

import type { Message, Usage } from './types';

/** 当前会话数据格式版本 */
export const SESSION_VERSION = 1;

/** 会话模型信息（最后使用的模型） */
export interface SessionModel {
  provider: string;
  modelId: string;
}

/** 持久化会话数据（线性结构） */
export interface StoredSession {
  key: string;
  version: number;
  /** 用户命名（/rename 设置）；缺省时消费方回退首条用户消息摘要 */
  title?: string;
  messages: Message[];
  model: SessionModel | null;
  usage: Usage;
  createdAt: string;
  updatedAt: string;
}

/** 跨进程锁句柄：调用方需在 finally 中 release() */
export interface StorageLock {
  release(): Promise<void>;
}

/** 会话存储适配器接口 */
export interface SessionStorage {
  load(key: string): Promise<StoredSession | null>;
  save(key: string, session: StoredSession): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<string[]>;
  /**
   * 跨进程互斥锁（可选）：fn 执行期间独占该 key 的"读-改-写"，
   * 防止多进程并发写同一会话导致 last-write-wins 丢消息。
   * 单进程存储（如内存实现）可省略；Runtime 在非 ephemeral 请求下自动调用。
   */
  withLock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** 手动锁（可选，供流式等无法用回调包住的场景）：finally 中 release() */
  acquireLock?(key: string): Promise<StorageLock>;
}

/** 文件存储选项 */
export interface FileSessionStorageOptions {
  /** 存储根目录，默认 <pwd>/.aipack/sessions */
  baseDir?: string;
  /** 过期时间（毫秒），超过 updatedAt 的会话在加载/列举时清理 */
  maxAge?: number;
  /** 持久化消息条数上限（保留最新 N 条，0 表示不限，默认 0） */
  maxStoredMessages?: number;
  /** 获取跨进程锁的最大等待时间（毫秒，默认 30000）。超时抛错 */
  lockWaitMs?: number;
  /** 锁文件视为"陈旧"的阈值（毫秒，默认 300000）。
   *  持有锁的进程崩溃后留下的锁文件在超过该时长后会被接管 */
  lockStaleMs?: number;
  /** 锁获取重试的基础间隔（毫秒，默认 25，指数退避至 500） */
  lockRetryMs?: number;
}

/** 内存存储选项 */
export interface MemorySessionStorageOptions {
  /** 过期时间（毫秒），超过 updatedAt 的会话在加载时清理 */
  maxAge?: number;
}
