/**
 * TokenMeter - token 计量
 *
 * 计量是所有压缩决策的地基，本实现解决旧 CharHeuristicEstimator 的四个问题：
 *
 * 1. 缓存正确性：旧实现以 resource.id 为缓存 key、靠散布各处的手动 invalidate()
 *    保正确（曾因此出现"截断循环永不生效"的事故）。新实现：
 *      - string content：按 (id, content.length) 校验，长度变化即失效；
 *        trim/normalize/替换等不可变更新全部改变长度，无需手动失效
 *      - 数组/对象 content：按 content 引用（WeakMap）校验，引用变化即失效
 * 2. 对象 content：旧实现 extractTextFromResource 对对象返回 ''，
 *    导致 compaction_summary（Message 对象）与 tool_call（args 对象）被估为 0 token。
 *    新实现对对象 content 用 JSON 序列化文本近似。
 * 3. 图片 token：旧实现 JSON.stringify 整个 content 后嗅探 "type":"image"（性能差，
 *    且每个图片固定 1500）。新实现仅扫描 ContentBlock[] 中的 image 块，块数可配置。
 * 4. 校准闭环：recordActualUsage 以前是死代码。ForkRunner 每次 fork 拿到真实
 *    usage.input 后自动回填，EMA 平滑修正系统性偏差。
 *
 * 真实 tokenizer 仍可注入（TokenizerLike），注入后启发式仅作 fallback。
 */

import type { ContextResource, ContentBlock } from '@aipack-ai/agent';

// ─── 接口 ─────────────────────────────────────────────────────────

export interface TokenEstimator {
  estimate(resource: ContextResource): number;
  estimateAll(resources: ContextResource[]): number;
  /** 纯文本估算（fork prompt 构建等场景） */
  estimateText(text: string): number;
  /** 使缓存失效（新缓存自带失效校验，一般无需调用） */
  invalidate(resourceId?: string): void;
  /**
   * 用真实 usage 回填校准比例（EMA 平滑）。
   * ForkRunner 在每次 fork 完成后自动调用。
   */
  recordActualUsage?(estimated: number, actual: number): void;
}

/** 可注入的真实 tokenizer（如 tiktoken） */
export interface TokenizerLike {
  encode(text: string): number[] | Uint32Array;
}

// ─── LRU（仅用于 string 缓存的容量上限） ───────────────────────────

class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

// ─── 实现 ─────────────────────────────────────────────────────────

export class TokenMeter implements TokenEstimator {
  /** string content 缓存：id → { content 长度, 未校准 token } */
  private strCache: LruCache<string, { len: number; tokens: number }>;
  /** 数组/对象 content 缓存：content 引用 → 未校准 token（引用即指纹） */
  private refCache = new WeakMap<object, number>();
  /** 真实 / 估算 比例（EMA 平滑），读时应用 */
  private calibrationRatio = 1;
  private calibrationSamples = 0;
  private tokenizer?: TokenizerLike;
  private readonly charsPerTokenAscii: number;
  private readonly charsPerTokenCJK: number;
  private readonly imageTokensPerBlock: number;

  constructor(options: {
    charsPerTokenAscii?: number;
    charsPerTokenCJK?: number;
    imageTokensPerBlock?: number;
    cacheCapacity?: number;
    tokenizer?: TokenizerLike;
  } = {}) {
    this.charsPerTokenAscii = options.charsPerTokenAscii ?? 4;
    this.charsPerTokenCJK = options.charsPerTokenCJK ?? 1.5;
    this.imageTokensPerBlock = options.imageTokensPerBlock ?? 1500;
    this.strCache = new LruCache<string, { len: number; tokens: number }>(
      Math.max(1, options.cacheCapacity ?? 1000),
    );
    this.tokenizer = options.tokenizer;
  }

  estimate(resource: ContextResource): number {
    const raw = this.estimateRaw(resource);
    return Math.ceil(raw * this.calibrationRatio);
  }

