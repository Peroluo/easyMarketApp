/**
 * TrimStrategy - 无损裁剪策略
 *
 * 三个操作（每个资源依次尝试，tail → head 扫描，释放够即停）：
 *   1. stripThinking：剥离 assistant_message 的 thinking 块
 *   2. trimToolResults：tool_result 按 token 预算裁剪
 *   3. normalizeWhitespace：合并多余空白
 *
 * 与 v1（L1）的关键差异：
 *   - 前缀保护：v1 对全量资源 map（含最老前缀），声称"cache 安全"却打碎整个
 *     KV cache 前缀。v2 tail-first 扫描、释放够即停，未触及的前缀原样保留，
 *     prefixIntact 如实上报保持边界。
 *   - 按 token 而非行数裁剪：v1 `lines.length <= 50` 直接跳过，
 *     minified JSON / base64 等单行巨型输出完全绕过（恰恰是最常见的巨型结果）。
 *     v2 先按 token 判定超预算，行级裁剪后仍超则字符级截断。
 */

import type { ContextResource, ContentBlock } from '@aipack-ai/agent';
import type { CompressionStrategy, StrategyContext, StrategyResult } from '../strategy';
import { noopResult, resourceText } from '../strategy';
import type { CompressionTelemetry } from '../telemetry';
import { createTelemetry } from '../telemetry';

/** 单行超长内容截断的最大迭代次数（×0.8 逐步收缩） */
const MAX_TRUNCATE_ITERATIONS = 8;

export class TrimStrategy implements CompressionStrategy {
  readonly name = 'trim' as const;

  async compress(ctx: StrategyContext): Promise<StrategyResult> {
    const cfg = ctx.config.trim;
    if (!cfg.enabled) return noopResult(ctx.resources);

    const target = ctx.budget.targetTokens;
    const beforeTokens = ctx.meter.estimateAll(ctx.resources);
    if (beforeTokens <= target) return noopResult(ctx.resources);

    let freed = 0;
    const tokensToFree = beforeTokens - target;
    const result = [...ctx.resources];
    let prefixIntact = result.length;
    const affected = new Set<string>();

    // tail → head：只动需要动的部分，保住前缀（KV cache）
    for (let i = result.length - 1; i >= 0 && freed < tokensToFree; i--) {
      const r = result[i];
      if (r.pinned) continue;
      if (r.type === 'system_message' || r.type === 'state_snapshot' || r.type === 'compaction_summary') {
        continue;
      }

      let res = r;

      if (cfg.stripThinking && res.type === 'assistant_message') {
        res = this.stripThinking(res);
      }

      if (cfg.trimToolResults && res.type === 'tool_result') {
        res = this.trimToolResult(res, cfg, ctx);
      }

      if (cfg.normalizeWhitespace && res !== r) {
        // 仅对本次已修改的资源顺带做空白规范化（不再单独扫前缀）
        res = this.normalizeWhitespace(res);
      }

      if (res !== r) {
        freed += ctx.meter.estimate(r) - ctx.meter.estimate(res);
        result[i] = res;
        prefixIntact = i;
        affected.add(r.id);
      }
    }

    if (affected.size === 0) return noopResult(ctx.resources);

    const afterTokens = ctx.meter.estimateAll(result);
    const telemetry: CompressionTelemetry[] = [
      createTelemetry('trim', 'trim_lossless', beforeTokens, afterTokens, {
        sessionKey: ctx.sessionKey,
        turn: ctx.turn,
        resourcesAffected: affected.size,
        prefixIntact,
        message: freed < tokensToFree
          ? `freed ${freed}/${tokensToFree} target tokens`
          : undefined,
      }),
    ];
    return { resources: result, telemetry, prefixIntact };
  }

  // ─── 操作 1：剥离 thinking 块 ───────────────────────────────────

  private stripThinking(r: ContextResource): ContextResource {
    const content = r.content;
    if (!Array.isArray(content)) return r;
    const filtered = (content as ContentBlock[]).filter(b => !b || (b as { type?: string }).type !== 'thinking');
    if (filtered.length === (content as ContentBlock[]).length) return r;
    return { ...r, content: filtered };
  }

  // ─── 操作 2：tool_result 按 token 预算裁剪 ───────────────────────

