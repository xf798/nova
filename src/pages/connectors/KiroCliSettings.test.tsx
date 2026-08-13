import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { CliForm } from "./ConnectorForm";
import ConnectorCard from "./ConnectorCard";

describe("Kiro CLI 连接器设置", () => {
  it("command 留空时仍允许保存并提示自动检测", () => {
    const html = renderToString(React.createElement(CliForm, {
      data: {
        id: "kiro-cli",
        name: "Kiro CLI",
        command: "",
        args: "acp --trust-all-tools",
        cwd: "",
        description: "",
      },
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      isEdit: true,
    }));

    expect(html).toContain("命令（留空自动检测）");
    expect(html).toContain("留空使用会话目录或用户主目录");
    expect(html).not.toContain("disabled=\"\"");
  });

  it("卡片展示自动探测到的真实路径", () => {
    const html = renderToString(React.createElement(ConnectorCard, {
      config: {
        id: "kiro-cli",
        name: "Kiro CLI",
        type: "cli",
        enabled: true,
        command: "",
        defaultArgs: ["acp"],
      },
      status: true,
      cliCommandStatus: {
        resolution: { command: "/Users/alice/.local/bin/kiro-cli", source: "common" },
      },
      onCheck: vi.fn(),
      onEdit: vi.fn(),
    }));

    expect(html).toContain("自动探测 kiro-cli");
    expect(html).toContain("已自动检测");
    expect(html).toContain("/Users/alice/.local/bin/kiro-cli");
  });
});
