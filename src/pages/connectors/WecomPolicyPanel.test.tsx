// ===== 企微权限面板渲染 =====
//
// 面板是这套权限的唯一入口，渲染不出来等于功能不存在。
// 这里固定三件事：范围切换可见、名单为空时有明确警示、四类开关都渲染。

import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));

import { WecomPolicyPanel } from "./ConnectorForm";
import { DEFAULT_WECOM_POLICY, GUARD_CATEGORIES } from "../../core/wecomPolicy";

function render(policy = DEFAULT_WECOM_POLICY) {
  return renderToString(<WecomPolicyPanel policy={policy} onChange={() => {}} />);
}

describe("WecomPolicyPanel", () => {
  it("渲染使用范围与四类敏感操作开关", () => {
    const html = render();
    expect(html).toContain("使用范围");
    expect(html).toContain("所有人");
    expect(html).toContain("仅指定成员");
    for (const c of GUARD_CATEGORIES) {
      expect(html, c.label).toContain(c.label);
    }
  });

  it("默认（所有人）不显示名单编辑区", () => {
    const html = render();
    expect(html).not.toContain("授权成员");
    expect(html).toContain("任何能 @ 到机器人的人");
  });

  it("名单制且名单为空时给出明确警示", () => {
    const html = render({ ...DEFAULT_WECOM_POLICY, accessMode: "allowlist" });
    expect(html).toContain("授权成员");
    expect(html).toContain("名单为空");
  });

  it("名单成员逐项渲染，且不再显示空名单警示", () => {
    const html = render({ ...DEFAULT_WECOM_POLICY, accessMode: "allowlist", allowedUsers: ["王小明", "李雷"] });
    expect(html).toContain("王小明");
    expect(html).toContain("李雷");
    expect(html).not.toContain("名单为空");
  });

  it("开关状态反映 disabledGuards：关闭的类别 aria-checked=false", () => {
    const html = renderToString(
      <WecomPolicyPanel
        policy={{ ...DEFAULT_WECOM_POLICY, disabledGuards: ["local-files"] }}
        onChange={() => {}}
      />
    );
    const checked = (html.match(/aria-checked="true"/g) || []).length;
    const unchecked = (html.match(/aria-checked="false"/g) || []).length;
    expect(unchecked).toBe(1);
    expect(checked).toBe(GUARD_CATEGORIES.length - 1);
  });
});