  /**
   * 按 token 预算裁剪 tool_result（修复 v1 行数判定漏掉单行大输出的问题）。
   * 行数多 → 行级 head/tail + 关键行；单行超长（行级裁不动）→ 字符级截断。
   */
  private trimToolResult(
    r: ContextResource,
    cfg: { toolResultMaxTokens: number; toolResultHeadLines: number; toolResultTailLines: number; keyLineLimit: number },
    ctx: StrategyContext,
  ): ContextResource {
    const text = resourceText(r);
    if (!text) return r;

    const maxTokens = cfg.toolResultMaxTokens;
    if (ctx.meter.estimateText(text) <= maxTokens) return r;

    const lines = text.split('\n');

    // 行级裁剪：head + 关键行 + tail（仅当行数足够多时才有意义）
    let truncated: string;
    if (lines.length > cfg.toolResultHeadLines + cfg.toolResultTailLines + 2) {
      const head = lines.slice(0, cfg.toolResultHeadLines);
      const tail = lines.slice(-cfg.toolResultTailLines);
      const keyLines = this.extractKeyLines(lines, cfg.keyLineLimit);
      const omitted = lines.length - head.length - tail.length;
      truncated = [
        ...head,
        `[... truncated ${omitted} lines ...]`,
        ...keyLines,
        ...tail,
      ].join('\n');
    } else {
      // 单行/极少行超长内容：直接进入字符级截断
      truncated = text;
    }

    // 字符级兜底：行级裁剪后仍超预算（如单行 minified JSON）则按字符截断
    if (ctx.meter.estimateText(truncated) > maxTokens) {
      truncated = this.truncateByChars(truncated, maxTokens, ctx);
    }

    if (truncated === text) return r;

    return {
      ...r,
      content: [{ type: 'text', text: truncated }],
      meta: { ...r.meta, _trimmed: true, _originalTokens: ctx.meter.estimateText(text) },
    };
  }

  /** 字符级截断：保留头部 + 截断标记 + 尾部，按估算迭代收缩 */
  private truncateByChars(text: string, maxTokens: number, ctx: StrategyContext): string {
    const totalTokens = ctx.meter.estimateText(text);
    const TAIL_CHARS = 200;
    // 首次按 token 比例估字符预算
    let headChars = Math.max(64, Math.floor((text.length * maxTokens) / totalTokens) - TAIL_CHARS);

    for (let i = 0; i < MAX_TRUNCATE_ITERATIONS && headChars > 0; i++) {
      const head = text.slice(0, headChars);
      const tail = text.slice(-TAIL_CHARS);
      const candidate = `${head}\n[... truncated ${text.length - headChars - TAIL_CHARS} chars ...]\n${tail}`;
      if (ctx.meter.estimateText(candidate) <= maxTokens) {
        return candidate;
      }
      headChars = Math.floor(headChars * 0.8);
    }
    return text.slice(0, Math.max(64, headChars)) + '\n[... truncated ...]';
  }

  /**
   * 关键行提取：error/warn/fail/panic/exception/traceback 等整行匹配，
   * 以及单行 JSON 的 error/status/message 字段。
   */
  private extractKeyLines(lines: string[], limit: number): string[] {
    const KEY_LINE_RE = /(error|warn|fail|✗|✘|panic|exception|traceback|fatal|critical)/i;
    const found: string[] = [];
    for (const line of lines) {
      if (found.length >= limit) break;
      if (KEY_LINE_RE.test(line)) {
        found.push(line);
        continue;
      }
      const jsonField = this.tryExtractJsonError(line);
      if (jsonField) found.push(jsonField);
    }
    return found;
  }

  private tryExtractJsonError(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const err = obj?.error ?? (obj as { errors?: unknown[] })?.errors?.[0] ?? obj?.message;
      const status = obj?.status ?? obj?.code;
      if (err || status) {
        return `[json] status=${status ?? 'n/a'}: ${typeof err === 'string' ? err : JSON.stringify(err)}`;
      }
    } catch {
      // 非 JSON，忽略
    }
    return null;
  }

  // ─── 操作 3：空白规范化 ─────────────────────────────────────────

  private normalizeWhitespace(r: ContextResource): ContextResource {
    const content = r.content;
    if (typeof content === 'string') {
      const normalized = normalizeWs(content);
      if (normalized === content) return r;
      return { ...r, content: normalized };
    }
    if (Array.isArray(content)) {
      let changed = false;
      const newContent = (content as ContentBlock[]).map(b => {
        if (b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string') {
          const normalized = normalizeWs((b as { text: string }).text);
          if (normalized !== (b as { text: string }).text) {
            changed = true;
            return { ...b, text: normalized };
          }
        }
        return b;
      });
      if (!changed) return r;
      return { ...r, content: newContent };
    }
    return r;
  }
}

/** 空白规范化：合并 3+ 换行为 2 个，去除行尾空格 */
function normalizeWs(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}
