// ===== 召回闸门 =====
//
// 由来：「可以，按完整方案实现」命中了「客户画像UI还原」那条记忆（0.168），
// 只因共享「实现」这个泛用动词。换过三种词面算法都没解决（IDF、会话当查询、
// 反向覆盖度），用 API 嵌入实测也一样 —— 向量空间里这类查询的相似度全挤在
// 0.44-0.66，没有区分度。
//
// 结论是问题不在算法，而在「这句话本身没有主题，压根不该召回」。
//
// 判据不能是长度：「打包」「截图」「关机」同样短，却是有主题的。
// 因此按「去掉程序性词汇后还剩不剩实义内容」判断。

import { describe, it, expect } from "vitest";
import { shouldRecall, extractMeaningful } from "./recallGate";

describe("拦截：无主题的指令与确认", () => {
  // 全部来自真实消息（1208 条里这类占 6.3%）
  const blocked = [
    "做吧", "继续", "开始", "执行", "推", "推送", "提交", "确认",
    "改吧", "修复", "调吧", "删掉", "加上", "重试", "1", "？",
    "可以了", "有了", "没生效", "统一吧", "继续修复", "方案 1", "做 b 吧",
    "可以，提交吧", "可以，按完整方案实现",
  ];

  for (const q of blocked) {
    it(`拦截 ${JSON.stringify(q)}`, () => {
      expect(shouldRecall(q)).toBe(false);
    });
  }
});

describe("放行：短但有主题", () => {
  // 这些一样短，但承载话题，不能一刀切按长度拦
  const passed = ["打包", "截图", "关机", "打包部署", "查看待办", "第一档"];

  for (const q of passed) {
    it(`放行 ${JSON.stringify(q)}`, () => {
      expect(shouldRecall(q)).toBe(true);
    });
  }
});

describe("放行：正常提问", () => {
  const passed = [
    "会话存储为什么要改成 JSONL",
    "现在消息顶部的召回展示功能是干啥的",
    "帮我看看 updater 的签名流程",
    "客户画像的字段推断在哪一步",
  ];

  for (const q of passed) {
    it(`放行 ${JSON.stringify(q.slice(0, 16))}…`, () => {
      expect(shouldRecall(q)).toBe(true);
    });
  }
});

describe("实义提取", () => {
  it("剥离程序性前缀，留下主题词", () => {
    expect(extractMeaningful("可以，按完整方案实现")).toEqual([]);
  });

  it("混合输入只留实义部分", () => {
    const r = extractMeaningful("好的，帮我看看 JSONL 迁移");
    expect(r.join("")).toContain("JSONL");
  });

  it("英文技术名词保留", () => {
    expect(extractMeaningful("rehypeHighlight 为什么慢").join("")).toContain("rehypeHighlight");
  });

  it("纯标点返回空", () => {
    expect(extractMeaningful("？？！")).toEqual([]);
    expect(extractMeaningful("。。。")).toEqual([]);
  });

  it("空输入返回空", () => {
    expect(extractMeaningful("")).toEqual([]);
    expect(extractMeaningful("   ")).toEqual([]);
  });

  it("单字不算实义（技术名词几乎都是两字以上）", () => {
    expect(extractMeaningful("推")).toEqual([]);
    expect(extractMeaningful("改")).toEqual([]);
  });
});

describe("边界", () => {
  it("超长输入不出错", () => {
    expect(() => shouldRecall("测试".repeat(5000))).not.toThrow();
  });

  it("大小写不敏感（ok / OK / Ok 都算程序性词）", () => {
    expect(shouldRecall("ok")).toBe(false);
    expect(shouldRecall("OK")).toBe(false);
    expect(shouldRecall("Ok")).toBe(false);
  });

  it("程序性词与实义词混排时放行", () => {
    // 「继续」是程序性的，但「压测」是主题
    expect(shouldRecall("继续做压测")).toBe(true);
  });
});
