// ===== 发送后的停止保护期 =====
//
// 真实事故：发送与停止是同一位置的按钮，发送后停止按钮瞬间出现在鼠标下，
// 第二次点击把刚发出的请求掐掉。日志里 10:48:51 发出、10:48:52 abort、
// 正文 0 字符，同一条输入 5 秒后被重发，用户以为「任务自行停止」。
//
// 这批用例同时守住反向的坑：保护期不能吞掉真正的停止需求。

import { describe, it, expect } from "vitest";
import { SEND_GUARD_MS, showStopButton } from "./sendGuard";

const base = { isProcessing: true, hasInput: false, hasAttachments: false, withinSendGuard: false };

describe("showStopButton", () => {
  it("处理中且输入框为空 → 展示停止", () => {
    expect(showStopButton(base)).toBe(true);
  });

  it("发送保护期内不展示停止（这一下点击不会掐掉请求）", () => {
    expect(showStopButton({ ...base, withinSendGuard: true })).toBe(false);
  });

  it("保护期结束后恢复停止能力", () => {
    expect(showStopButton({ ...base, withinSendGuard: false })).toBe(true);
  });

  it("空闲时不展示停止", () => {
    expect(showStopButton({ ...base, isProcessing: false })).toBe(false);
  });

  it("有待发文本时按钮属于「加入队列」，不能是停止", () => {
    expect(showStopButton({ ...base, hasInput: true })).toBe(false);
  });

  it("只有附件也算待发，不能是停止", () => {
    expect(showStopButton({ ...base, hasAttachments: true })).toBe(false);
  });

  it("保护期足够覆盖双击间隔，又不至于挡住真实停止", () => {
    // 系统双击阈值通常 500ms 内；人主动想停止不会快于 800ms 再点一下
    expect(SEND_GUARD_MS).toBeGreaterThanOrEqual(500);
    expect(SEND_GUARD_MS).toBeLessThanOrEqual(1500);
  });
});
