// ===== Layer 3: 长期记忆 =====
//
// 跨会话知识持久化。用户偏好、项目上下文、行为反馈等。
// 存储通过 StorageService，命名空间 "memory"。
// 在 buildContext 时注入为 system 上下文前缀。

import { StorageService } from "../storage";
import { smartRecall, getRecallConfig } from "./recall";
import { shouldRecall } from "./recallGate";
import { semanticSearch, fuseRanked } from "./semantic";
import type { RecallContext, ScoredMemory } from "./recall";

/** 记忆分类 */
export type MemoryCategory = "user_preference" | "project_context" | "feedback" | "workflow";

/** 长期记忆条目 */
export interface LongTermMemory {
  id: string;
  category: MemoryCategory;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** 分类中文标签 */
export const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  user_preference: "用户偏好",
  project_context: "项目上下文",
  feedback: "行为反馈",
  workflow: "工作流",
};

const STORAGE_NAMESPACE = "memory";
const STORAGE_KEY = "longterm";
const MAX_MEMORIES = 100; // 上限，避免无限膨胀

/**
 * LongTermMemoryStore — 长期记忆的增删改查
 *
 * 使用方式：
 *   import { longTermMemory } from "./longterm";
 *   await longTermMemory.save("user_preference", "用户偏好表格展示", ["ui", "format"]);
 *   const all = await longTermMemory.getAll();
 */
class LongTermMemoryStore {
  private storage = StorageService.getInstance();
  private cache: LongTermMemory[] | null = null;

  /** 确保缓存已加载 */
  private async ensureLoaded(): Promise<LongTermMemory[]> {
    if (this.cache !== null) return this.cache;
    try {
      const data = await this.storage.get<LongTermMemory[]>(STORAGE_NAMESPACE, STORAGE_KEY, []);
      this.cache = Array.isArray(data) ? data : [];
    } catch {
      this.cache = [];
    }
    console.log(`[Nova:Memory] ensureLoaded: 加载了 ${this.cache.length} 条记忆`);
    return this.cache;
  }

  /** 持久化 */
  private async persist(): Promise<void> {
    if (this.cache === null) return;
    await this.storage.set(STORAGE_NAMESPACE, STORAGE_KEY, this.cache);
  }

  /** 新增记忆 */
  async save(category: MemoryCategory, content: string, tags: string[] = []): Promise<LongTermMemory> {
    const memories = await this.ensureLoaded();
    const entry: LongTermMemory = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      category,
      content,
      tags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    console.log(`[Nova:Memory] save: category=${category}, content="${content.slice(0, 50)}"`);
    memories.unshift(entry);

    // 超出上限，删除最旧的
    if (memories.length > MAX_MEMORIES) {
      memories.length = MAX_MEMORIES;
    }

    await this.persist();
    return entry;
  }

  /** 获取全部记忆 */
  async getAll(): Promise<LongTermMemory[]> {
    return [...(await this.ensureLoaded())];
  }

  /** 按分类筛选 */
  async getByCategory(category: MemoryCategory): Promise<LongTermMemory[]> {
    const memories = await this.ensureLoaded();
    return memories.filter(m => m.category === category);
  }

  /** 关键词搜索（content + tags） */
  async search(keyword: string): Promise<LongTermMemory[]> {
    const memories = await this.ensureLoaded();
    const lower = keyword.toLowerCase();
    return memories.filter(m =>
      m.content.toLowerCase().includes(lower) ||
      m.tags.some(t => t.toLowerCase().includes(lower))
    );
  }

