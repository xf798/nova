// ===== 智能回忆引擎 =====
//
// 对标 Claude Code 的智能回忆机制：
// 不是全量注入所有记忆，而是根据当前用户输入做相关性打分，
// 只注入 top-N 条最相关记忆。
//
// 两阶段设计：
// Phase 1（当前实现）：确定性评分 — 关键词匹配 + 标签匹配 + 时效加权 + 分类加权
// Phase 2（预留）：模型评分 — 当记忆数超过阈值时，用 connector 做一次 side query 打分
//
// 使用方式：
//   import { recallMemories } from "./recall";
//   const top = await recallMemories("帮我部署 cd", allMemories, { workspace: "/path" });
//   // top = [{ memory, score }, ...] 最多 maxResults 条

import type { LongTermMemory, MemoryCategory } from "./longterm";

/** 回忆上下文 */
export interface RecallContext {
  /** 当前工作区路径（用于 project_context 匹配） */
  workspace?: string;
  /** 附件路径列表 */
  attachments?: string[];
}

/** 带分数的记忆 */
export interface ScoredMemory {
  memory: LongTermMemory;
  score: number; // 0 ~ 1
}

/** 回忆配置 */
export interface RecallConfig {
  /** 注入上限 */
  maxResults: number;
  /** 最低分数阈值，低于此值不注入 */
  threshold: number;
  /** 超过此数量时考虑用模型评分（Phase 2 预留） */
  modelScanningThreshold: number;
}

const DEFAULT_CONFIG: RecallConfig = {
  maxResults: 5,
  threshold: 0.15,
  modelScanningThreshold: 20,
};

// ===== 分词器 =====

/** 中文停用词 */
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一",
  "上", "也", "到", "说", "要", "去", "你", "会", "着", "没", "看", "好",
  "这", "那", "他", "她", "它", "们", "个", "中", "来", "对", "下", "为",
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "by", "for", "with", "as", "from",
  "and", "or", "but", "not", "no", "if", "then", "this", "that", "it",
  "do", "does", "did", "can", "could", "would", "should", "will",
  "me", "my", "we", "our", "you", "your", "he", "she", "they", "them",
]);

/**
 * 分词：中英文混合分词
 *
 * 英文按空格/标点拆分，中文按字符拆分（2-gram + 单字）。
 * 过滤停用词，全部小写。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // 英文词（连续字母+数字）
  const enWords = lower.match(/[a-z0-9]+/g) || [];
  for (const w of enWords) {
    if (w.length >= 2 && !STOP_WORDS.has(w)) {
      tokens.push(w);
    }
  }

  // 中文字符（单字 + 2-gram）
  const cnChars = lower.match(/[\u4e00-\u9fff]+/g) || [];
  for (const segment of cnChars) {
    const chars = segment.split("");
    // 单字
    for (const c of chars) {
      if (!STOP_WORDS.has(c)) tokens.push(c);
    }
    // 2-gram（捕获词组）
    for (let i = 0; i < chars.length - 1; i++) {
      tokens.push(chars[i] + chars[i + 1]);
    }
  }

  return tokens;
}

/** 提取路径中的有意义片段（目录名/文件名） */
function extractPathTokens(paths: string[]): string[] {
  const tokens: string[] = [];
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    // 取最后 2-3 段（项目名/目录名）
    const relevant = parts.slice(-3);
    for (const part of relevant) {
      const lower = part.toLowerCase();
      // 拆驼峰、拆连字符
      const subParts = lower.split(/[-_]/);
      for (const sp of subParts) {
        if (sp.length >= 2) tokens.push(sp);
      }
    }
  }
  return tokens;
}

// ===== 评分 =====

/** 分类权重：不同类型的记忆在不同场景下的重要性 */
/**
 * 单字 token 的匹配权重。
 *
 * 中文分词为「单字 + 2-gram」滑窗，单字缺乏语义区分度：
 * 「召回」拆出的「回」、「打包」拆出的「包」在大量无关文本中都会命中。
 * 降权后，仅命中单字的记忆难以越过召回阈值，而命中 2-gram
 * （即真正的词）仍能拿到高分。
 */