  estimateAll(resources: ContextResource[]): number {
    let sum = 0;
    for (const r of resources) sum += this.estimate(r);
    return sum;
  }

  estimateText(text: string): number {
    return Math.ceil(this.heuristic(text) * this.calibrationRatio);
  }

  invalidate(resourceId?: string): void {
    if (resourceId) this.strCache.delete(resourceId);
    else this.strCache.clear();
  }

  /**
   * 用真实 usage 回填校准比例。EMA（alpha=0.3）平滑，过滤 5 倍以上噪声。
   */
  recordActualUsage(estimated: number, actual: number): void {
    if (estimated <= 0 || actual <= 0) return;
    const ratio = actual / estimated;
    if (ratio > 5 || ratio < 0.2) return;
    if (this.calibrationSamples === 0) {
      this.calibrationRatio = ratio;
    } else {
      this.calibrationRatio = this.calibrationRatio * 0.7 + ratio * 0.3;
    }
    this.calibrationSamples++;
  }

  // ─── 内部 ───────────────────────────────────────────────────────

  /** 未校准估算，带契约安全缓存 */
  private estimateRaw(resource: ContextResource): number {
    const content = resource.content;

    // string：按 (id, length) 校验缓存
    if (typeof content === 'string') {
      const cached = this.strCache.get(resource.id);
      if (cached && cached.len === content.length) return cached.tokens;
      const tokens = this.heuristic(content);
      this.strCache.set(resource.id, { len: content.length, tokens });
      return tokens;
    }

    // 数组（ContentBlock[]）：按引用校验缓存；文本类块 + 图片块分开计
    if (Array.isArray(content)) {
      const cached = this.refCache.get(content);
      if (cached !== undefined) return cached;
      const tokens =
        this.heuristic(this.blockText(content)) +
        this.countImageBlocks(content) * this.imageTokensPerBlock;
      this.refCache.set(content, tokens);
      return tokens;
    }

    // 对象（Message / tool_call args 等）：JSON 序列化近似；按引用校验缓存
    if (content && typeof content === 'object') {
      const cached = this.refCache.get(content as object);
      if (cached !== undefined) return cached;
      let tokens = 0;
      try {
        tokens = this.heuristic(JSON.stringify(content));
      } catch {
        tokens = 0;
      }
      this.refCache.set(content as object, tokens);
      return tokens;
    }

    return 0;
  }

  private countImageBlocks(content: ContentBlock[]): number {
    let count = 0;
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'image') {
        count++;
      }
    }
    return count;
  }

  /**
   * 提取文本类块的文字（text + thinking）。
   * agent 包的 extractText 只取 text 块——thinking 块的 token 同样计入
   * 真实上下文，忽略它会导致"剥离 thinking 无收益"的误判。
   * （兼容 ai 体系 ThinkingContent 的 .thinking 字段名）
   */
  private blockText(content: ContentBlock[]): string {
    let out = '';
    for (const block of content) {
      if (block && typeof block === 'object') {
        const type = (block as { type?: string }).type;
        if (type === 'text' || type === 'thinking') {
          const b = block as { text?: string; thinking?: string };
          out += b.text ?? b.thinking ?? '';
        }
      }
    }
    return out;
  }

  private heuristic(text: string): number {
    if (!text) return 0;
    if (this.tokenizer) {
      try {
        return this.tokenizer.encode(text).length;
      } catch {
        // tokenizer 失败退回启发式
      }
    }
    let asciiChars = 0;
    let cjkChars = 0;
    for (const ch of text) {
      if (ch.charCodeAt(0) > 0x2e80) cjkChars++;
      else asciiChars++;
    }
    return Math.ceil(asciiChars / this.charsPerTokenAscii)
      + Math.ceil(cjkChars / this.charsPerTokenCJK);
  }
}

/** 工厂函数 */
export function createTokenEstimator(
  options: ConstructorParameters<typeof TokenMeter>[0] = {},
): TokenEstimator {
  return new TokenMeter(options);
}
