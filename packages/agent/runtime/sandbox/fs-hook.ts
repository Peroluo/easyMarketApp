/**
 * sandbox fs ESM 拦截 hook（worker 进程内经 module.register 注册）。
 *
 * 为什么需要：CJS exports patch（worker.ts installFsFacade）只覆盖
 * require / default import / namespace 属性访问三种形态；ESM named import
 * （`import { readFileSync } from 'node:fs'`）拿到的是实例化时的快照
 * 绑定，绕过 patch。本 hook 把 fs 相关 specifier 重定向到动态生成的
 * facade 模块：facade 的每个 named export 在工具模块 import 时刻对
 * patched exports 对象求值快照（installFsFacade 先于工具模块加载执行），
 * 从而让 named import 也拿到包装后的函数。
 *
 * 边界：
 * - 仅拦截 worker 进程内的 ESM import（宿主进程不受影响）；
 * - facade 用 createRequire 拿原生 fs（CJS require 不走 ESM hook，无死循环）；
 * - 本文件自身在 worker 顶层静态 import 之前完成注册（静态 import 提升
 *   语义保证 worker 自己的 nodeFs 绑定不被重定向——facade 校验依赖真
 *   realpathSync，正好保持原生）。
 */

import { createRequire } from 'node:module';

const hookRequire = createRequire(import.meta.url);

const FS_SPECIFIERS = new Set(['fs', 'node:fs']);
const FS_PROMISES_SPECIFIERS = new Set(['fs/promises', 'node:fs/promises']);

// module.register 的 hook 契约类型（experimental，node:module 未导出类型时收敛为结构类型）
type NextResolve = (
  specifier: string,
  context: { parentURL?: string },
  next: (s: string, c: { parentURL?: string }) => Promise<{ url: string }>,
) => Promise<{ url: string; shortCircuit?: boolean }>;
type NextLoad = (
  url: string,
  context: { format?: string },
  next: (u: string, c: { format?: string }) => Promise<{ format: string; source?: unknown }>,
) => Promise<{ format: string; source?: unknown; shortCircuit?: boolean }>;

export const resolve: NextResolve = async (specifier, context, next) => {
  if (FS_SPECIFIERS.has(specifier)) {
    return { url: 'aipack-sandbox:fs', shortCircuit: true };
  }
  if (FS_PROMISES_SPECIFIERS.has(specifier)) {
    return { url: 'aipack-sandbox:fs-promises', shortCircuit: true };
  }
  return next(specifier, context);
};

export const load: NextLoad = async (url, context, next) => {
  if (url === 'aipack-sandbox:fs') {
    return {
      format: 'module',
      shortCircuit: true,
      source: facadeSource('node:fs', false),
    };
  }
  if (url === 'aipack-sandbox:fs-promises') {
    return {
      format: 'module',
      shortCircuit: true,
      source: facadeSource('node:fs', true),
    };
  }
  return next(url, context);
};

/**
 * 生成 facade 模块源码。评估时机 = 工具模块第一次 import fs 时（此时
 * installFsFacade 已完成 patch）→ `export const x = __raw['x']` 快照的
 * 正是包装后的函数。default 快照整个（已 patch 属性的）exports 对象。
 */
function facadeSource(target: string, promises: boolean): string {
  const raw = promises ? hookRequire(target).promises : hookRequire(target);
  const member = promises ? `.promises` : '';
  const names = Object.keys(raw).filter(
    name => name !== 'default' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name),
  );
  let src =
    `import { createRequire as __cr } from 'node:module';\n` +
    `const __req = __cr(${JSON.stringify(import.meta.url)});\n` + // createRequire 需真实 file: URL（虚拟 URL 不可用）
    `const __raw = __req(${JSON.stringify(target)})${member};\n` +
    `export default __raw;\n`;
  for (const name of names) {
    src += `export const ${name} = __raw[${JSON.stringify(name)}];\n`;
  }
  return src;
}
