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
import { extractMeaningful } from "./recallGate";

/**
 * 相似度下限。低于此值视为「库里没有相关内容」，不召回。
 *
 * 0.55 来自实测校准（6 组口语提问 × 5 个候选阈值）：
 *   0.45 / 0.50  命中 5/6，平均返回 4.2 条
 *   0.55         命中 5/6，平均返回 3.7 条  ← 命中率相同但更精简
 *   0.60         命中 3/6，漏掉一半
 *
 * 一开始定的 0.60 太高，是因为只用了 4 个书面化查询校准。换成口语提问
 * （「之前那个切换慢是怎么弄的」）后发现相关内容落在 0.50-0.60：
 * 记忆是书面技术总结，提问是口语，语义相近但表达风格差得远。
 */
export const SEMANTIC_THRESHOLD = 0.55;

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
 * 返回已按阈值与词面锚点过滤的命中；模型未就绪或出错时返回空数组，
 * 由调用方降级到关键词召回。
 */
export async function semanticSearch(
  query: string,
  topK = 10,
  /** 记忆正文，用于词面锚点过滤；不传则跳过该过滤 */
  contents?: Map<string, string>,
): Promise<SemanticHit[]> {
  if (!query.trim()) return [];
  try {
    const r = await invoke<{ hits: SemanticHit[] }>("semantic_search", { query, topK });
    let hits = r.hits.filter(h => h.score >= SEMANTIC_THRESHOLD);
    if (contents) {
      hits = hits.filter(h => {
        const c = contents.get(h.id);
        return c === undefined || hasLexicalAnchor(query, c);
      });
    }
    return hits;
  } catch (e) {
    // 资产未就绪是预期情况（用户没启用），不必刷警告
    const msg = String(e);
    if (!msg.includes("未就绪")) console.warn("[Embed] 语义检索失败:", e);
    return [];
  }
}

/**
 * 语义候选是否与查询有词面交集。
 *
 * 小模型（24M 参数）能抓住话题但对**主语**区分不足。实测
 * 「之前那个切换慢是怎么弄的」召回到「录音mode2修复方案简化」(0.590)，
 * 与正确答案 (0.599) 仅差 0.009 —— 两者都在讲「某问题怎么修的」，
 * 模型抓到了「修复/方案/简化」这层共性，却没能分开「切换」与「录音」。
 * 这种 0.01 的差距不是调阈值能解决的。
 *
 * 加一道词面锚点：语义命中还必须与查询共享至少一个 2-gram。
 * 实测 5 组案例全部「目标保留 + 噪音拦截」。
 *
 * 这不是退回词面匹配 —— 语义仍决定排序与召回范围，词面只做否决，
 * 挡掉「话题相近但主语不同」这一类。查询无实义片段时不过滤（交给闸门）。
 */
export function hasLexicalAnchor(query: string, content: string): boolean {
  const segments = extractMeaningful(query);
  if (segments.length === 0) return true;

  const grams = new Set<string>();
  for (const s of segments) {
    for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
    // 纯英数片段（技术名词）整体作为锚点
    if (/^[a-zA-Z0-9]+$/.test(s)) grams.add(s.toLowerCase());
  }
  if (grams.size === 0) return true;

  const lower = content.toLowerCase();
  for (const g of grams) {
    if (lower.includes(g)) return true;
  }
  return false;
}

/**
 * RRF（倒数排名融合）的平滑常数。
 *
 * 越小则头部排名的权重越突出。候选集只有几条，取 10 比常用的 60 更合适。
 */
const RRF_K = 10;

/**
 * 融合语义与关键词两路召回。
 *
 * 用排名而非分数：两侧分数量纲完全不同（语义是余弦 0.55-0.75，
 * 关键词是自定义公式 0.15-0.70），加权平均会出现
 * 「语义 0.60 + 关键词 0.168」的融合分(0.427)低于「只有语义 0.60」(0.58)
 * 的荒谬结果 —— 关键词命中反而把排名拉低。
 *
 * RRF 只看各路的名次，天然免疫量纲差异，是组合异构检索的标准做法。
 * 权重体现在 SEMANTIC_WEIGHT：语义路的贡献更大，但关键词路仍能把
 * 精确命中专有名词（minisign、commit hash）的条目推上来。
 */
export function fuseRanked(
  semanticOrder: string[],
  keywordOrder: string[],
): Map<string, number> {
  const scores = new Map<string, number>();
  const add = (id: string, rank: number, weight: number) => {
    scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + rank + 1));
  };
  semanticOrder.forEach((id, i) => add(id, i, SEMANTIC_WEIGHT));
  keywordOrder.forEach((id, i) => add(id, i, 1 - SEMANTIC_WEIGHT));
  return scores;
}
