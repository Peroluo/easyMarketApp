/**
 * 错误呈现：面向用户的格式化与 debug 分级。
 *
 * - 常见 API / 网络错误翻译为可行动提示（原始报错保留在下一行）
 * - 默认只显示错误信息；--debug 参数或 AIPACK_DEBUG 环境变量下附加堆栈
 */

/** 是否处于 debug 模式（--debug 参数或 AIPACK_DEBUG 环境变量，大小写不敏感） */
export function isDebugMode(argv: readonly string[] = process.argv): boolean {
  const env = process.env.AIPACK_DEBUG;
  return argv.includes('--debug') || !!env && env.toLowerCase() !== 'false' && env !== '0';
}

/** 常见错误模式 → 可行动提示（按序首次命中） */
const API_ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/\b401\b|unauthorized|invalid[ _-]?api[ _-]?key|authentication/i,
    'API Key 无效或未配置（检查对应 *_API_KEY 环境变量）'],
  [/\b403\b|forbidden|permission denied/i, '无权限访问（API Key 权限不足或账号被禁用）'],
  [/\b429\b|rate[ _-]?limit|too many requests|quota/i, '请求频率或额度超限，稍后重试'],
  [/\b404\b|model .*(not .*(found|exist)|不存在)|invalid model/i,
    '模型不存在（aipack --list-models 查看可用模型）'],
  [/\b5\d\d\b|internal server|server error|overloaded|service unavailable/i, '服务端错误，稍后重试'],
  [/etimedout|timed? out|econnrefused|enotfound|eai_again|network|fetch failed|socket hang up/i,
    '网络错误（检查网络连接或代理设置）'],
  [/context length|maximum context|token limit exceeded/i, '上下文超限（/compact 压缩会话或精简输入）'],
];

/** 已知错误模式 → 翻译提示；未命中返回 null */
export function translateApiError(message: string): string | null {
  for (const [pattern, hint] of API_ERROR_PATTERNS) {
    if (pattern.test(message)) return hint;
  }
  return null;
}

/** 提取错误的 message（非 Error 时字符串化） */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 面向用户的错误文本：
 * - 命中已知模式：翻译提示 + 原始报错
 * - debug 模式：附加完整堆栈
 * - err 为字符串（流内 error chunk 的 content）时仅做翻译
 */
export function formatErrorForUser(err: unknown, opts: { debug?: boolean } = {}): string {
  const debug = opts.debug ?? isDebugMode();
  const raw = typeof err === 'string' ? err : errorMessage(err);
  const hint = translateApiError(raw);
  const lines = hint ? [hint, `原始报错: ${raw}`] : [raw];
  if (debug && err instanceof Error && err.stack) {
    lines.push(err.stack);
  }
  return lines.join('\n');
}
