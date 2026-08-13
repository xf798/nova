import { describe, expect, it, vi } from "vitest";

const appStorage = vi.hoisted(() => ({ data: "{}" }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: { data?: string }) => {
    if (command === "get_app_storage") return appStorage.data;
    if (command === "save_app_storage") {
      appStorage.data = args?.data || "{}";
      return null;
    }
    throw new Error(`unexpected command: ${command}`);
  }),
}));

import { loadCliConnectorConfigs, normalizeCliConnectorConfigs, persistCliConnectorConfigs } from "./cli-storage";
import { StorageService } from "../core/storage";

describe("normalizeCliConnectorConfigs", () => {
  it("保留命令、参数和工作目录并清理首尾空白", () => {
    expect(normalizeCliConnectorConfigs([{
      id: " kiro-cli ",
      name: " Kiro CLI ",
      command: " /custom/kiro-cli ",
      defaultArgs: ["acp", "--trust-all-tools"],
      cwd: " /workspace/project ",
      enabled: true,
    }])).toEqual([{
      id: "kiro-cli",
      name: "Kiro CLI",
      command: "/custom/kiro-cli",
      defaultArgs: ["acp", "--trust-all-tools"],
      cwd: "/workspace/project",
      description: undefined,
      icon: undefined,
      enabled: true,
    }]);
  });

  it("过滤非法记录并兼容空 command/cwd 的自动模式", () => {
    expect(normalizeCliConnectorConfigs([
      null,
      { id: "", name: "bad" },
      { id: "kiro-cli", name: "Kiro", command: "", cwd: "", enabled: false },
    ])).toEqual([{
      id: "kiro-cli",
      name: "Kiro",
      command: "",
      defaultArgs: undefined,
      cwd: undefined,
      description: undefined,
      icon: undefined,
      enabled: false,
    }]);
  });
});


describe("CLI 配置持久化", () => {
  it("保存后重新加载仍保留显式 command、args 和 cwd", async () => {
    appStorage.data = "{}";
    StorageService.getInstance().invalidate();
    await persistCliConnectorConfigs([{
      id: "kiro-cli",
      name: "Kiro CLI",
      type: "cli",
      enabled: true,
      command: "/custom/bin/kiro-cli",
      defaultArgs: ["acp", "--trust-all-tools"],
      cwd: "/workspace/project",
    }]);

    StorageService.getInstance().invalidate();
    const loaded = await loadCliConnectorConfigs();

    expect(loaded[0]).toMatchObject({
      id: "kiro-cli",
      command: "/custom/bin/kiro-cli",
      defaultArgs: ["acp", "--trust-all-tools"],
      cwd: "/workspace/project",
    });
  });
});
