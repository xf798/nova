// ===== 企微访问策略 =====
//
// 这是权限判定代码，两侧都必须固定住：
// 放开过头会让外人驱动本机 AI，收得过紧会让机器人整体不可用。
// 尤其是「策略数据损坏时的行为」——必须回落到安全默认，而不是放行。

import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_WECOM_POLICY, GUARD_CATEGORIES,
  checkWecomAccess, isGuardEnabled, parseWecomPolicy,
  getRecentSenders, rememberSender,
  type WecomPolicy,
} from "./wecomPolicy";
import { checkWecomGuard } from "./wecomGuard";

const sender = { senderId: "u-001", senderName: "王小明", chatId: "chat-a" };

function policy(patch: Partial<WecomPolicy> = {}): WecomPolicy {
  return { ...DEFAULT_WECOM_POLICY, ...patch };
}

describe("默认策略", () => {
  it("默认放行所有人，不改变已在运行的机器人可用性", () => {
    expect(checkWecomAccess(sender, DEFAULT_WECOM_POLICY).allowed).toBe(true);
  });

  it("默认四类高危全部拦截", () => {
    for (const c of GUARD_CATEGORIES) {
      expect(isGuardEnabled(DEFAULT_WECOM_POLICY, c.key), c.key).toBe(true);
    }
  });
});

describe("访问范围", () => {
  it("名单制下命中姓名放行", () => {
    const p = policy({ accessMode: "allowlist", allowedUsers: ["王小明"] });
    expect(checkWecomAccess(sender, p).allowed).toBe(true);
  });

  it("名单制下命中成员 ID 放行", () => {
    const p = policy({ accessMode: "allowlist", allowedUsers: ["u-001"] });
    expect(checkWecomAccess(sender, p).allowed).toBe(true);
  });

  it("名单制下未命中拒绝，并给出可读提示", () => {
    const p = policy({ accessMode: "allowlist", allowedUsers: ["李雷"] });
    const r = checkWecomAccess(sender, p);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("not-in-allowlist");
    expect(r.rejectMessage).toBeTruthy();
  });

  it("名单为空的名单制拒绝所有人（不静默退化成放行）", () => {
    const p = policy({ accessMode: "allowlist", allowedUsers: [] });
    expect(checkWecomAccess(sender, p).allowed).toBe(false);
  });

  it("比较忽略大小写与首尾空白", () => {
    const p = policy({ accessMode: "allowlist", allowedUsers: ["  U-001 "] });
    expect(checkWecomAccess(sender, p).allowed).toBe(true);
  });

  it("会话白名单独立生效：放开所有人也能只允许特定群", () => {
    const p = policy({ accessMode: "everyone", allowedChats: ["chat-b"] });
    const r = checkWecomAccess(sender, p);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("chat-not-allowed");
    expect(checkWecomAccess({ ...sender, chatId: "chat-b" }, p).allowed).toBe(true);
  });

  it("会话白名单为空表示不限制会话", () => {
    expect(checkWecomAccess(sender, policy({ allowedChats: [] })).allowed).toBe(true);
  });
});

describe("解析持久化数据", () => {
  it("空值回落到默认（安全侧）", () => {
    for (const raw of [undefined, null, "", 0, [], "garbage"]) {
      expect(parseWecomPolicy(raw)).toEqual(DEFAULT_WECOM_POLICY);
    }
  });

  it("未知 accessMode 回落到 everyone", () => {
    expect(parseWecomPolicy({ accessMode: "whatever" }).accessMode).toBe("everyone");
  });

  it("兼容逗号分隔的字符串名单（手工编辑存储的常见写法）", () => {
    const p = parseWecomPolicy({ accessMode: "allowlist", allowedUsers: "王小明, 李雷\n韩梅梅" });
    expect(p.allowedUsers).toEqual(["王小明", "李雷", "韩梅梅"]);
  });

  it("丢弃未知的类别名，不因脏数据放开拦截", () => {
    const p = parseWecomPolicy({ disabledGuards: ["local-files", "not-a-category"] });
    expect(p.disabledGuards).toEqual(["local-files"]);
  });

  it("类别去重", () => {
    const p = parseWecomPolicy({ disabledGuards: ["privacy", "privacy"] });
    expect(p.disabledGuards).toEqual(["privacy"]);
  });
});

