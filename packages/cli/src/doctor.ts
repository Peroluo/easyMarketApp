/**
 * aipack doctor：环境自检
 *
 * 检查 Node 版本、API Key、配置文件、MCP 配置、会话目录可写性、
 * 持久化环境变量文件，输出 ✓ / ⚠ / ✗ 与修复建议。
 * 存在 ✗ 项时退出码 1（可接入脚本 / CI 判断）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import { getBuiltinProviders, hasProviderConfigured } from '@aipack-ai/agent';
import { defaultConfigDir, defaultSessionDir, VERSION } from './version.js';
import { persistedEnvPath } from './onboarding.js';

/** 单项检查结果 */
interface CheckResult {
  status: 'ok' | 'warn' | 'fail';
  label: string;
  detail: string;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── 各检查项 ────────────────────────────────────────────────────

function checkNodeVersion(): CheckResult {
  const major = Number.parseInt(process.versions.node, 10);
  if (Number.isNaN(major)) {
    return { status: 'warn', label: 'Node 版本', detail: `无法解析: ${process.version}` };
  }
  if (major < 18) {
    return {
      status: 'fail',
      label: 'Node 版本',
      detail: `${process.version}（需要 >= 18，fetch/AbortSignal 等运行时依赖）`,
    };
  }
  return { status: 'ok', label: 'Node 版本', detail: process.version };
}

function checkApiKeys(): CheckResult {
  const providers = getBuiltinProviders();
  const configured = providers.filter(p => hasProviderConfigured(p.id));
  if (configured.length === 0) {
    return {
      status: 'warn',
      label: 'API Key',
      detail: '未配置任何提供商（AI 调用将失败；交互模式启动 aipack 可引导配置）',
    };
  }
  return {
    status: 'ok',
    label: 'API Key',
    detail: `已配置: ${configured.map(p => p.id).join(', ')}`,
  };
}

async function checkConfigFile(cwd: string): Promise<CheckResult> {
  for (const file of ['aipack.config.js', 'aipack.config.mjs']) {
    const full = path.join(cwd, file);
    if (!(await exists(full))) continue;
    try {
      await import(pathToFileURL(full).href);
      return { status: 'ok', label: `配置文件 ${file}`, detail: '加载成功' };
    } catch (err) {
      return {
        status: 'fail',
        label: `配置文件 ${file}`,
        detail: `加载失败（运行时已忽略）: ${errMessage(err)}`,
      };
    }
  }
  return { status: 'ok', label: '配置文件', detail: '（未创建，使用默认配置）' };
}

/** 校验单个 .mcp.json：可解析且含 mcpServers 对象 */
async function checkMcpConfig(file: string): Promise<CheckResult | null> {
  if (!(await exists(file))) return null;
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as unknown;
    const servers = (raw as { mcpServers?: unknown })?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return { status: 'fail', label: `MCP 配置 ${file}`, detail: '缺少 mcpServers 对象' };
    }
    const names = Object.keys(servers);
    return {
      status: 'ok',
      label: `MCP 配置 ${path.basename(path.dirname(file))}${path.sep}${path.basename(file)}`,
      detail: names.length > 0 ? `${names.length} 个 server: ${names.join(', ')}` : '（无 server）',
    };
  } catch (err) {
    return { status: 'fail', label: `MCP 配置 ${file}`, detail: `JSON 解析失败: ${errMessage(err)}` };
  }
}

async function checkSessionDir(cwd: string): Promise<CheckResult> {
  const dir = defaultSessionDir(cwd);
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${process.pid}.tmp`);
    await fs.writeFile(probe, 'ok', 'utf-8');
    await fs.unlink(probe);
    return { status: 'ok', label: '会话目录可写', detail: dir };
  } catch (err) {
    return { status: 'fail', label: '会话目录不可写', detail: `${dir}（${errMessage(err)}）` };
  }
}

/** env.json（onboarding 持久化的环境变量）：存在则列出变量名（不显示值） */
async function checkPersistedEnv(): Promise<CheckResult | null> {
  const file = persistedEnvPath();
  if (!(await exists(file))) return null;
  try {
    const stored = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
    const names = Object.keys(stored);
    return {
      status: 'ok',
      label: '持久化环境变量',
      detail: `${file}（${names.length > 0 ? names.join(', ') : '空'}）`,
    };
  } catch (err) {
    return { status: 'fail', label: '持久化环境变量', detail: `${file} 解析失败: ${errMessage(err)}` };
  }
}

// ─── 聚合输出 ────────────────────────────────────────────────────

export async function runDoctor(cwd: string = process.cwd()): Promise<number> {
  console.log(chalk.bold(`aipack doctor ${chalk.dim(`v${VERSION}`)}\n`));

  const results: CheckResult[] = [
    checkNodeVersion(),
    checkApiKeys(),
    await checkConfigFile(cwd),
    (await checkMcpConfig(path.join(cwd, '.mcp.json')))!,
    (await checkMcpConfig(path.join(defaultConfigDir(), 'mcp.json')))!,
    await checkSessionDir(cwd),
    (await checkPersistedEnv())!,
  ].filter((r): r is CheckResult => r !== null);

  for (const r of results) {
    const mark = r.status === 'ok' ? chalk.green('✓') : r.status === 'warn' ? chalk.yellow('⚠') : chalk.red('✗');
    console.log(`  ${mark} ${chalk.bold(r.label)}  ${chalk.dim(r.detail)}`);
  }

  const fails = results.filter(r => r.status === 'fail');
  const warns = results.filter(r => r.status === 'warn');
  console.log(
    `\n${chalk.dim(`共 ${results.length} 项：` +
      `${chalk.green(`${results.length - fails.length - warns.length} 通过`)}` +
      `${warns.length > 0 ? chalk.yellow(` / ${warns.length} 提醒`) : ''}` +
      `${fails.length > 0 ? chalk.red(` / ${fails.length} 失败`) : ''}`)}`,
  );
  return fails.length > 0 ? 1 : 0;
}
