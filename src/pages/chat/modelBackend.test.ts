// ===== 模型切换的后端解析 =====
//
// 企微会话的 connectorId 是 wecom-bot，而它只是消息通道
// （supportsModelSwitch: false），实际回答由 cli/api 连接器生成。
// 若按 wecom-bot 的能力判断，企微会话永远看不到模型切换入口 —— 这是实际的 bug。
//
// useWecomBridge 里已有「bot 类型不能作为后端，回落到 cli」的解析规则，
// ModelSelector 必须用同一套规则，否则 UI 与实际执行不一致。

import { describe, it, expect } from "vitest";

type Conn = {
  id: string;
  type: "cli" | "api" | "bot";
  enabled: boolean;
  supportsModelSwitch: boolean;
};

const CLI: Conn = { id: "kiro-cli", type: "cli", enabled: true, supportsModelSwitch: true };
const API: Conn = { id: "glm-4", type: "api", enabled: true, supportsModelSwitch: true };
const BOT: Conn = { id: "wecom-bot", type: "bot", enabled: true, supportsModelSwitch: false };
const DISABLED_CLI: Conn = { ...CLI, enabled: false };

/** 复刻 ModelSelector 的后端解析 */
function resolveBackend(
  sessionConn: Conn | null,
  activeConn: Conn,
  cliFallback: Conn | undefined,
): Conn {
  if (sessionConn && sessionConn.type !== "bot" && sessionConn.enabled) return sessionConn;
  if (activeConn.type !== "bot") return activeConn;
  return cliFallback ?? activeConn;
}

describe("后端解析", () => {
  it("企微会话（connectorId=wecom-bot）回落到 cli，因此能切模型", () => {
    const b = resolveBackend(BOT, BOT, CLI);
    expect(b.id).toBe("kiro-cli");
    expect(b.supportsModelSwitch).toBe(true);
  });

  it("普通会话用自己的连接器", () => {
    expect(resolveBackend(CLI, API, CLI).id).toBe("kiro-cli");
  });

  it("会话连接器被禁用时回落到活跃连接器", () => {
    expect(resolveBackend(DISABLED_CLI, API, CLI).id).toBe("glm-4");
  });

  it("会话无连接器信息时用活跃连接器", () => {
    expect(resolveBackend(null, API, CLI).id).toBe("glm-4");
  });

  it("活跃连接器也是 bot 时回落到 cli", () => {
    expect(resolveBackend(null, BOT, CLI).id).toBe("kiro-cli");
  });

  it("连 cli 都没有时退回活跃连接器（不崩）", () => {
    const b = resolveBackend(BOT, BOT, undefined);
    expect(b.id).toBe("wecom-bot");
    // 此时确实不支持切换，选择器会隐藏 —— 这是正确的降级
    expect(b.supportsModelSwitch).toBe(false);
  });

  it("bot 永远不会被选作后端（只要有替代）", () => {
    for (const active of [CLI, API]) {
      expect(resolveBackend(BOT, active, CLI).type).not.toBe("bot");
    }
  });
});
