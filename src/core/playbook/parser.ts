// ===== 可执行 Playbook — 解析器 =====
//
// 三条路径把 Playbook 解析到 store：
// 1. 从蒸馏产出的 PlaybookCandidate 转换
// 2. 从已有 SKILL.md（tag:playbook）解析
// 3. 从 JSON 直接导入（手动补录）
//
// 解析核心：识别 markdown 中的有序步骤列表 → PlaybookStep[]
//          识别 {{key}} 占位符 → 自动推断 PlaybookParam[]

import type { PlaybookCandidate } from "../distill/types";
import type { Skill } from "../skills/types";
import type { Playbook, PlaybookParam, PlaybookStep, PlaybookStepKind } from "./types";

/** 生成唯一 ID */
function genId(): string {
  return `pb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成步骤 ID */
function genStepId(index: number): string {
  return `step_${index + 1}`;
}

// ─── 从 PlaybookCandidate 转换 ───

/**
 * 将蒸馏产出的 PlaybookCandidate 转换为可执行 Playbook。
 *
 * 自动推断参数：扫描所有 step.detail 中的 {{key}} → 生成 params。
 */
export function fromCandidate(candidate: PlaybookCandidate): Playbook {
  const steps: PlaybookStep[] = candidate.steps.map((s, i) => ({
    id: genStepId(i),
    title: s.title,
    detail: s.detail,
    kind: "auto" as PlaybookStepKind,
  }));

  const params = inferParams(steps);

  return {
    id: genId(),
    name: candidate.name,
    displayName: candidate.displayName,
    description: candidate.description,
    params,
    steps,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ─── 从 SKILL.md 解析 ───

/**
 * 从已有的 playbook 型 SKILL.md 解析为可执行 Playbook。
 *
 * 期望 SKILL.md 正文结构：
 * ## 适用场景
 * ...
 * ## 工作流步骤 / ## 步骤
 * 1. **步骤标题**
 *    步骤详情...
 * 2. ...
 */
export function fromSkill(skill: Skill): Playbook | null {
  const { frontmatter, content, name } = skill;

  // 只解析 playbook 类型的 skill
  const tags = frontmatter.tags || [];
  const isPlaybook = tags.includes("playbook") ||
    frontmatter.trigger === "manual" && content.includes("步骤");

  if (!isPlaybook && !content.match(/##\s*(工作流步骤|步骤|Steps)/i)) {
    return null;
  }

  const steps = parseStepsFromMarkdown(content);
  if (steps.length === 0) return null;

  const params = inferParams(steps);

  return {
    id: genId(),
    name,
    displayName: frontmatter.name || frontmatter.description || name,
    description: frontmatter.description || frontmatter.summary || "",
    params,
    steps,
    sourceSkill: name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ─── Markdown 步骤解析 ───

/**
 * 从 SKILL.md 正文中解析有序步骤列表。
 *
 * 支持格式：
 * 1. **标题**
 *    详情行（可多行）
 *
 * 或：
 * 1. **标题** 详情
 *
 * 或（无粗体）：
 * 1. 标题：详情
 */
export function parseStepsFromMarkdown(content: string): PlaybookStep[] {
  const steps: PlaybookStep[] = [];

  // 找到步骤区域（## 步骤 / ## 工作流步骤 之后的内容）
  const sectionMatch = content.match(/##\s*(工作流步骤|步骤|Steps|Workflow\s*Steps?)[^\n]*\n([\s\S]*?)(?=\n##\s|\n---|\n\*\*\*|$)/i);
  const stepsContent = sectionMatch ? sectionMatch[2] : content;

  // 匹配有序列表：1. / 2. / 3. ...
  const lines = stepsContent.split("\n");
  let currentStep: { title: string; detailLines: string[] } | null = null;

  for (const line of lines) {
    // 匹配新步骤起始：数字. 后跟内容
    const stepMatch = line.match(/^\s*(\d+)\.\s+(.+)/);
    if (stepMatch) {
      // 保存上一个步骤
      if (currentStep) {
        steps.push(buildStep(steps.length, currentStep.title, currentStep.detailLines));
      }
      // 解析标题和可能的内联详情
      const rawContent = stepMatch[2];
      const { title, detail } = parseStepLine(rawContent);
      currentStep = { title, detailLines: detail ? [detail] : [] };
    } else if (currentStep && line.match(/^\s{2,}/) && line.trim()) {
      // 缩进续行 → 属于当前步骤的 detail
      currentStep.detailLines.push(line.trim());
    }
  }

  // 最后一个步骤
  if (currentStep) {
    steps.push(buildStep(steps.length, currentStep.title, currentStep.detailLines));
  }

  return steps;
}

/** 解析步骤行：分离标题和内联详情 */
function parseStepLine(raw: string): { title: string; detail: string } {
  // 格式1：**标题** 详情
  const boldMatch = raw.match(/^\*\*(.+?)\*\*\s*(.*)/);
  if (boldMatch) {
    return { title: boldMatch[1].trim(), detail: boldMatch[2].trim() };
  }

  // 格式2：标题：详情
  const colonMatch = raw.match(/^([^：:]+)[：:]\s*(.*)/);
  if (colonMatch && colonMatch[1].length < 30) {
    return { title: colonMatch[1].trim(), detail: colonMatch[2].trim() };
  }

  // 格式3：整行作为标题
  return { title: raw.trim(), detail: "" };
}

/** 构建 PlaybookStep */
function buildStep(index: number, title: string, detailLines: string[]): PlaybookStep {
  const detail = detailLines.join("\n");
  // 含"确认"/"危险"/"生产"等关键词的步骤默认 kind=confirm
  const isConfirm = /确认|危险|生产|production|confirm|destructive|删除|drop/i.test(title + " " + detail);
  return {
    id: genStepId(index),
    title,
    detail: detail || title,
    kind: isConfirm ? "confirm" : "auto",
  };
}

// ─── 参数推断 ───

/** {{key}} 占位符正则 */
const PARAM_PATTERN = /\{\{(\w+)\}\}/g;

/**
 * 从步骤中推断参数列表。
 * 扫描所有 step.detail 中的 {{key}} 占位符，生成 PlaybookParam[]。
 */
export function inferParams(steps: PlaybookStep[]): PlaybookParam[] {
  const seenKeys = new Set<string>();
  const params: PlaybookParam[] = [];

  for (const step of steps) {
    const text = `${step.title} ${step.detail}`;
    let match: RegExpExecArray | null;
    PARAM_PATTERN.lastIndex = 0;
    while ((match = PARAM_PATTERN.exec(text)) !== null) {
      const key = match[1];
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      params.push({
        key,
        label: humanizeKey(key),
        type: guessParamType(key),
        required: true,
      });
    }
  }

  return params;
}

/** 将 camelCase / snake_case / kebab-case key 转为人类可读标签 */
function humanizeKey(key: string): string {
  return key
    .replace(/[-_]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, c => c.toUpperCase());
}

/** 根据 key 名猜测参数类型 */
function guessParamType(key: string): PlaybookParam["type"] {
  const lower = key.toLowerCase();
  if (lower.includes("path") || lower.includes("dir") || lower.includes("file")) return "path";
  if (lower.includes("env") || lower.includes("environment")) return "enum";
  if (lower.includes("enable") || lower.includes("skip") || lower.includes("force") || lower.includes("dry")) return "boolean";
  return "string";
}

// ─── 参数模板替换 ───

/**
 * Level 2 参数替换：将 step.detail 中的 {{key}} 机械替换为实际值。
 */
export function replaceParams(template: string, params: Record<string, string>): string {
  return template.replace(PARAM_PATTERN, (_, key) => {
    return params[key] !== undefined ? params[key] : `{{${key}}}`;
  });
}

/**
 * Level 1 参数注入：生成开场上下文块。
 */
export function buildParamContext(playbook: Playbook, params: Record<string, string>): string {
  const lines: string[] = [
    `[Playbook 运行参数]`,
    `流程: ${playbook.displayName}`,
  ];
  for (const p of playbook.params) {
    const value = params[p.key];
    if (value !== undefined && value !== "") {
      lines.push(`${p.label}: ${value}`);
    }
  }
  // 也包含没有声明但实际传了的额外参数
  for (const [k, v] of Object.entries(params)) {
    if (!playbook.params.some(p => p.key === k) && v) {
      lines.push(`${humanizeKey(k)}: ${v}`);
    }
  }
  return lines.join("\n");
}
