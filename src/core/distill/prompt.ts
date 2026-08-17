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
    "## 核心目标（决定一切取舍）",
    "沉淀的目的不是记录「这次我做了什么」，而是产出**换一个人、换一个项目也能照用的能力**。",
    "每次产出前先自问：把这份东西单独发给一个不了解本项目的同行，他能靠它独立解决同类问题吗？",
    "不能，就说明抽象层次不够——要么补足机制层面的解释，要么降级为 Memory，而不是硬凑成 Skill。",
    "",
    "## 三类资产的定义",
    "- Memory（记忆）：原子化的事实/偏好/纠正。颗粒最小。只在**本人本项目**成立的具体信息放这里。",
    "  category 只能是: user_preference（用户偏好/习惯/技术栈）、feedback（用户对助手的纠正或确认）、project_context（无法从代码推导的项目信息）、workflow（简短的常用命令/流程口诀）。",
    "- Skill（技能）：**一类问题的可迁移解法**。核心价值在于讲清「为什么会这样」和「如何判断属于这类问题」，而不是罗列这次敲了哪些命令。",
    "  必须同时具备：识别信号（出现什么现象时适用）、机制或根因（为什么会发生）、处置方法、边界（什么情况不适用）。",
    "  只有本次这一个场景能用、脱离本项目就无意义的，不要做成 Skill。",
    "- Playbook（工作流）：有序、可复现的多步操作流程（3 步以上），比如某个部署/排查/发布的完整步骤序列。",
    "  每一步的 detail 里要说明**这步为什么必要、跳过会出什么问题**，不要只写命令。",
    "",
    "## 抽象化要求（Skill / Playbook 必须遵守）",
    "1. 用**问题类型**命名，不要用项目名或分支名命名。",
    "   反例：`meinian-branch-feature-sync`、`salescloud-xx-fix`；正例：`cross-branch-feature-gap-diagnosis`。",
    "2. 出现内部专有名词（自研项目名、库表名、分支名、自定义常量、内部服务）时，必须补一句说明它属于哪一类东西，让不了解的人能类推到自己的对应物。",
    "   例：不要只写「查 p_meta_metamodel_data」，写成「查元模型定义表（本项目是 p_meta_metamodel_data）」。",
    "3. 具体命令、路径、ID 只作为示例出现，要同时给出它代表的通用步骤含义。",
    "4. 优先沉淀**排查思路与判断依据**（如何缩小范围、先验证哪个假设、什么现象排除什么可能），这类内容迁移价值最高；纯操作序列价值最低。",
    "",
    "## 什么该沉淀 / 什么不该",
    "该沉淀：可迁移的解题方法与判断依据、踩过的坑及其成因、反复出现的操作序列、用户明确表达的偏好与纠正、无法从代码/文档推导的项目决策。",
    "不该沉淀：一次性的调试信息、可从代码或 git 历史直接看到的内容、临时性的具体数值、与复用无关的闲聊。",
    "特别不要沉淀：对本次会话过程的复述（「用户要求…」「我先改了 A 再改了 B」）、已被推翻或废弃的中间方案。",
    "宁缺毋滥：没有高质量可沉淀内容时，对应数组返回空。产出 1 个有机制解释的 Skill，胜过 3 个步骤清单。",

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
    '  "skills": [{"name":"kebab-case-name","displayName":"显示名","description":"召回用的一句话，说明这份技能解决哪类问题","trigger":"auto","paths":[],"keywords":["召回用关键词"],"tags":["..."],"body":"## 适用场景\\n（出现哪些现象/信号时用这份，写成可对照的判断条件）\\n\\n## 根因与机制\\n（为什么会发生。这一节是可迁移价值的核心，必须写实质原因，不能省略或写成空话）\\n\\n## 处置\\n（怎么做。命令只作示例，同时说明每步在解决什么）\\n\\n## 边界与陷阱\\n（什么情况下不适用、容易误判成什么、踩过什么坑）","confidence":"medium","isUpdate":null}],',
    '  "playbooks": [{"name":"kebab-case-name","displayName":"显示名","description":"...","keywords":["..."],"steps":[{"title":"步骤标题","detail":"做什么 + 这步为什么必要 / 跳过会出什么问题"}],"confidence":"medium"}]',
    "}",
    "",
    "要求：",
    "- confidence 只能是 high / medium / low。",
    "- skill.name / playbook.name 用英文 kebab-case，按问题类型命名，不含项目名/分支名。",
    "- skill.description 是召回用的场景概述，**不要与 body 里「适用场景」一节的句子重复**，两者措辞必须不同。",
    "- skill.body 的四节都要有实质内容。若「根因与机制」一节写不出实质原因，说明这段经验还没理解透，此时不要产出 Skill，改为产出 Memory。",
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
