import { describe, expect, it, vi } from "vitest";
import { buildKiroCliExecArgs, commonKiroCliPaths, resolveKiroCliCommand, type KiroCliCommandProbe } from "./kiro-cli-command";

function probe(overrides: Partial<KiroCliCommandProbe> = {}): KiroCliCommandProbe {
  return {
    homeDir: vi.fn().mockResolvedValue("/Users/test"),
    findOnPath: vi.fn().mockResolvedValue(null),
    isExecutable: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe("resolveKiroCliCommand", () => {
  it("显式绝对路径优先，不再执行自动探测", async () => {
    const p = probe({ isExecutable: vi.fn().mockResolvedValue(true) });
    await expect(resolveKiroCliCommand(" /custom/bin/kiro-cli ", p)).resolves.toEqual({
      command: "/custom/bin/kiro-cli",
      source: "configured",
    });
    expect(p.findOnPath).not.toHaveBeenCalled();
  });

  it("显式命令名从 PATH 解析为真实路径", async () => {
    const p = probe({ findOnPath: vi.fn().mockResolvedValue("/toolchain/bin/kiro-cli") });
    await expect(resolveKiroCliCommand("kiro-cli", p)).resolves.toEqual({
      command: "/toolchain/bin/kiro-cli",
      source: "configured",
    });
  });

  it("留空时先检查 PATH，再回落常见安装目录", async () => {
    const fromPath = probe({ findOnPath: vi.fn().mockResolvedValue("/opt/bin/kiro-cli") });
    await expect(resolveKiroCliCommand("", fromPath)).resolves.toEqual({
      command: "/opt/bin/kiro-cli",
      source: "path",
    });

    const target = "/Users/test/.kiro/bin/kiro-cli";
    const fromCommon = probe({
      isExecutable: vi.fn(async path => path === target),
    });
    await expect(resolveKiroCliCommand(undefined, fromCommon)).resolves.toEqual({
      command: target,
      source: "common",
    });
  });

  it("探测失败时提示用户显式填写路径", async () => {
    await expect(resolveKiroCliCommand(undefined, probe())).rejects.toThrow("请在连接器设置中填写可执行文件路径");
  });

  it("常见目录不含开发者固定用户名", () => {
    expect(commonKiroCliPaths("/Users/alice")).toContain("/Users/alice/.local/bin/kiro-cli");
    expect(commonKiroCliPaths("/Users/alice").join(" ")).not.toContain("wangxf");
  });

  it("启动参数不拼接命令路径，避免空格或 shell 元字符被解释", () => {
    expect(buildKiroCliExecArgs("/Applications/Kiro CLI/bin/kiro-cli;echo bad", ["acp", "--trust-all-tools"]))
      .toEqual([
        "-c",
        'exec "$@"',
        "--",
        "/Applications/Kiro CLI/bin/kiro-cli;echo bad",
        "acp",
        "--trust-all-tools",
      ]);
  });
});
