// ===== 会话经验蒸馏 — 类型定义 =====
//
// 从会话中蒸馏出三类可复用资产：Memory / Skill / Playbook。
// 蒸馏产物先以「候选」形式产出（不落盘），交审阅面板确认后再写入。

import type { MemoryCategory } from "../memory/longterm";

/** 候选置信度 */
export type ArtifactConfidence = "high" | "medium" | "low";

/** 记忆候选（对应长期记忆的一条） */
export interface MemoryCandidate {
  category: MemoryCategory;
  content: string;
  tags: string[];
  confidence: ArtifactConfidence;
  /** 命中已有记忆 → 更新而非新建 */
  isUpdate?: { id: string };
}

/** 技能候选（对应一份 SKILL.md） */
export interface SkillCandidate {
  /** kebab-case，用作目录名 */
  name: string;
  /** 显示名称 */
  displayName: string;
  description: string;
  trigger: "auto" | "manual";
  /** 可选，文件型场景的 glob */
  paths?: string[];
  /** 语义召回用关键词 */
  keywords: string[];
  tags: string[];
  /** SKILL.md 正文（markdown，不含 frontmatter） */
  body: string;
  confidence: ArtifactConfidence;
  /** 命中已有 skill → 更新 */
  isUpdate?: { name: string };
}

/** Playbook 候选（V1：落盘为 workflow 型 skill） */
export interface PlaybookCandidate {
  name: string;
  displayName: string;
  description: string;
  keywords: string[];
  steps: { title: string; detail: string }[];
  confidence: ArtifactConfidence;
}

/** 一次蒸馏的完整结果 */
export interface DistillResult {
  memories: MemoryCandidate[];
  skills: SkillCandidate[];
  playbooks: PlaybookCandidate[];
  /** 来源会话 ID 列表 */
  sourceSessions: string[];
  /** 本次蒸馏摘要（给用户看） */
  summary: string;
  createdAt: string;
  /** 若被跳过，说明原因（供 UI 提示） */
  skipped?: "disabled" | "no_new_content" | "below_min_turns";
}

/** 蒸馏配置（部分来自 Settings） */
export interface DistillConfig {
  /** 是否启用蒸馏 */
  enabled: boolean;
  /** 会话少于 N 轮不允许蒸馏 */
  minTurns: number;
  /** 是否强制审阅（关闭后仅 high 置信度自动落盘） */
  requireReview: boolean;
  /** skill 数量上限（超出提示清理） */
  maxSkills: number;
  /** 是否启用自动蒸馏（调度引擎定时/闲置触发，默认关） */
  autoDistillEnabled: boolean;
  /** 自动蒸馏时高可信 Memory 是否直接落盘（默认开；Skill/Playbook 始终入待审） */
  autoApplyHighConfidenceMemory: boolean;
}

export const DEFAULT_DISTILL_CONFIG: DistillConfig = {
  enabled: true,
  minTurns: 3,
  requireReview: true,
  maxSkills: 50,
  autoDistillEnabled: false,
  autoApplyHighConfidenceMemory: true,
};

/** 空结果 */
export function emptyDistillResult(sourceSessions: string[]): DistillResult {
  return {
    memories: [],
    skills: [],
    playbooks: [],
    sourceSessions,
    summary: "",
    createdAt: new Date().toISOString(),
  };
}
