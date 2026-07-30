// ===== 自动蒸馏 job（调度引擎处理器） =====
//
// 由调度引擎在「会话闲置」或「每日定时」触发：
// 1. 挑选自上次自动蒸馏以来有更新的会话
// 2. 蒸馏
// 3. 高可信 Memory 自动落盘（可配置）；Skill/Playbook + 中低可信 Memory 入待审队列
//
// 默认创建两个 job（均默认关闭，用户在 Settings 开启）：
// - 闲置蒸馏：idle 15min
// - 每日蒸馏：daily 23:30
// 两者共享水位线去重，不会重复蒸馏未变更的会话。

import { StorageService } from "../storage";
import { connectorInstances } from "../../connectors/instance-manager";
import { useSessionStore } from "../sessionStore";
import { scheduler } from "../scheduler";
import type { JobHandlerResult, ScheduledJob } from "../scheduler";
import { distillSessions } from "./distiller";
import { applyDistillResult } from "./apply";
import { enqueueReview } from "./queue";
import { getDistillConfig } from "./config";
import type { DistillResult } from "./types";

const NS = "distill";
const KEY_WATERMARK = "lastAutoDistillAt";
const DISTILL_JOB_TYPE = "distill";
/** 单次自动蒸馏最多处理的会话数（控成本） */
const MAX_SESSIONS_PER_RUN = 8;

const storage = StorageService.getInstance();

async function getWatermark(): Promise<number> {
  try {
    const v = await storage.get<number>(NS, KEY_WATERMARK, 0);
    return v || 0;
  } catch {
    return 0;
  }
}

async function setWatermark(ts: number): Promise<void> {
  try { await storage.set(NS, KEY_WATERMARK, ts); } catch {}
}

/** 自动蒸馏处理器 */
async function autoDistillHandler(job: ScheduledJob): Promise<JobHandlerResult> {
  const cfg = await getDistillConfig();
  // 运行时门控只看两处：蒸馏功能总开关 cfg.enabled + 调度器已过滤的 job.enabled。
  // 不再用 cfg.autoDistillEnabled 二次拦截，避免"独立开关白点"。
  if (!cfg.enabled) {
    return { ok: true, message: "蒸馏功能未启用，跳过" };
  }

  // scope 分工：active=只蒸当前会话（闲置触发）；recent=扫所有最近更新会话（每日兜底）
  // 旧 job 无 payload.scope 时按触发类型兜底推断
  const scope: "active" | "recent" =
    job.payload?.scope ?? (job.trigger.kind === "idle" ? "active" : "recent");

  const now = Date.now();
  let targetSessionIds: string[];

  if (scope === "active") {
    // 只蒸当前活跃会话（趁热沉淀刚聊完的这个）；per-session 水位线负责去重
    const activeId = useSessionStore.getState().activeSessionId;
    if (!activeId) {
      return { ok: true, message: "无活跃会话，跳过" };
    }
    targetSessionIds = [activeId];
  } else {
    // 扫所有自上次以来有更新的会话（全局水位线预筛 + 限量）
    const watermark = await getWatermark();
    const sessions = useSessionStore.getState().sessions
      .filter(s => new Date(s.updatedAt || s.createdAt).getTime() > watermark)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, MAX_SESSIONS_PER_RUN);
    if (sessions.length === 0) {
      await setWatermark(now);
      return { ok: true, message: "无新会话需蒸馏" };
    }
    targetSessionIds = sessions.map(s => s.id);
  }

  const connector = connectorInstances.createTemporary("auto-distill");
  try {
    const result = await distillSessions(targetSessionIds, connector);

    if (result.skipped) {
      if (scope === "recent") await setWatermark(now);
      return { ok: true, message: result.skipped === "no_new_content" ? "无新增内容" : `已跳过（${result.skipped}）` };
    }

    const total = result.memories.length + result.skills.length + result.playbooks.length;

    if (total === 0) {
      if (scope === "recent") await setWatermark(now);
      return { ok: true, message: `蒸馏 ${targetSessionIds.length} 会话，无可沉淀内容` };
    }

    // 高可信 Memory → 自动落盘（可配置）
    let autoMemories = 0;
    if (cfg.autoApplyHighConfidenceMemory) {
      const highMems = result.memories.filter(m => m.confidence === "high");
      if (highMems.length > 0) {
        const stats = await applyDistillResult({ memories: highMems });
        autoMemories = stats.memoriesSaved;
      }
    }

    // 其余（Skill/Playbook + 未自动落盘的 Memory）→ 待审队列
    const queued: DistillResult = {
      ...result,
      memories: cfg.autoApplyHighConfidenceMemory
        ? result.memories.filter(m => m.confidence !== "high")
        : result.memories,
    };
    const queuedTotal = queued.memories.length + queued.skills.length + queued.playbooks.length;
    if (queuedTotal > 0) {
      await enqueueReview(queued);
      // 提醒
      window.dispatchEvent(new CustomEvent("nova-notify", {
        detail: { msg: `自动蒸馏：${queuedTotal} 项待审（含 ${queued.skills.length} 技能 / ${queued.playbooks.length} 工作流）`, type: "info" },
      }));
      window.dispatchEvent(new CustomEvent("nova-distill-queue-changed"));
    }

    if (scope === "recent") await setWatermark(now);
    return {
      ok: true,
      message: `蒸馏 ${targetSessionIds.length} 会话，落盘记忆 ${autoMemories} 条${queuedTotal > 0 ? `，另 ${queuedTotal} 项入队` : ""}`,
    };
  } finally {
    connector.dispose().catch(() => {});
  }
}

/** 注册自动蒸馏处理器（幂等） */
export function registerDistillJob(): void {
  if (!scheduler.hasHandler(DISTILL_JOB_TYPE)) {
    scheduler.registerHandler(DISTILL_JOB_TYPE, autoDistillHandler);
  }
}

/** 确保默认 job 存在（首次创建，默认关闭） */
export async function ensureDefaultDistillJobs(): Promise<void> {
  const existing = scheduler.getJobs().filter(j => j.type === DISTILL_JOB_TYPE);

  // 清理旧版遗留的、含"待审"字样的运行摘要（避免进应用误以为当前有待审）
  for (const j of existing) {
    if (j.lastMessage && j.lastMessage.includes("待审")) {
      await scheduler.upsertJob({ ...j, lastMessage: undefined });
    }
  }

  if (existing.length > 0) return;

  await scheduler.createJob({
    name: "自动蒸馏（会话闲置）",
    type: DISTILL_JOB_TYPE,
    trigger: { kind: "idle", afterMinutes: 15 },
    payload: { scope: "active" },
    enabled: false,
  });
  await scheduler.createJob({
    name: "自动蒸馏（每日兜底）",
    type: DISTILL_JOB_TYPE,
    trigger: { kind: "daily", at: "23:30" },
    payload: { scope: "recent" },
    enabled: false,
  });
  console.log("[Distill] 默认自动蒸馏 job 已创建（默认关闭）");
}

/** 统一开关：启用/停用所有自动蒸馏 job */
export async function setAutoDistillEnabled(enabled: boolean): Promise<void> {
  const jobs = scheduler.getJobs().filter(j => j.type === DISTILL_JOB_TYPE);
  for (const j of jobs) {
    await scheduler.setEnabled(j.id, enabled);
  }
}