  /** 更新记忆 */
  async update(id: string, content: string, tags?: string[]): Promise<void> {
    const memories = await this.ensureLoaded();
    const idx = memories.findIndex(m => m.id === id);
    if (idx === -1) return;
    memories[idx] = {
      ...memories[idx],
      content,
      tags: tags ?? memories[idx].tags,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }

  /** 删除记忆 */
  async remove(id: string): Promise<void> {
    const memories = await this.ensureLoaded();
    const idx = memories.findIndex(m => m.id === id);
    if (idx === -1) return;
    memories.splice(idx, 1);
    await this.persist();
  }

  /** 清空所有记忆 */
  async clear(): Promise<void> {
    this.cache = [];
    await this.persist();
  }

  /**
   * 构建 stable 层记忆上下文 — user_preference 类（始终注入，不依赖 query）
   *
   * 这部分内容几乎不变 → 放在 system prompt 前缀 → 高 cache 命中率。
   *
   * @returns 格式化的 system prompt 文本，或 null（无 user_preference 记忆）
   */
  async buildStableContext(): Promise<string | null> {
    const memories = await this.ensureLoaded();
    const stable = memories.filter(m => m.category === "user_preference");
    if (stable.length === 0) return null;

    const label = CATEGORY_LABELS["user_preference"];
    const items = stable.map((m, i) => `${i + 1}. ${m.content}`).join("\n");
    const result = `[长期记忆 · ${label}]\n${items}`;
    console.log(`[Nova:Memory] buildStableContext: stable 记忆数=${stable.length}, context 长度=${result.length}`);
    console.log(`[Memory LT] buildStableContext: ${stable.length}条 user_preference 记忆`);
    return result;
  }

  /**
   * 构建 variable 层记忆上下文 — 非 user_preference 类的智能回忆
   *
   * 对 project_context / feedback / workflow 类记忆做相关性打分，
   * 只注入与当前 query 最相关的 top-N 条。每次可能不同 → 放在 stable 层之后。
   *
   * @param query 用户当前输入
   * @param context 回忆上下文（工作区路径等）
   * @returns 格式化的 system prompt 文本，或 null
   */
  async buildVariableContext(query: string, context?: RecallContext): Promise<string | null> {
    // 闸门：无主题的输入不召回。
    //
    // 「可以，按完整方案实现」这类确认/指令语没有话题，任何打分算法都只能
    // 靠泛用动词（实现/完成/方案）擦线命中，塞进上下文全是噪音。
    // 实测 1208 条真实消息里有 6.3% 属于此类。
    if (!shouldRecall(query)) {
      console.log(`[Memory LT] 跳过召回：输入无实义内容 "${query.slice(0, 30)}"`);
      return null;
    }

    const memories = await this.ensureLoaded();
    // 排除 user_preference（已在 stable 层）
    const variable = memories.filter(m => m.category !== "user_preference");
    if (variable.length === 0) return null;

    const recalled = await this.recallFused(query, variable, context);
    console.log(`[Memory LT] buildVariableContext: query="${query.slice(0, 40)}" | variable记忆=${variable.length}条 | 回忆命中=${recalled.length}条`);
    if (recalled.length === 0) return null;

    // 按分类分组
    const grouped: Record<string, string[]> = {};
    for (const r of recalled) {
      const label = CATEGORY_LABELS[r.memory.category] || r.memory.category;
      if (!grouped[label]) grouped[label] = [];
      grouped[label].push(r.memory.content);
    }

    const sections = Object.entries(grouped).map(([label, items]) => {
      return `【${label}】\n${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}`;
    });

    const result = `[长期记忆 · 智能回忆]\n${sections.join("\n\n")}`;
    console.log(`[Nova:Memory] buildVariableContext: query="${query.slice(0, 40)}", variable 记忆数=${variable.length}, recalled 数=${recalled.length}, context 长度=${result.length}`);
    return result;
  }

  /**
   * 召回（语义 + 关键词融合，语义不可用时自动降级）。
   *
   * 语义召回的价值实测有据：「切换会话卡顿是怎么解决的」能命中
   * 「首屏20条+翻页30条…」（0.622），而这两句几乎没有共同词，
   * 词面匹配完全做不到。
   *
   * 保留关键词分量是因为两者互补：精确的专有名词（minisign、commit hash）
   * 向量模型未必编码得好，关键词匹配对这类最强。
   */
  private async recallFused(
    query: string,
    variable: LongTermMemory[],
    context?: RecallContext,
  ): Promise<ScoredMemory[]> {
    const keywordResults = await smartRecall(query, variable, context);

    // 语义侧：未启用/未就绪时返回空，此时结果等同纯关键词
    // 传入正文用于词面锚点过滤：挡掉「话题相近但主语不同」的候选
    const contents = new Map(variable.map(m => [m.id, m.content]));
    const semanticHits = await semanticSearch(query, 10, contents);
    if (semanticHits.length === 0) return keywordResults;

    // 用排名融合而非分数加权：两侧分数量纲不同，加权会让关键词命中
    // 反而把语义排名拉低（详见 semantic.ts 的 fuseRanked 注释）
    const fusedScores = fuseRanked(
      semanticHits.map(h => h.id),
      keywordResults.map(r => r.memory.id),
    );
    const byId = new Map(variable.map(m => [m.id, m]));

    const fused: ScoredMemory[] = [];
    for (const [id, score] of fusedScores) {
      const mem = byId.get(id);
      if (mem) fused.push({ memory: mem, score });
    }
    fused.sort((a, b) => b.score - a.score);
    const top = fused.slice(0, getRecallConfig().maxResults);
    console.log(
      `[Nova:Memory] 融合召回: 语义 ${semanticHits.length} 条 + 关键词 ${keywordResults.length} 条 → ${top.length} 条`,
    );
    return top;
  }

  /**
   * 获取智能回忆结果（带分数，供 UI 展示）
   *
   * 返回 variable 层的回忆结果（不含 user_preference，那些在 stable 层）。
   */
  async getRecalledMemories(query: string, context?: RecallContext): Promise<ScoredMemory[]> {
    // 与 buildVariableContext 用同一道闸门：否则召回面板显示「召回 N 条」
    // 而实际什么都没注入，两边对不上
    if (!shouldRecall(query)) return [];
    const memories = await this.ensureLoaded();
    const variable = memories.filter(m => m.category !== "user_preference");
    if (variable.length === 0) return [];
    const results = await this.recallFused(query, variable, context);
    console.log(`[Nova:Memory] getRecalledMemories: query="${query.slice(0, 40)}", 搜索范围=${variable.length}, 返回结果数=${results.length}`);
    return results;
  }

  /** 获取 stable 层记忆数量（供 UI 展示） */
  async getStableCount(): Promise<number> {
    const memories = await this.ensureLoaded();
    return memories.filter(m => m.category === "user_preference").length;
  }

  /** 获取统计信息 */
  async getStats(): Promise<{ total: number; byCategory: Record<string, number> }> {
    const memories = await this.ensureLoaded();
    const byCategory: Record<string, number> = {};
    for (const m of memories) {
      byCategory[m.category] = (byCategory[m.category] || 0) + 1;
    }
    return { total: memories.length, byCategory };
  }
}

/** 全局单例 */
export const longTermMemory = new LongTermMemoryStore();
