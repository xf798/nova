// ===== 会话经验蒸馏 — 配置读写 =====
//
// 配置持久化到 StorageService 命名空间 "distill"，供 Settings 页面读写。

import { StorageService } from "../storage";
import { DEFAULT_DISTILL_CONFIG } from "./types";
import type { DistillConfig } from "./types";

const NS = "distill";
const KEY = "config";

/** 读取蒸馏配置（合并默认值） */
export async function getDistillConfig(): Promise<DistillConfig> {
  try {
    const stored = await StorageService.getInstance().get<Partial<DistillConfig>>(NS, KEY, {});
    return { ...DEFAULT_DISTILL_CONFIG, ...(stored || {}) };
  } catch {
    return { ...DEFAULT_DISTILL_CONFIG };
  }
}

/** 保存蒸馏配置（部分更新） */
export async function saveDistillConfig(patch: Partial<DistillConfig>): Promise<DistillConfig> {
  const current = await getDistillConfig();
  const next = { ...current, ...patch };
  await StorageService.getInstance().set(NS, KEY, next);
  return next;
}
