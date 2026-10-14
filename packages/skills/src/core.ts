/**
 * Skills - 契约层（纯函数，零 fs 依赖）
 *
 * 职责：
 *   - validateSkill        name/description/content 规则校验
 *   - formatSkillsSection  <available_skills> 目录段渲染（system prompt 注入用）
 *   - createSkillTool      内置 skill 工具工厂（模型按需获取 skill 全文）
 *   - expandSkillCommand   /skill:name 显式展开（CLI 等上层消费）
 *
 * 关键设计：loader 在加载时把正文读入 content 字段，skill 工具直接返回内容，
 * 运行时零 fs 依赖（agent 作为通用框架不假设消费者有 read 工具 / fs 权限）。
 */

import type { Tool, ToolResult } from '@aipack-ai/agent';
import { createTextContent } from '@aipack-ai/agent';
import type { Skill } from './types';

// ─── 校验 ─────────────────────────────────────────────────────────

/** name 规则：小写字母/数字，单连字符分隔，无首尾/连续连字符 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 校验 skill，返回错误列表（空数组 = 合法） */
export function validateSkill(skill: Skill): string[] {
  const errors: string[] = [];

  if (!skill.name || typeof skill.name !== 'string') {
    errors.push('name 缺失');
  } else {
    if (skill.name.length > 64) errors.push(`name 超过 64 字符（${skill.name.length}）`);
    if (!SKILL_NAME_RE.test(skill.name)) {
      errors.push(`name "${skill.name}" 不合法（需满足 ^[a-z0-9]+(-[a-z0-9]+)*$）`);
    }
  }

  if (!skill.description || typeof skill.description !== 'string') {
    errors.push('description 缺失');
  } else if (skill.description.length > 1024) {
    errors.push(`description 超过 1024 字符（${skill.description.length}）`);
  }

  if (typeof skill.content !== 'string' || !skill.content.trim()) {
    errors.push('content 缺失（SKILL.md 正文）');
  }

  return errors;
}

// ─── system prompt 目录段 ──────────────────────────────────────────

/**
 * 渲染 <available_skills> 目录段（渐进式披露：只注入 name + description）。
 * 无可见 skill 时返回空串（零 token 开销）。
 */
export function formatSkillsSection(skills: Skill[]): string {
  const visible = skills.filter(s => !s.disableModelInvocation);
  if (visible.length === 0) return '';

  const entries = visible
    .map(
      s =>
        `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n  </skill>`,
    )
    .join('\n');

  return [
    '以下 skills 针对特定任务提供专门的指令说明。',
    '当任务与某个 skill 的描述匹配时，使用 skill 工具加载该 skill。',
    '当 skill 中引用了相对路径时，请基于其 baseDir 进行解析。',
    '',
    '<available_skills>',
    entries,
    '</available_skills>',
  ].join('\n');
}

// ─── 内置 skill 工具 ───────────────────────────────────────────────

/** 归一化注册表：数组转 Map，同名先注册者胜（对齐 loader 多源优先级语义） */
function toRegistry(skills: Skill[] | Map<string, Skill>): Map<string, Skill> {
  if (skills instanceof Map) return skills;
  const map = new Map<string, Skill>();
  for (const s of skills) {
    if (!map.has(s.name)) map.set(s.name, s);
  }
  return map;
}

/**
 * 创建内置 skill 工具（工具名固定 'skill'）。
 *
 * execute：查注册表 → 命中返回 content（含 baseDir 提示）；
 * 未命中 / disableModelInvocation → 错误结果（details.error）。
 * permissions: []（只读注册表，安全工具，不走审批）。
 */
export function createSkillTool(
  registry: Skill[] | Map<string, Skill>,
  options?: { name?: string },
): Tool {
  const map = toRegistry(registry);
  return {
    name: options?.name ?? 'skill',
    description:
      '按名称加载某个 skill 的完整指令内容。' +
      '当任务与 <available_skills> 中列出的某个 skill 匹配时使用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要加载的 skill 名称' },
      },
      required: ['name'],
    },
    permissions: [],
    async execute(_toolCallId, args): Promise<ToolResult> {
      const name =
        typeof (args as { name?: unknown })?.name === 'string'
          ? (args as { name: string }).name
          : '';
      if (!name) {
        return errorResult('skill 工具缺少参数 name');
      }
      const skill = map.get(name);
      if (!skill) {
        const known = Array.from(map.keys()).join(', ');
        return errorResult(
          known ? `未找到 skill "${name}"（可用: ${known}）` : `未找到 skill "${name}"`,
        );
      }
      if (skill.disableModelInvocation) {
        return errorResult(`skill "${name}" 禁止模型调用（disable-model-invocation）`);
      }
      const parts = [skill.content];
      if (skill.baseDir) {
        parts.push(`引用路径相对于：${skill.baseDir}`);
      }
      return {
        content: [createTextContent(parts.join('\n\n'))],
        details: { skill: skill.name },
      };
    },
  };
}

function errorResult(message: string): ToolResult {
  return {
    content: [createTextContent(message)],
    details: { error: message },
  };
}

// ─── 显式展开（CLI /skill:name 用）────────────────────────────────

/**
 * 将文本中的 /skill:name [args] 展开为完整 skill XML 块 + 参数。
 * 命中即替换为 `<skill name="…" location="…">…全文…</skill>`，行内其余参数
 * 以空行分隔保留其后；未命中保持原样（由上层决定是否报错）。
 */
export function expandSkillCommand(text: string, skills: Skill[]): string {
  const map = toRegistry(skills);
  return text.replace(
    /\/skill:([a-z0-9-]+)(?:[ \t]+([^\n]*))?/g,
    (match, name: string, args?: string) => {
      const skill = map.get(name);
      if (!skill) return match;
      const location = skill.filePath ? ` location="${skill.filePath}"` : '';
      const xml = `<skill name="${name}"${location}>\n${skill.content}\n</skill>`;
      return args ? `${xml}\n\n${args}` : xml;
    },
  );
}
