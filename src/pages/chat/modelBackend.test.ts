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

describe("后端解析", () => {  it("企微会话（connectorId=wecom-bot）回落到 cli，因此能切模型", () => {
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

// ===== 切换连接器后的模型归属 =====
//
// 实际 bug：切到别的连接器后，模型选择器仍显示上一个连接器的模型。
// 三处成因：
//   1. session.modelId 是旧连接器的模型，切换时没清（按钮回显它）
//   2. 下拉列表只在 models.length === 0 时加载，切换后不刷新
//   3. 无会话时 pendingModel 里的暂存值同样属于旧连接器
// 留着旧 modelId 不只是显示问题：发送时会把它 setModel 给新连接器。

/** 复刻 ConnectorSelector 切换后写回的会话字段 */
function metaAfterSwitch(newConnectorId: string): { connectorId: string; modelId: string | undefined } {
  return { connectorId: newConnectorId, modelId: undefined };
}

/** 复刻按钮回显：session.modelId → pendingSelection → Auto */
function displayModel(sessionModelId?: string, pendingSelection?: string): string {
  return sessionModelId || pendingSelection || "auto";
}

/** 复刻列表缓存判定：只有「已加载的后端」与当前后端一致才复用 */
function shouldReloadModels(loadedFor: string | null, backendId: string): boolean {
  return loadedFor !== backendId;
}

describe("切换连接器后的模型归属", () => {
  it("切换后清掉会话上的旧模型，回显回到 Auto", () => {
    const meta = metaAfterSwitch("glm-4");
    expect(meta.connectorId).toBe("glm-4");
    expect(meta.modelId).toBeUndefined();
    expect(displayModel(meta.modelId, undefined)).toBe("auto");
  });

  it("不清的话会回显旧连接器的模型（修复前的表现）", () => {
    expect(displayModel("claude-sonnet-5", undefined)).toBe("claude-sonnet-5");
  });

  it("无会话时暂存值也要清，否则同样串台", () => {
    expect(displayModel(undefined, undefined)).toBe("auto");
    expect(displayModel(undefined, "claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("后端变化时必须重新拉模型列表", () => {
    expect(shouldReloadModels("kiro-cli", "glm-4")).toBe(true);
  });

  it("同一后端复用缓存，不重复请求", () => {
    expect(shouldReloadModels("kiro-cli", "kiro-cli")).toBe(false);
  });

  it("首次打开（未加载过）要拉列表", () => {
    expect(shouldReloadModels(null, "kiro-cli")).toBe(true);
  });
});
