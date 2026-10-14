/**
 * ContextBudget - 统一 token 预算模型
 *
 * 所有压缩决策都基于"有效预算"而非裸 contextWindow：
 *
 *   effectiveBudget = contextWindow - outputReserve - safetyMargin
 *
 *     - outputReserve：为模型回复预留的输出 token（默认取 model.maxTokens）。
 *       旧实现以整个 contextWindow 为界，压到 95% 时模型一个输出 token 都放不下，
 *       provider 直接报错。
 *     - safetyMargin：估算误差缓冲（估算器是启发式，偏差可达 10-30%）。
 *
 * 双水位（hysteresis）：
 *
 *   precompress  effective × 0.70  低预警线：后台预压缩启动（不阻塞请求）
 *   trigger      effective × 0.80  高水位：触发同步压缩
 *   target       effective × 0.40  低水位：一次压缩到位，摊薄未来多个 turn
 *   hardLimit    effective × 1.00  硬上限：truncate 兜底线，超过即发出耗尽事件
 *
 * 高低水位的间距防止"每 turn 反复触发 fork"：一次压缩到低水位后，
 * 会话还能增长 (trigger - target) 的 token 才会再次付费。
 */

export interface BudgetConfig {
  /** 为模型输出预留的 token；缺省由 transformer 用 model.maxTokens 填充 */
  outputReserveTokens?: number;
  /** 相对 contextWindow 的额外安全边距比例（估算误差缓冲），默认 0.05 */
  safetyMarginRatio: number;
  /** 高水位：达到 effective × triggerRatio 触发压缩，默认 0.8 */
  triggerRatio: number;
  /** 低水位：压缩目标 effective × targetRatio，默认 0.4 */
  targetRatio: number;
  /** 预压缩触发线 effective × precompressRatio，默认 0.7；须 < triggerRatio */
  precompressRatio: number;
}

export class ContextBudget {
  /** 有效预算 = contextWindow - 输出预留 - 安全边距 */
  readonly effective: number;
  private readonly cfg: BudgetConfig;

  constructor(contextWindow: number, cfg: BudgetConfig) {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      throw new Error(
        `[aipack-compression] Invalid contextWindow: ${contextWindow}. Must be a positive finite number.`,
      );
    }
    const reserve = Math.max(0, cfg.outputReserveTokens ?? 0);
    const margin = Math.max(0, Math.floor(contextWindow * cfg.safetyMarginRatio));
    this.effective = Math.max(1, contextWindow - reserve - margin);
    this.cfg = cfg;
  }

  /** 高水位 token（触发同步压缩） */
  get triggerTokens(): number {
    return this.effective * this.cfg.triggerRatio;
  }

  /** 低水位 token（压缩目标） */
  get targetTokens(): number {
    return this.effective * this.cfg.targetRatio;
  }

  /** 预压缩触发 token（后台摘要启动线） */
  get precompressTokens(): number {
    return this.effective * this.cfg.precompressRatio;
  }

  /** 硬上限 token（truncate 兜底线） */
  get hardLimitTokens(): number {
    return this.effective;
  }

  /** 达到预压缩区间（>= precompress 且 < trigger） */
  shouldPrecompress(tokens: number): boolean {
    return tokens >= this.precompressTokens && tokens < this.triggerTokens;
  }

  /** 达到高水位（需同步压缩） */
  shouldCompact(tokens: number): boolean {
    return tokens >= this.triggerTokens;
  }

  /** 已压到低水位（压缩目标达成） */
  reachedTarget(tokens: number): boolean {
    return tokens <= this.targetTokens;
  }

  /** 超过硬上限（truncate 后仍超 → 发出耗尽事件） */
  overHardLimit(tokens: number): boolean {
    return tokens > this.hardLimitTokens;
  }
}
