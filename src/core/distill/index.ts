// ===== 会话经验蒸馏 — 模块出口 =====

export type {
  ArtifactConfidence,
  MemoryCandidate,
  SkillCandidate,
  PlaybookCandidate,
  DistillResult,
  DistillConfig,
} from "./types";
export { DEFAULT_DISTILL_CONFIG, emptyDistillResult } from "./types";
export { distillSessions } from "./distiller";
export type { DistillOptions } from "./distiller";
export { applyDistillResult, buildSkillMd, buildPlaybookMd, filterAutoApply, DISTILLED_TAG } from "./apply";
export type { ApplyStats } from "./apply";
export { getDistillConfig, saveDistillConfig } from "./config";
export {
  getReviewQueue,
  enqueueReview,
  removeReviewItem,
  clearReviewQueue,
  getReviewCount,
} from "./queue";
export type { ReviewItem } from "./queue";
export {
  registerDistillJob,
  ensureDefaultDistillJobs,
  setAutoDistillEnabled,
} from "./autoJob";
