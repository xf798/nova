// ===== 回复语言约束 =====
//
// 这段的价值在于「约束必须点名过程叙述和思考」：
// 实测模型把正式回答和过程叙述当成两档，只对前者切语言——
// 「录音新版」会话最终答复 85:1 是中文，而工具之间的过程叙述 15 段英文、
// 思考段 14 段全英文。约束漏掉这两处就等于没写。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildLanguageDirective,
  detectPreferredLanguage,
  normalizeLanguage,
} from "./responseLanguage";

describe("normalizeLanguage", () => {
  it("识别各种中文标签", () => {
    for (const t of ["zh", "zh-CN", "zh-Hans", "zh-TW", "zh_CN", "ZH-cn"]) {
      expect(normalizeLanguage(t), t).toBe("zh");
    }
  });

  it("识别英文标签", () => {
    for (const t of ["en", "en-US", "EN-gb"]) {
      expect(normalizeLanguage(t), t).toBe("en");
    }
  });

  it("其他语言归到 other", () => {
    expect(normalizeLanguage("ja-JP")).toBe("other");
    expect(normalizeLanguage("de")).toBe("other");
  });

  it("空值不抛错", () => {
    expect(normalizeLanguage(undefined)).toBe("other");
    expect(normalizeLanguage("")).toBe("other");
    expect(normalizeLanguage(null)).toBe("other");
  });
});

// navigator 在 Node 下是只读 getter，只能用 defineProperty 替换
function setNavigatorLanguage(language: string) {
  Object.defineProperty(globalThis, "navigator", {
    value: { language },
    configurable: true,
    writable: true,
  });
}
function removeNavigator() {
  Object.defineProperty(globalThis, "navigator", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

describe("detectPreferredLanguage", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    };
    setNavigatorLanguage("en-US");
  });
  afterEach(() => {
    delete (globalThis as any).localStorage;
    removeNavigator();
  });

  it("localStorage 覆盖优先于系统语言", () => {
    store.set("nova.responseLanguage", "zh-CN");
    expect(detectPreferredLanguage()).toBe("zh");
  });

  it("没有覆盖时跟随系统语言", () => {
    expect(detectPreferredLanguage()).toBe("en");
  });

  it("系统语言为中文时判为中文", () => {
    setNavigatorLanguage("zh-CN");
    expect(detectPreferredLanguage()).toBe("zh");
  });

  it("取不到语言时兜底中文（当前使用者是中文用户）", () => {
    delete (globalThis as any).localStorage;
    removeNavigator();
    expect(detectPreferredLanguage()).toBe("zh");
  });
});

describe("buildLanguageDirective", () => {
  it("中文时点名过程叙述与思考——漏掉这两处等于没约束", () => {
    const d = buildLanguageDirective("zh")!;
    expect(d).toContain("简体中文");
    expect(d).toContain("过程叙述");
    expect(d).toContain("思考");
  });

  it("说明思考也是用户可见输出，避免模型认为它不算", () => {
    expect(buildLanguageDirective("zh")).toContain("用户可见");
  });

  it("豁免代码与报错原文，不让它去翻译标识符", () => {
    const d = buildLanguageDirective("zh")!;
    expect(d).toContain("代码");
    expect(d).toContain("不要翻译");
  });

  it("非中文不注入，避免给英文用户加噪音", () => {
    expect(buildLanguageDirective("en")).toBeNull();
    expect(buildLanguageDirective("other")).toBeNull();
  });

  it("用可解析的标签包裹，便于连接器与日志识别", () => {
    const d = buildLanguageDirective("zh")!;
    expect(d.startsWith("<response_language>")).toBe(true);
    expect(d.trimEnd().endsWith("</response_language>")).toBe(true);
  });
});