const WEAK_TOKEN_WEIGHT = 0.3;

const CATEGORY_WEIGHTS: Record<MemoryCategory, number> = {
  user_preference: 0.9, // 用户偏好几乎总是相关
  feedback: 0.7,        // 行为反馈较高
  project_context: 0.6, // 取决于是否匹配工作区
  workflow: 0.5,        // 工作流中等
};

/**
 * 对单条记忆打分
 *
 * 结构：相关性做闸门，其余维度做乘性加成。
 *
 * 相关性（决定是否入选，零相关直接 0 分）：
 * 1. 关键词匹配（占 0.7）— 用户输入分词 vs 记忆内容分词的交集比例
 * 2. 标签匹配（占 0.3）— 用户输入分词 vs 记忆 tags 的交集
 *
 * 加成（只在相关项之间拉开差距，不构成保底分）：
 * 3. 时效性 — 7天内满分，30天衰减到 0.3
 * 4. 分类加权 — user_preference > feedback > project_context > workflow
 * 5. 路径匹配 — project_context 类记忆如果 workspace 路径匹配则加分
 *
 * total = relevance * (0.75 + 0.25 * 加成均值)，因此 total <= relevance。
 */
export function scoreMemory(
  memory: LongTermMemory,
  queryTokens: string[],
  context?: RecallContext
): number {
  // 空查询：只看时效和分类
  if (queryTokens.length === 0) {
    const recency = computeRecency(memory.updatedAt);
    const catWeight = CATEGORY_WEIGHTS[memory.category] || 0.5;
    return recency * 0.5 + catWeight * 0.5;
  }

  // 1. 关键词匹配
  //
  // 单字 token 降权：中文分词是「单字 + 2-gram」滑窗，没有真正的词边界。
  // 短查询（2-3 字）拆出的单字很容易在无关文本里命中——例如「召回」拆出
  // 的「回」几乎处处都有，会把无关记忆抬进结果。
  // 因此单字按 WEAK_TOKEN_WEIGHT 计，2-gram 及以上按 1 计，
  // 分母同步用加权总和，使「只命中单字」难以越过阈值。
  const memoryTokens = new Set(tokenize(memory.content));
  let hitWeight = 0;
  let totalWeight = 0;
  for (const t of queryTokens) {
    const w = t.length === 1 ? WEAK_TOKEN_WEIGHT : 1;
    totalWeight += w;
    if (memoryTokens.has(t)) hitWeight += w;
  }
  const keywordScore = totalWeight > 0
    ? Math.min(1, hitWeight / Math.min(totalWeight, 8))
    : 0;

  // 2. 标签匹配（同样对单字降权）
  const tagSet = new Set(memory.tags.map(t => t.toLowerCase()));
  let tagHitWeight = 0;
  for (const t of queryTokens) {
    if (tagSet.has(t)) tagHitWeight += t.length === 1 ? WEAK_TOKEN_WEIGHT : 1;
  }
  const tagScore = totalWeight > 0
    ? Math.min(1, tagHitWeight / Math.min(totalWeight, 4))
    : 0;

  // 3. 时效性
  const recencyScore = computeRecency(memory.updatedAt);

  // 4. 分类加权
  const catScore = CATEGORY_WEIGHTS[memory.category] || 0.5;

  // 5. 路径匹配（仅对 project_context 有效）
  let pathScore = 0;
  if (memory.category === "project_context" && context?.workspace) {
    const ctxTokens = new Set(extractPathTokens([context.workspace, ...(context.attachments || [])]));
    const memPathTokens = extractPathTokens(
      memory.content.split(/\s+/).filter(s => s.includes("/"))
    );
    if (memPathTokens.length > 0) {
      let pathHits = 0;
      for (const t of memPathTokens) {
        if (ctxTokens.has(t)) pathHits++;
      }
      pathScore = Math.min(1, pathHits / memPathTokens.length);
    }
  }

  // 加权汇总
  //
  // 相关性（关键词 + 标签）是闸门而非加分项：
  // 早期用加法汇总，recency*0.10 + catScore*0.10 构成了与查询无关的保底分
  // （7 天内的 feedback 类记忆保底 0.17 > 阈值 0.15），
  // 导致任何查询都能让全部近期记忆「通过」，召回退化成「最近 N 条」。
  //
  // 现在：零相关直接 0 分；时效/分类/路径只在相关项之间做区分，
  // 且以乘性加成参与，保证 total <= relevance。
  const relevance = Math.min(1, keywordScore * 0.7 + tagScore * 0.3);
  if (relevance <= 0) return 0;

  const boost = (recencyScore + catScore + pathScore) / 3;
  const total = relevance * (0.75 + 0.25 * boost);

  return Math.min(1, total);
}