describe("守卫按类别开关", () => {
  it("关闭本地文件类后，文件指令放行，其他类别仍拦", () => {
    const p = policy({ disabledGuards: ["local-files"] });
    expect(checkWecomGuard("查看本地工程文件", p).blocked).toBe(false);
    expect(checkWecomGuard("删除本地文件", p).blocked).toBe(false);
    expect(checkWecomGuard("执行命令 ls", p).blocked).toBe(true);
    expect(checkWecomGuard("看看我的浏览器历史", p).blocked).toBe(true);
    expect(checkWecomGuard("查看聊天记录", p).blocked).toBe(true);
  });

  it("关闭个人信息类只影响隐私规则", () => {
    const p = policy({ disabledGuards: ["privacy"] });
    expect(checkWecomGuard("查看聊天记录", p).blocked).toBe(false);
    expect(checkWecomGuard("看下通讯录", p).blocked).toBe(false);
    expect(checkWecomGuard("查看本地工程文件", p).blocked).toBe(true);
  });

  it("全部关闭后不再拦截任何指令", () => {
    const p = policy({ disabledGuards: GUARD_CATEGORIES.map(c => c.key) });
    for (const t of ["rm -rf /", "查看本地工程文件", "浏览器历史", "查看聊天记录", "brew install wget"]) {
      expect(checkWecomGuard(t, p).blocked, t).toBe(false);
    }
  });

  it("命中时返回所属类别，便于日志和 UI 定位", () => {
    const r = checkWecomGuard("看看我的浏览器历史");
    expect(r.category).toBe("browser");
  });

  it("不传 policy 时全部拦截（旧调用方不受影响）", () => {
    expect(checkWecomGuard("查看本地工程文件").blocked).toBe(true);
  });
});

describe("最近发言人", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
  });

  it("记录后可读出，按时间倒序", () => {
    rememberSender({ senderId: "a", senderName: "A", chatId: "c1" });
    rememberSender({ senderId: "b", senderName: "B", chatId: "c1" });
    const list = getRecentSenders();
    expect(list.map(s => s.senderId)).toEqual(["b", "a"]);
  });

  it("同一人只保留最新一条", () => {
    rememberSender({ senderId: "a", senderName: "旧名", chatId: "c1" });
    rememberSender({ senderId: "a", senderName: "新名", chatId: "c1" });
    const list = getRecentSenders();
    expect(list).toHaveLength(1);
    expect(list[0].senderName).toBe("新名");
  });

  it("保留被拦截标记，让所有者知道谁在敲门", () => {
    rememberSender({ senderId: "x", senderName: "陌生人", chatId: "c9", blocked: true });
    expect(getRecentSenders()[0].blocked).toBe(true);
  });

  it("最多保留 12 条", () => {
    for (let i = 0; i < 20; i++) {
      rememberSender({ senderId: `u${i}`, senderName: `U${i}`, chatId: "c1" });
    }
    expect(getRecentSenders()).toHaveLength(12);
  });

  it("存储损坏时返回空数组而不抛错", () => {
    localStorage.setItem("nova.wecom.recentSenders", "{not json");
    expect(getRecentSenders()).toEqual([]);
  });

  it("localStorage 不可用时静默跳过", () => {
    delete (globalThis as any).localStorage;
    expect(() => rememberSender({ senderId: "a", senderName: "A", chatId: "c" })).not.toThrow();
    expect(getRecentSenders()).toEqual([]);
  });
});
