// ===== 会话经验蒸馏 — 落盘 =====
//
// 用户在审阅面板确认后，把选中的候选写入：
// - Memory → longTermMemory.save / update
// - Skill → saveSkill（后端写 ~/.nova/skills/{name}/SKILL.md）
// - Playbook → V1 落盘为 workflow 型 skill（trigger=manual, tag=playbook）

import { longTermMemory } from "../memory/longterm";
import { saveSkill, reloadSkills } from "../skills/skillLoader";
import type {
  DistillResult,
  MemoryCandidate,
  PlaybookCandidate,
  SkillCandidate,
} from "./types";

/** 应用结果统计 */
export interface ApplyStats {
  memoriesSaved: number;
  skillsSaved: number;
  playbooksSaved: number;
}

/** 蒸馏产物来源标记（记忆 tag / skill tag），供「蒸馏产物」入口筛选 */
export const DISTILLED_TAG = "distilled";

/** 生成 YAML frontmatter 数组行 */
function yamlArray(key: string, values: string[]): string {
  if (!values || values.length === 0) return "";
  const items = values.map((v) => `  - "${String(v).replace(/"/g, '\\"')}"`).join("\n");
  return `${key}:\n${items}\n`;
}

/** 由 SkillCandidate 构建完整 SKILL.md 文本 */
export function buildSkillMd(c: SkillCandidate): string {
  const fm: string[] = ["---"];
  fm.push(`name: "${(c.displayName || c.name).replace(/"/g, '\\"')}"`);
  if (c.description) fm.push(`description: "${c.description.replace(/"/g, '\\"')}"`);
  fm.push(`trigger: ${c.trigger}`);
  const paths = c.paths && c.paths.length > 0 ? yamlArray("paths", c.paths) : "";
  const keywords = c.keywords && c.keywords.length > 0 ? yamlArray("keywords", c.keywords) : "";
  const tags = c.tags && c.tags.length > 0 ? yamlArray("tags", c.tags) : "";
  let head = fm.join("\n") + "\n";
  if (paths) head += paths;
  if (keywords) head += keywords;
  if (tags) head += tags;
  head += "---\n\n";
  return head + (c.body || "");
}

/** 由 PlaybookCandidate 构建 workflow 型 SKILL.md */
export function buildPlaybookMd(p: PlaybookCandidate): string {
  const stepsMd = p.steps
    .map((s, i) => `${i + 1}. **${s.title}**${s.detail ? `\n   ${s.detail}` : ""}`)
    .join("\n");
  const body = [
    "## 适用场景",
    p.description || p.displayName,
    "",
    "## 工作流步骤",
    stepsMd,
  ].join("\n");

  return buildSkillMd({
    name: p.name,
    displayName: p.displayName,
    description: p.description,
    trigger: "manual",
    keywords: p.keywords,
    tags: ["playbook", DISTILLED_TAG],
    body,
    confidence: p.confidence,
  });
}

/**
 * 应用蒸馏结果（写入选中的候选）
 *
 * @param selected 只包含用户勾选的候选
 */
export async function applyDistillResult(selected: {
  memories?: MemoryCandidate[];
  skills?: SkillCandidate[];
  playbooks?: PlaybookCandidate[];
}): Promise<ApplyStats> {
  const stats: ApplyStats = { memoriesSaved: 0, skillsSaved: 0, playbooksSaved: 0 };

  // Memory
  for (const m of selected.memories || []) {
    try {
      // 打来源标记，便于「蒸馏产物」入口筛选
      const tags = m.tags.includes(DISTILLED_TAG) ? m.tags : [...m.tags, DISTILLED_TAG];
      if (m.isUpdate?.id) {
        await longTermMemory.update(m.isUpdate.id, m.content, tags);
      } else {
        await longTermMemory.save(m.category, m.content, tags);
      }
      stats.memoriesSaved++;
    } catch (e: any) {
      console.warn("[Distill:apply] memory 保存失败:", e?.message || e);
    }
  }

  // Skill
  let skillWritten = false;
  for (const s of selected.skills || []) {
    try {
      const name = s.isUpdate?.name || s.name;
      const tags = s.tags.includes(DISTILLED_TAG) ? s.tags : [...s.tags, DISTILLED_TAG];
      await saveSkill(name, buildSkillMd({ ...s, tags }));
      stats.skillsSaved++;
      skillWritten = true;
    } catch (e: any) {
      console.warn("[Distill:apply] skill 保存失败:", e?.message || e);
    }
  }

  // Playbook（落盘为 workflow skill）
  for (const p of selected.playbooks || []) {
    try {
      await saveSkill(p.name, buildPlaybookMd(p));
      stats.playbooksSaved++;
      skillWritten = true;
    } catch (e: any) {
      console.warn("[Distill:apply] playbook 保存失败:", e?.message || e);
    }
  }

  // saveSkill 内部已 reload，这里保险再刷一次（写多个时）
  if (skillWritten) {
    try {
      await reloadSkills();
    } catch {}
  }

  console.log(
    `[Distill:apply] 落盘完成: memories=${stats.memoriesSaved}, skills=${stats.skillsSaved}, playbooks=${stats.playbooksSaved}`,
  );
  return stats;
}

/** 自动落盘策略：仅 high 置信度（V1 关闭强制审阅时用；供 V2 复用） */
export function filterAutoApply(result: DistillResult): {
  memories: MemoryCandidate[];
  skills: SkillCandidate[];
  playbooks: PlaybookCandidate[];
} {
  return {
    memories: result.memories.filter((m) => m.confidence === "high"),
    skills: result.skills.filter((s) => s.confidence === "high"),
    playbooks: result.playbooks.filter((p) => p.confidence === "high"),
  };
}
