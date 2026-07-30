// ===== 会话经验蒸馏 — Prompt 构建 & 结果解析 =====
//
// 对标 Claude Code /skillify：明确"什么值得沉淀"，结构化 JSON 输出。

import type { Message } from "../types";
import type { LongTermMemory, MemoryCategory } from "../memory/longterm";
import type { Skill } from "../skills/types";
import type {
  ArtifactConfidence,
  DistillResult,
  MemoryCandidate,
  PlaybookCandidate,
  SkillCandidate,
} from "./types";

const VALID_CATEGORIES: Set<string> = new Set([
  "user_preference",
  "feedback",
  "project_context",
  "workflow",
]);

const VALID_CONFIDENCE: Set<string> = new Set(["high", "medium", "low"]);

/** 将会话消息拼成对话文本（截断单条，避免爆上下文） */
export function formatDialog(messages: Message[], perMsgChars = 1000): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, perMsgChars)}`)
    .join("\n");
}

/**
 * 构建蒸馏 prompt
 *
 * @param dialog 对话文本（可能是原文，也可能是 map-reduce 的分段摘要）
 * @param existingMemories 已有记忆（去重提示）
 * @param existingSkills 已有技能（去重提示）
 */
export function buildDistillPrompt(
  dialog: string,
  existingMemories: LongTermMemory[],
  existingSkills: Skill[],
): string {
  const memSummary = existingMemories.length > 0
    ? existingMemories.slice(0, 30).map((m, i) => `${i + 1}. [${m.category}] ${m.content.slice(0, 80)}`).join("\n")
    : "（暂无）";

  const skillSummary = existingSkills.length > 0
    ? existingSkills.slice(0, 30).map((s, i) => `${i + 1}. ${s.frontmatter.name || s.name}: ${(s.frontmatter.description || "").slice(0, 80)}`).join("\n")
    : "（暂无）";

  return [
    "你是一个「会话经验蒸馏器」。请分析下面这段会话，把其中值得长期复用的经验，蒸馏为三类资产：Memory、Skill、Playbook。",
    "",
    "## 三类资产的定义",
    "- Memory（记忆）：原子化的事实/偏好/纠正。颗粒最小。",
    "  category 只能是: user_preference（用户偏好/习惯/技术栈）、feedback（用户对助手的纠正或确认）、project_context（无法从代码推导的项目信息）、workflow（简短的常用命令/流程口诀）。",
    "- Skill（技能）：一份「遇到 X 场景该怎么做」的知识文档，有明确适用场景，可被相关场景召回。比 Memory 大，是结构化的方法/清单/注意事项。",
    "- Playbook（工作流）：有序、可复现的多步操作流程（3 步以上），比如某个部署/排查/发布的完整步骤序列。",
    "",
    "## 什么该沉淀 / 什么不该",
    "该沉淀：可复用的方法、反复出现的操作序列、用户明确表达的偏好与纠正、无法从代码/文档推导的项目决策。",
    "不该沉淀：一次性的调试信息、可从代码或 git 历史直接看到的内容、临时性的具体数值、与复用无关的闲聊。",
    "宁缺毋滥：没有高质量可沉淀内容时，对应数组返回空。",
    "",
    "## 关于 Memory 的额外约束（重要）",
    "- 不要把「某某功能/机制已实现，代码在 XXX 里如何组织」这类**对已实现代码的描述/复述**存成 Memory —— 这些能从代码本身看到，属于禁止项。",
    "- Memory 只留：用户偏好、用户纠正、无法从代码推导的项目事实（如接口返回结构、字段类型坑、错误码含义、部署/刷缓存步骤、决策动机）。",
    "- 如果一段内容是「遇到某场景该怎么做」的方法论，应归为 Skill，而不是塞进 Memory。",
    "",
    "## 去重（重要，避免冗余）",
    "1. 与下方「已有记忆/技能」实质重复的，不要重复产出；是补充/修正则标 isUpdate。",
    "2. **本次产出内部也要去重**：同一主题不要拆成多个高度重叠的条目。",
    "   - 尤其是 Skill/Playbook：同一场景（如「元模型排错」）只产出**一个**最完整的资产，不要既出一个『参考指南』又出一个『排查流程』。若既有清单又有有序步骤，合并为一个：用 Skill 承载（正文里可含步骤小节），或用 Playbook 承载，二选一。",
    "3. Skill 与 Playbook 之间也不要就同一主题各出一份。",
    "",
    "已有记忆：",
    memSummary,
    "",
    "已有技能：",
    skillSummary,
    "",
    "## 会话内容",
    dialog,
    "",
    "## 输出格式（严格 JSON，不要输出任何多余文字）",
    "{",
    '  "summary": "一句话说明本次蒸馏做了什么",',
    '  "memories": [{"category":"user_preference","content":"...","tags":["..."],"confidence":"high","isUpdate":null}],',
    '  "skills": [{"name":"kebab-case-name","displayName":"显示名","description":"一句话适用场景","trigger":"auto","paths":[],"keywords":["召回用关键词"],"tags":["..."],"body":"## 适用场景\\n...\\n## 步骤/要点\\n...","confidence":"medium","isUpdate":null}],',
    '  "playbooks": [{"name":"kebab-case-name","displayName":"显示名","description":"...","keywords":["..."],"steps":[{"title":"步骤标题","detail":"步骤细节"}],"confidence":"medium"}]',
    "}",
    "",
    "要求：",
    "- confidence 只能是 high / medium / low。",
    "- skill.name / playbook.name 用英文 kebab-case。",
    "- skill.keywords / playbook.keywords 用于后续场景召回，务必给出能代表该场景的中英文关键词。",
    "- isUpdate：若为更新已有条目，memory 填 {\"id\":\"已有记忆的序号对应内容无法给id则填null\"}，skill 填 {\"name\":\"已有技能名\"}；否则填 null。",
    "只输出 JSON：",
  ].join("\n");
}

// ===== 结果解析 =====

/** 从模型响应中提取 JSON 对象（容错：markdown 包裹、前后缀文字） */
function extractJsonObject(raw: string): any | null {
  const trimmed = raw.trim();
  let jsonStr = trimmed;

  const mdMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch) {
    jsonStr = mdMatch[1].trim();
  } else {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      jsonStr = trimmed.slice(first, last + 1);
    }
  }

  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function toConfidence(v: unknown): ArtifactConfidence {
  const s = String(v || "").toLowerCase();
  return (VALID_CONFIDENCE.has(s) ? s : "medium") as ArtifactConfidence;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).map((x) => x.trim()).filter(Boolean);
}

function slugify(name: string, fallback: string): string {
  const s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

/**
 * 解析蒸馏结果
 *
 * @param raw 模型原始输出
 * @param sourceSessions 来源会话
 */
export function parseDistillResult(raw: string, sourceSessions: string[]): DistillResult {
  const now = new Date().toISOString();
  const empty: DistillResult = {
    memories: [],
    skills: [],
    playbooks: [],
    sourceSessions,
    summary: "",
    createdAt: now,
  };

  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== "object") return empty;

  // memories
  const memories: MemoryCandidate[] = [];
  if (Array.isArray(obj.memories)) {
    for (const item of obj.memories) {
      if (!item || typeof item !== "object") continue;
      const category = String(item.category || "");
      const content = String(item.content || "").trim();
      if (!content || !VALID_CATEGORIES.has(category)) continue;
      memories.push({
        category: category as MemoryCategory,
        content,
        tags: toStringArray(item.tags),
        confidence: toConfidence(item.confidence),
        isUpdate: item.isUpdate && item.isUpdate.id ? { id: String(item.isUpdate.id) } : undefined,
      });
    }
  }

  // skills
  const skills: SkillCandidate[] = [];
  if (Array.isArray(obj.skills)) {
    for (let i = 0; i < obj.skills.length; i++) {
      const item = obj.skills[i];
      if (!item || typeof item !== "object") continue;
      const description = String(item.description || "").trim();
      const body = String(item.body || "").trim();
      if (!description && !body) continue;
      const displayName = String(item.displayName || item.name || "").trim() || `skill-${i + 1}`;
      const name = slugify(item.name, `distilled-skill-${Date.now()}-${i}`);
      const trigger = item.trigger === "manual" ? "manual" : "auto";
      skills.push({
        name,
        displayName,
        description,
        trigger,
        paths: toStringArray(item.paths),
        keywords: toStringArray(item.keywords),
        tags: toStringArray(item.tags),
        body,
        confidence: toConfidence(item.confidence),
        isUpdate: item.isUpdate && item.isUpdate.name ? { name: String(item.isUpdate.name) } : undefined,
      });
    }
  }

  // playbooks
  const playbooks: PlaybookCandidate[] = [];
  if (Array.isArray(obj.playbooks)) {
    for (let i = 0; i < obj.playbooks.length; i++) {
      const item = obj.playbooks[i];
      if (!item || typeof item !== "object") continue;
      const steps = Array.isArray(item.steps)
        ? item.steps
            .map((s: any) => ({
              title: String(s?.title || "").trim(),
              detail: String(s?.detail || "").trim(),
            }))
            .filter((s: any) => s.title || s.detail)
        : [];
      if (steps.length === 0) continue;
      const displayName = String(item.displayName || item.name || "").trim() || `playbook-${i + 1}`;
      playbooks.push({
        name: slugify(item.name, `distilled-playbook-${Date.now()}-${i}`),
        displayName,
        description: String(item.description || "").trim(),
        keywords: toStringArray(item.keywords),
        steps,
        confidence: toConfidence(item.confidence),
      });
    }
  }

  return {
    memories,
    skills,
    playbooks,
    sourceSessions,
    summary: String(obj.summary || "").trim(),
    createdAt: now,
  };
}
