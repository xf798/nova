// ===== /distill 命令 =====
//
// 蒸馏当前会话（或最近 N 天会话）的经验，产出候选交审阅面板。
//
// 用法：
//   /distill                蒸馏当前会话
//   /distill --recent 3d    蒸馏最近 3 天的会话
//   /distill --recent 5     蒸馏最近 5 天的会话

import { connectorInstances } from "../../connectors/instance-manager";
import { useSessionStore } from "../sessionStore";
import { distillSessions } from "../distill";
import type { SlashCommand, CommandContext } from "./registry";

/** 解析 --recent Nd / --recent N，返回天数（未指定返回 null） */
function parseRecentDays(argsRaw: string): number | null {
  const m = argsRaw.match(/--recent\s+(\d+)\s*d?/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 选取要蒸馏的会话 ID 列表 */
function resolveSessionIds(ctx: CommandContext, recentDays: number | null): string[] {
  const sessions = useSessionStore.getState().sessions;
  if (recentDays != null) {
    const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
    return sessions
      .filter((s) => new Date(s.updatedAt || s.createdAt).getTime() >= cutoff)
      .map((s) => s.id);
  }
  // 默认：当前会话
  return ctx.sessionId ? [ctx.sessionId] : [];
}

/** 触发蒸馏（命令与工具栏按钮共用） */
export async function runDistill(ctx: CommandContext, argsRaw = ""): Promise<void> {
  const recentDays = parseRecentDays(argsRaw);
  const force = /--all|--force/i.test(argsRaw);
  const sessionIds = resolveSessionIds(ctx, recentDays);

  if (sessionIds.length === 0) {
    ctx.notify("没有可蒸馏的会话", "error");
    return;
  }

  ctx.notify(
    recentDays != null ? `正在蒸馏最近 ${recentDays} 天的 ${sessionIds.length} 个会话…` : force ? "正在全量蒸馏当前会话…" : "正在蒸馏当前会话…",
    "info",
  );

  const connector = connectorInstances.createTemporary("distill-bg");
  try {
    const result = await distillSessions(sessionIds, connector, {
      force,
      onProgress: (stage) => {
        window.dispatchEvent(new CustomEvent("nova-notify", { detail: { msg: `蒸馏：${stage}`, type: "info" } }));
      },
    });

    // 被跳过：给出明确原因
    if (result.skipped) {
      const msg =
        result.skipped === "no_new_content"
          ? "本会话自上次蒸馏后无新内容（用 /distill --all 全量重蒸）"
          : result.skipped === "below_min_turns"
          ? "新增对话太少，暂不蒸馏（可继续对话或用 /distill --all）"
          : "蒸馏未启用";
      ctx.notify(msg, "info");
      return;
    }

    const total = result.memories.length + result.skills.length + result.playbooks.length;
    if (total === 0) {
      ctx.notify("本次没有蒸馏出可沉淀的经验", "info");
      return;
    }

    ctx.notify(
      `蒸馏完成：${result.memories.length} 记忆 / ${result.skills.length} 技能 / ${result.playbooks.length} 工作流，请审阅`,
      "success",
    );
    // 打开审阅面板
    window.dispatchEvent(new CustomEvent("nova-open-preview", { detail: { type: "distill", data: result } }));
  } finally {
    connector.dispose().catch(() => {});
  }
}

export const distillCommand: SlashCommand = {
  name: "distill",
  aliases: ["skillify"],
  description: "蒸馏会话经验为 记忆/技能/工作流（/distill 增量 | /distill --all 全量 | /distill --recent 3d）",
  run: runDistill,
};
