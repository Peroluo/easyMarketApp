/**
 * 示例统一模型配置模板（可提交，不含真实密钥）
 *
 * 使用方式：
 *   cp examples/model.config.example.ts examples/model.config.ts
 *   然后把 apiKey 换成自己的密钥
 *
 * examples 下所有需要真实 LLM 的示例都从 model.config.ts 读取配置。
 * model.config.ts 已在 .gitignore 中，不会进入版本库。
 *
 * Langfuse 上报配置也在本表（langfuseConfig）：
 *   publicKey/secretKey 留空 → 上报扩展静默 no-op（离线可用）
 */
import { getBuiltinModel, adaptAiModel, createStreamFnFromAi } from '@aipack-ai/agent';
import { LangfuseTransport } from '@aipack-ai/agent-langfuse';
import type { Model, StreamFn } from '@aipack-ai/agent';

export interface ModelConfig {
  /** 提供商 id，如 deepseek / openai / anthropic */
  provider: string;
  /** 内置目录中的模型 id，如 deepseek-v4-flash */
  modelId: string;
  /** API Key */
  apiKey: string;
  /** 可选：覆盖内置 baseUrl（代理 / 兼容网关） */
  baseUrl?: string;
}

export const modelConfig: ModelConfig = {
  provider: 'deepseek',
  modelId: 'deepseek-v4-flash',
  apiKey: 'sk-在这里填写你的密钥',
  // baseUrl: 'https://api.deepseek.com/v1',
};

/** Langfuse 上报配置（自托管地址默认 http://localhost:3000） */
export interface LangfuseConfig {
  /** Public Key（留空则上报 no-op） */
  publicKey?: string;
  /** Secret Key（留空则上报 no-op） */
  secretKey?: string;
  /** Langfuse 地址 */
  baseUrl?: string;
}

export const langfuseConfig: LangfuseConfig = {
  secretKey: 'sk-lf-f6d3e15d-ca80-487b-988a-8c1bb090f1ab',
  publicKey: 'pk-lf-ead1abd0-a121-411d-877a-08b4765dce2d',
  baseUrl: 'http://localhost:3000',
};

/** 环境变量前缀：deepseek → DEEPSEEK_ */
function envPrefix(provider: string): string {
  return provider.toUpperCase().replace(/-/g, '_');
}

/** 合并环境变量覆盖，返回最终生效的配置 */
export function resolveModelConfig(base: ModelConfig = modelConfig): ModelConfig {
  const p = envPrefix(base.provider);
  return {
    provider: base.provider,
    modelId: process.env[`${p}_MODEL`] || base.modelId,
    apiKey: process.env[`${p}_API_KEY`] || base.apiKey,
    baseUrl: process.env[`${p}_BASE_URL`] || base.baseUrl,
  };
}

/**
 * 按配置装配「框架 Model + streamFn」。
 * 模型不在内置目录或缺少 apiKey 时直接抛错（不做静默降级）。
 */
export function createLlm(config: ModelConfig = resolveModelConfig()): {
  model: Model;
  streamFn: StreamFn;
} {
  const aiModel = getBuiltinModel(config.provider, config.modelId);
  if (!aiModel) {
    throw new Error(
      `内置模型目录中没有 ${config.provider}/${config.modelId}，请检查 model.config.ts 或设置 ${envPrefix(config.provider)}_MODEL`,
    );
  }
  if (!config.apiKey) {
    throw new Error(`缺少 API Key，请在 model.config.ts 中配置或设置 ${envPrefix(config.provider)}_API_KEY`);
  }

  // baseUrl 覆盖：内置目录条目 + 自定义端点（代理 / 兼容网关）
  const target = config.baseUrl ? { ...aiModel, baseUrl: config.baseUrl } : aiModel;

  return {
    model: adaptAiModel(target),
    // apiKey 显式传入，优先级高于环境变量，便于本地直接跑通
    streamFn: createStreamFnFromAi(target, { apiKey: config.apiKey }),
  };
}

/** 打印当前生效配置（隐藏密钥中间段） */
export function formatModelConfig(config: ModelConfig = resolveModelConfig()): string {
  const key = config.apiKey;
  const masked = key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : '***';
  return `${config.provider}/${config.modelId} (key: ${masked})${config.baseUrl ? ` @ ${config.baseUrl}` : ''}`;
}

/** 合并 Langfuse 环境变量覆盖（LANGFUSE_PUBLIC_KEY / SECRET_KEY / BASEURL 优先） */
export function resolveLangfuseConfig(base: LangfuseConfig = langfuseConfig): LangfuseConfig {
  return {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY || base.publicKey,
    secretKey: process.env.LANGFUSE_SECRET_KEY || base.secretKey,
    baseUrl: process.env.LANGFUSE_BASEURL || base.baseUrl,
  };
}

/** 凭据齐全 → 创建 LangfuseTransport；否则返回 undefined（调用方 no-op，离线可用） */
export function createLangfuseTransport(
  config: LangfuseConfig = resolveLangfuseConfig(),
): LangfuseTransport | undefined {
  if (!config.publicKey || !config.secretKey) return undefined;
  return new LangfuseTransport({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });
}
