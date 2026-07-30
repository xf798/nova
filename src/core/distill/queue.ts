// ===== 蒸馏待审队列 =====
//
// 自动蒸馏产出的 Skill/Playbook（及中低可信 Memory）不直接落盘，
// 先入待审队列，用户空闲时批量审阅。
//
// 持久化：StorageService ns="distill" key="reviewQueue"。

import { StorageService } from "../storage";
import type { DistillResult } from "./types";

const NS = "distill";
const KEY = "reviewQueue";
const MAX_ITEMS = 30;

/** 待审队列条目 */
export interface ReviewItem {
  id: string;
  /** 待审的蒸馏结果（可能只含 skills/playbooks + 中低可信 memories） */
  result: DistillResult;
  /** 入队时间 */
  queuedAt: string;
}

const storage = StorageService.getInstance();

/** 读取待审队列 */
export async function getReviewQueue(): Promise<ReviewItem[]> {
  try {
    return (await storage.get<ReviewItem[]>(NS, KEY, [])) || [];
  } catch {
    return [];
  }
}

/** 入队一条待审结果 */
export async function enqueueReview(result: DistillResult): Promise<ReviewItem> {
  const queue = await getReviewQueue();
  const item: ReviewItem = {
    id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    result,
    queuedAt: new Date().toISOString(),
  };
  queue.unshift(item);
  if (queue.length > MAX_ITEMS) queue.length = MAX_ITEMS;
  await storage.set(NS, KEY, queue);
  return item;
}

/** 移除一条（审阅完成/忽略后） */
export async function removeReviewItem(id: string): Promise<void> {
  const queue = await getReviewQueue();
  await storage.set(NS, KEY, queue.filter(i => i.id !== id));
}

/** 清空队列 */
export async function clearReviewQueue(): Promise<void> {
  await storage.set(NS, KEY, []);
}

/** 待审数量 */
export async function getReviewCount(): Promise<number> {
  return (await getReviewQueue()).length;
}
