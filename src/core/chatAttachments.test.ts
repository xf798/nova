import { describe, it, expect, beforeEach, vi } from "vitest";

// 测试环境是 node，没有 localStorage；打一个最小桩而不引入 jsdom
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
  keys() { return [...this.map.keys()]; }
}

const store = new MemoryStorage();
vi.stubGlobal("localStorage", store);

const { chatAttachments } = await import("./chatAttachments");

beforeEach(() => store.clear());

describe("chatAttachments — 基本读写", () => {
  it("未设置过时返回空数组", () => {
    expect(chatAttachments.get("s1")).toEqual([]);
  });

  it("写入后能读回", () => {
    chatAttachments.set("s1", ["/a.png", "/b.png"]);
    expect(chatAttachments.get("s1")).toEqual(["/a.png", "/b.png"]);
  });

  it("清空后读回空数组", () => {
    chatAttachments.set("s1", ["/a.png"]);
    chatAttachments.clear("s1");
    expect(chatAttachments.get("s1")).toEqual([]);
  });

  it("写入空数组等同于删除，不留空键", () => {
    chatAttachments.set("s1", ["/a.png"]);
    chatAttachments.set("s1", []);
    expect(store.size).toBe(0);
  });
});

describe("chatAttachments — 会话隔离", () => {
  it("不同会话互不影响", () => {
    chatAttachments.set("s1", ["/a.png"]);
    chatAttachments.set("s2", ["/b.png"]);
    expect(chatAttachments.get("s1")).toEqual(["/a.png"]);
    expect(chatAttachments.get("s2")).toEqual(["/b.png"]);
  });

  it("清空一个会话不影响另一个", () => {
    chatAttachments.set("s1", ["/a.png"]);
    chatAttachments.set("s2", ["/b.png"]);
    chatAttachments.clear("s1");
    expect(chatAttachments.get("s1")).toEqual([]);
    expect(chatAttachments.get("s2")).toEqual(["/b.png"]);
  });

  it("null 走独立的 New Chat 槽，不与具名会话混用", () => {
    chatAttachments.set(null, ["/new.png"]);
    chatAttachments.set("s1", ["/a.png"]);
    expect(chatAttachments.get(null)).toEqual(["/new.png"]);
    expect(chatAttachments.get("s1")).toEqual(["/a.png"]);
  });
});

describe("chatAttachments — 切换会话的语义", () => {
  // 复现 ChatView 的切换流程：存回原会话 → 载入目标会话
  const switchTo = (from: string | null, current: string[], to: string | null) => {
    chatAttachments.set(from, current);
    return chatAttachments.get(to);
  };

  it("切到没有附件的会话时得到空数组，不带过去", () => {
    expect(switchTo("s1", ["/a.png"], "s2")).toEqual([]);
  });

  it("切回原会话时恢复该会话未发出的附件", () => {
    chatAttachments.set("s1", ["/a.png"]);
    const inS2 = switchTo("s1", ["/a.png"], "s2");
    expect(inS2).toEqual([]);
    expect(switchTo("s2", [], "s1")).toEqual(["/a.png"]);
  });

  it("两个会话各自的附件在来回切换后都不丢", () => {
    chatAttachments.set("s1", ["/a.png"]);
    chatAttachments.set("s2", ["/b.png"]);
    expect(switchTo("s1", ["/a.png"], "s2")).toEqual(["/b.png"]);
    expect(switchTo("s2", ["/b.png"], "s1")).toEqual(["/a.png"]);
  });
});

describe("chatAttachments — 发送后的清理", () => {
  it("发送后来源会话不留记录", () => {
    chatAttachments.set("s1", ["/a.png"]);
    // 对应 handleSend 里的显式清除
    chatAttachments.clear("s1");
    expect(chatAttachments.get("s1")).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("在 New Chat 里带附件发送后，New Chat 槽不残留", () => {
    // 复现：activeSessionId 为 null 时选了附件，发送时新建了会话 s1
    chatAttachments.set(null, ["/a.png"]);
    chatAttachments.clear(null); // handleSend 显式清除来源（此时 ref 仍是 null）
    expect(chatAttachments.get(null)).toEqual([]);
    // 之后再开 New Chat 不该看到上次那张图
    expect(chatAttachments.get(null)).not.toContain("/a.png");
  });

  it("发送只清来源会话，其他会话的待发附件保留", () => {
    chatAttachments.set("s1", ["/a.png"]);
    chatAttachments.set("s2", ["/b.png"]);
    chatAttachments.clear("s1");
    expect(chatAttachments.get("s2")).toEqual(["/b.png"]);
  });
});

describe("chatAttachments — 容错", () => {
  it("存储内容不是 JSON 时返回空数组", () => {
    store.setItem("nova-chat-attachments:s1", "not json");
    expect(chatAttachments.get("s1")).toEqual([]);
  });

  it("存储内容是对象而非数组时返回空数组", () => {
    store.setItem("nova-chat-attachments:s1", '{"a":1}');
    expect(chatAttachments.get("s1")).toEqual([]);
  });

  it("数组内非字符串项被过滤", () => {
    store.setItem("nova-chat-attachments:s1", '["/a.png",1,null,"/b.png"]');
    expect(chatAttachments.get("s1")).toEqual(["/a.png", "/b.png"]);
  });

  it("localStorage 抛错时降级为空数组而非崩溃", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    });
    expect(chatAttachments.get("s1")).toEqual([]);
    expect(() => chatAttachments.set("s1", ["/a.png"])).not.toThrow();
    expect(() => chatAttachments.clear("s1")).not.toThrow();
    vi.stubGlobal("localStorage", store);
  });
});
