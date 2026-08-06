// ===== 本地语义召回（TS 侧） =====
//
// 词面匹配换过三种算法都没解决「语义无关但共享泛用词」的误召回。
// 向量召回用真实记忆库实测有效：
//   「切换会话卡顿是怎么解决的」→ 0.622 命中「首屏20条+翻页30条…」
//   这两句几乎没有共同词，词面匹配完全做不到。
//
// 但也实测到一个失败模式：记忆库里没有答案时（如问 updater 签名而那条已被
// 100 条上限挤掉），模型只会返回最「泛泛相似」的（0.53 左右）。
// 因此必须有相似度下限 —— 三个成功案例首条都 ≥0.62，失败案例最高 0.533，
// 阈值取 0.60。

import { invoke } from "@tauri-apps/api/core";

/** 相似度下限。低于此值视为「库里没有相关内容」，不召回。 */
export const SEMANTIC_THRESHOLD = 0.6;

/** 语义召回在最终打分里的权重；其余给关键词 */
export const SEMANTIC_WEIGHT = 0.6;

export interface AssetState {
  name: string;
  ready: boolean;
  size: number;
}

export interface EmbeddingStatus {
  /** 三个资产是否齐备且校验通过 */
  ready: boolean;
  files: AssetState[];
  /** 已建索引的记忆条数 */
  indexedCount: number;
  model: string;
}

export interface SemanticHit {
  id: string;
  score: number;
}

export async function getEmbeddingStatus(): Promise<EmbeddingStatus> {
  try {
    return await invoke<EmbeddingStatus>("embedding_status");
  } catch (e) {
    console.warn("[Embed] 读取状态失败:", e);
    return { ready: false, files: [], indexedCount: 0, model: "" };
  }
}

/** 下载模型资产。进度通过 nova-model-download 事件回报。 */
export async function downloadModel(): Promise<void> {
  await invoke("download_embedding_model");
}

export async function removeModel(): Promise<void> {
  await invoke("remove_embedding_model");
}

/**
 * 为记忆建立/补齐索引。
 *
 * Rust 侧只编码尚未索引的条目，并清理已删除记忆的向量，
 * 所以可以放心地每次传全量。
 */
export async function indexMemories(
  items: { id: string; content: string }[],
): Promise<{ indexed: number; newlyEncoded: number }> {
  return invoke("index_memories", { items });
}

/**
 * 语义检索。
 *
 * 返回已按阈值过滤的命中；模型未就绪或出错时返回空数组，
 * 由调用方降级到关键词召回。
 */
export async function semanticSearch(query: string, topK = 10): Promise<SemanticHit[]> {
  if (!query.trim()) return [];
  try {
    const r = await invoke<{ hits: SemanticHit[] }>("semantic_search", { query, topK });
    return r.hits.filter(h => h.score >= SEMANTIC_THRESHOLD);
  } catch (e) {
    // 资产未就绪是预期情况（用户没启用），不必刷警告
    const msg = String(e);
    if (!msg.includes("未就绪")) console.warn("[Embed] 语义检索失败:", e);
    return [];
  }
}

/**
 * 把语义得分与关键词得分融合。
 *
 * 保留关键词分量的理由：精确的专有名词（minisign、commit hash、
 * rehypeHighlight）向量模型未必编码得好，而关键词匹配对这类最强。两者互补。
 *
 * 只在两侧都有分数时融合；只有一侧命中时按其权重折算，
 * 避免「另一侧为 0」把总分拉到阈值以下。
 */
export function fuseScores(semantic: number | undefined, keyword: number): number {
  if (semantic === undefined) return keyword;
  if (keyword <= 0) return semantic * SEMANTIC_WEIGHT + SEMANTIC_THRESHOLD * (1 - SEMANTIC_WEIGHT);
  return semantic * SEMANTIC_WEIGHT + keyword * (1 - SEMANTIC_WEIGHT);
}
