// ===== New Chat 的待应用模型选择 =====
//
// 点「新对话」只把 activeSessionId 置空，会话要等首次发消息才懒创建。
// 这段空窗里选模型原本会被直接丢弃（handleSelect 开头 `if (!activeSessionId) return`），
// 表现为「切到新会话后点模型没反应」。
//
// 这批用例固定三条契约：
//   1. 无会话时的选择能暂存并回显
//   2. 会话创建时消费一次即清除，不会串到后续会话
//   3. 切走已有会话时清除，选择不跨会话泄漏

import { describe, it, expect, beforeEach, vi } from "vitest";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

const store = new MemoryStorage();
vi.stubGlobal("localStorage", store);

const { pendingModel } = await import("./pendingModel");

beforeEach(() => store.clear());

describe("暂存与读取", () => {
  it("未设置时为 undefined", () => {
    expect(pendingModel.get()).toBeUndefined();
  });

  it("设置后能读回（供按钮回显，避免选了还显示 Auto）", () => {
    pendingModel.set("claude-sonnet-4");
    expect(pendingModel.get()).toBe("claude-sonnet-4");
  });

  it("重复设置以最后一次为准", () => {
    pendingModel.set("a");
    pendingModel.set("b");
    expect(pendingModel.get()).toBe("b");
  });
});

describe("消费语义", () => {
  it("take 取出后即清除，不会被第二个会话重复应用", () => {
    pendingModel.set("claude-opus-5");
    expect(pendingModel.take()).toBe("claude-opus-5");
    expect(pendingModel.get()).toBeUndefined();
    // 第二次创建会话时拿不到，避免串档
    expect(pendingModel.take()).toBeUndefined();
  });

  it("没有暂存值时 take 返回 undefined（createSession 会当作未指定）", () => {
    expect(pendingModel.take()).toBeUndefined();
  });

  it("clear 后读不到", () => {
    pendingModel.set("x");
    pendingModel.clear();
    expect(pendingModel.get()).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe("不跨会话泄漏", () => {
  it("切到已有会话时清除，选择不该落到之后新建的会话上", () => {
    // 场景：点新对话 → 选了模型 → 没发消息就切到别的会话
    pendingModel.set("glm-4");
    pendingModel.clear(); // handleSwitchSession 里做的事
    // 之后再点新对话并发消息，不应继承那个选择
    expect(pendingModel.take()).toBeUndefined();
  });

  it("选了模型直接发消息 → 会话拿到该模型", () => {
    pendingModel.set("claude-sonnet-4");
    // ensureSession 创建会话时消费
    const applied = pendingModel.take();
    expect(applied).toBe("claude-sonnet-4");
  });
});

describe("容错", () => {
  it("localStorage 抛错时降级为 undefined 而非崩溃", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    });
    expect(pendingModel.get()).toBeUndefined();
    expect(() => pendingModel.set("x")).not.toThrow();
    expect(() => pendingModel.clear()).not.toThrow();
    expect(pendingModel.take()).toBeUndefined();
    vi.stubGlobal("localStorage", store);
  });
});