/** 时效性评分：7天内满分，30天衰减到 0.3 */
function computeRecency(updatedAt: string): number {
  const now = Date.now();
  const updated = new Date(updatedAt).getTime();
  const days = (now - updated) / (1000 * 60 * 60 * 24);
  if (days <= 7) return 1;
  if (days <= 30) return 1 - (days - 7) / 23 * 0.7; // 7天→1.0, 30天→0.3
  if (days <= 90) return Math.max(0.1, 0.3 - (days - 30) / 60 * 0.2);
  return 0.05;
}

// ===== 回忆入口 =====

let config: RecallConfig = { ...DEFAULT_CONFIG };

/** 更新配置 */
export function updateRecallConfig(partial: Partial<RecallConfig>): void {
  config = { ...config, ...partial };
}

/** 获取配置 */
export function getRecallConfig(): RecallConfig {
  return { ...config };
}

/**
 * 智能回忆：对所有记忆打分、排序、截断
 *
 * @param query 用户输入（原始文本）
 * @param memories 全部长期记忆
 * @param context 回忆上下文（工作区路径等）
 * @returns 按分数降序排列的记忆列表，最多 maxResults 条
 */
export function recallMemories(
  query: string,
  memories: LongTermMemory[],
  context?: RecallContext
): ScoredMemory[] {
  if (memories.length === 0) return [];

  const queryTokens = tokenize(query);

  const scored = memories.map(m => ({
    memory: m,
    score: scoreMemory(m, queryTokens, context),
  }));

  // 过滤低于阈值的
  const filtered = scored.filter(s => s.score >= config.threshold);

  // 降序排列
  filtered.sort((a, b) => b.score - a.score);

  // 截断
  return filtered.slice(0, config.maxResults);
}

/**
 * Phase 2 预留：模型评分接口
 *
 * 当记忆数量超过 modelScanningThreshold 时，用 connector 做一次 side query：
 * "Given this user message, rate the relevance of each memory (0-10)."
 *
 * 当前不实现，返回 null。调用方应回退到确定性评分。
 */
export async function modelBasedRecall(
  _query: string,
  _memories: LongTermMemory[],
  _context?: RecallContext
): Promise<ScoredMemory[] | null> {
  // TODO Phase 2: 当记忆 > modelScanningThreshold 时用模型打分
  // 需要一个轻量级 model query 接口（当前 connector.send 是流式的，太重）
  return null;
}

/**
 * 智能回忆入口（异步，自动选择 Phase 1 / Phase 2）
 *
 * 先尝试模型评分，失败则回退到确定性评分。
 */
export async function smartRecall(
  query: string,
  memories: LongTermMemory[],
  context?: RecallContext
): Promise<ScoredMemory[]> {
  // 记忆数量超过阈值时尝试模型评分
  if (memories.length >= config.modelScanningThreshold) {
    const modelResult = await modelBasedRecall(query, memories, context);
    if (modelResult && modelResult.length > 0) return modelResult;
  }

  // 默认走确定性评分
  return recallMemories(query, memories, context);
}
