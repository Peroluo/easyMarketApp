/**
 * 首次使用引导（API Key 配置）与 ~/.aipack/env.json 持久化。
 *
 * env.json 记录 onboarding 写入的环境变量（如 API Key）；bin 启动时
 * 最先加载注入 process.env（已有值不覆盖），print/json 模式与交互
 * 模式同样生效——无需改 shell profile。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { getBuiltinProviders, hasProviderConfigured } from '@aipack-ai/agent';
import { defaultConfigDir } from './version.js';
import { select } from './select.js';
import { ask } from './prompt.js';

/** 持久化环境变量文件路径（~/.aipack/env.json） */
export function persistedEnvPath(): string {
  return path.join(defaultConfigDir(), 'env.json');
}

/** 读取 env.json；不存在或损坏返回 null */
async function readPersistedEnv(): Promise<Record<string, string> | null> {
  try {
    const raw = JSON.parse(await fs.readFile(persistedEnvPath(), 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as Record<string, string>;
  } catch {
    return null;
  }
}

/** bin 启动时调用：env.json 中的变量注入 process.env（真实环境变量优先，不覆盖） */
export async function loadPersistedEnvIntoProcess(): Promise<void> {
  const stored = await readPersistedEnv();
  if (!stored) return;
  for (const [k, v] of Object.entries(stored)) {
    if (typeof v === 'string' && v && process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}

/** 追加/更新一个变量并写回 env.json（同时对当前进程生效） */
export async function saveEnvVar(name: string, value: string): Promise<void> {
  const stored = (await readPersistedEnv()) ?? {};
  stored[name] = value;
  await fs.mkdir(defaultConfigDir(), { recursive: true });
  await fs.writeFile(persistedEnvPath(), JSON.stringify(stored, null, 2), 'utf-8');
  process.env[name] = value;
}

/**
 * 首次使用引导：无任何 provider Key 且为 TTY 交互环境时，
 * select 选提供商 → 输入 Key → 写入 env.json 并注入本次会话。
 * 已配置或用户跳过则静默返回（后续由 banner 提示 export 方式）。
 */
export async function runApiKeyOnboarding(): Promise<void> {
  const providers = getBuiltinProviders();
  // 已配置任一提供商 → 无需引导
  if (providers.some(p => hasProviderConfigured(p.id))) return;
  if (!process.stdin.isTTY) return;

  console.log(chalk.yellow('\n未检测到任何 API Key，AI 调用将失败。'));
  const options = [
    ...providers.map(p => ({ label: `${p.name}（${p.envVar}）`, value: p.id })),
    { label: '跳过（稍后用环境变量配置，或运行 aipack doctor 排查）', value: '' },
  ];
  const picked = await select<string>('选择要配置的提供商', options);
  if (!picked) return;

  const provider = providers.find(p => p.id === picked);
  if (!provider) return;
  const key = await ask(`输入 ${provider.envVar}: `);
  // 简单校验：非空且不像误输入（过短）即接受；不做在线验证（慢且可能误报）
  if (!key || key.length < 8) {
    console.log(chalk.yellow('Key 为空或过短，已跳过（重新运行 aipack 可再次配置）'));
    return;
  }
  try {
    await saveEnvVar(provider.envVar, key);
    console.log(chalk.green(`已保存到 ${persistedEnvPath()}，本次会话即生效`));
  } catch (err) {
    console.log(chalk.yellow(
      `保存失败（${err instanceof Error ? err.message : String(err)}）。` +
      `可手动设置环境变量 ${provider.envVar}`,
    ));
  }
}
