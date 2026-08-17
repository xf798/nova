import { describe, expect, it } from "vitest";
import { assessSkillQuality } from "./quality";
import type { SkillCandidate } from "./types";

function skill(over: Partial<SkillCandidate> = {}): SkillCandidate {
  return {
    name: "cross-branch-feature-gap-diagnosis",
    displayName: "跨分支功能缺失诊断",
    description: "功能在某分支不生效时定位缺失提交",
    trigger: "auto",
    keywords: ["分支", "cherry-pick"],
    tags: [],
    body: [
      "## 适用场景",
      "同一功能在 A 分支正常、B 分支失效，且无报错。",
      "",
      "## 根因与机制",
      "特性分支从主干拉出后未同步后续修复提交，导致依赖的前置改动缺失。",
      "",
      "## 处置",
      "对比两分支提交差异，定位缺失提交后 cherry-pick。",
      "",
      "## 边界与陷阱",
      "若差异过多说明分支已严重落后，应整体 rebase 而非逐个挑。",
    ].join("\n"),
    confidence: "high",
    ...over,
  };
}

describe("assessSkillQuality", () => {
  it("四节齐全且写清机制的判为可复用", () => {
    const v = assessSkillQuality(skill());
    expect(v.reusable).toBe(true);
    expect(v.issues).toEqual([]);
  });

  it("只有操作步骤、没有机制解释的判为不可复用", () => {
    const v = assessSkillQuality(skill({
      body: [
        "## 适用场景",
        "推送被拒时。",
        "## 步骤",
        "1. git fetch origin master",
        "2. git rebase origin/master",
        "3. git push origin HEAD:refs/for/master",
        "4. 打开 Gerrit 确认新的 patchset 已生成并通知评审",
      ].join("\n"),
    }));
    expect(v.reusable).toBe(false);
    expect(v.issues.map(i => i.code)).toEqual(
      expect.arrayContaining(["no-mechanism", "bare-command-list"]),
    );
  });

  // 回归：曾因只认「根因/因为」等因果连接词，把这类清晰的机制陈述误判为无机制
  it("不用因果连接词但陈述了机制的不应被拦截", () => {
    const v = assessSkillQuality(skill({
      body: [
        "## 适用场景",
        "模型输出的 JSON 结构错位时。",
        "",
        "## 技术事实",
        "DSML 格式每个 parameter 只有开始标记、没有闭合标记，",
        "参数值边界靠下一个标记出现来切断，因此少写括号解析器不会报错，只会静默串入。",
        "",
        "## 处置",
        "每个参数单独用代码块展示，明确标注边界。",
      ].join("\n"),
    }));
    expect(v.reusable).toBe(true);
    expect(v.issues.map(i => i.code)).not.toContain("no-mechanism");
  });

  it("有解释性小节即认为写了为什么", () => {
    const v = assessSkillQuality(skill({
      body: [
        "## 适用场景",
        "分发未公证应用时。",
        "",
        "## 边界与陷阱",
        "即使无 quarantine 标记，ad-hoc 签名应用双击仍被 ASP 拦截；",
        "U 盘传输不带 quarantine 但仍需放行一次。",
      ].join("\n"),
    }));
    expect(v.issues.map(i => i.code)).not.toContain("no-mechanism");
  });

  it("用项目名命名会被标记，但不阻断落盘", () => {
    const v = assessSkillQuality(skill({ name: "meinian-branch-feature-sync" }));
    expect(v.issues.map(i => i.code)).toContain("project-scoped-name");
    expect(v.reusable).toBe(true);
  });

  it("description 与适用场景首句重复会被标记", () => {
    const v = assessSkillQuality(skill({
      description: "同一功能在 A 分支正常、B 分支失效，且无报错",
    }));
    expect(v.issues.map(i => i.code)).toContain("desc-duplicates-body");
  });

  it("正文过短判为不可复用", () => {
    const v = assessSkillQuality(skill({ body: "## 适用场景\n改完没生效就重启。" }));
    expect(v.reusable).toBe(false);
    expect(v.issues.map(i => i.code)).toContain("too-thin");
  });
});
