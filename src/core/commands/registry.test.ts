import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerCommand, resolveCommand, dispatchCommand, listCommands } from "./registry";
import type { SlashCommand } from "./registry";

const run = vi.fn();

const testCmd: SlashCommand = {
  name: "distill",
  aliases: ["skillify"],
  description: "测试命令",
  run,
};

beforeEach(() => {
  vi.clearAllMocks();
  registerCommand(testCmd);
});

const ctx = () => ({ sessionId: "s1", notify: vi.fn() });

describe("resolveCommand — 只认已注册命令", () => {
  it("命中命令名", () => {
    expect(resolveCommand("/distill")?.name).toBe("distill");
  });

  it("命中别名", () => {
    expect(resolveCommand("/skillify")?.name).toBe("distill");
  });

  it("大小写不敏感", () => {
    expect(resolveCommand("/DISTILL")?.name).toBe("distill");
  });

  it("带参数仍命中", () => {
    expect(resolveCommand("/distill --all")?.name).toBe("distill");
  });

  it("前导空白不影响", () => {
    expect(resolveCommand("   /distill")?.name).toBe("distill");
  });

  it("非 / 开头返回 null", () => {
    expect(resolveCommand("distill")).toBeNull();
  });

  it("只有斜杠返回 null", () => {
    expect(resolveCommand("/")).toBeNull();
  });
});

describe("resolveCommand — 绝对路径不能被当成命令", () => {
  // 这是本次修复的核心：先前按「以 / 开头」判定，
  // 下列输入都会被吞掉并弹「未知命令」
  const paths = [
    "/Users/wangxf/workspace/nova",
    "/tmp/nova-dev.sh",
    "/etc/hosts",
    "/opt/homebrew/bin",
    "/usr/local/lib",
    "/Applications/Nova.app",
  ];

  for (const p of paths) {
    it(`${p} 不被识别为命令`, () => {
      expect(resolveCommand(p)).toBeNull();
    });
  }

  it("路径后跟说明文字也不被识别", () => {
    expect(resolveCommand("/Users/wangxf/a.ts 这个文件有问题")).toBeNull();
  });
});

describe("resolveCommand — 未注册的类命令输入", () => {
  it("拼错的命令名返回 null（按普通消息发送，不吞输入）", () => {
    expect(resolveCommand("/distll")).toBeNull();
  });

  it("完全不存在的命令返回 null", () => {
    expect(resolveCommand("/nonexistent")).toBeNull();
  });
});

describe("dispatchCommand", () => {
  it("命中则执行并返回 true", async () => {
    const c = ctx();
    await expect(dispatchCommand("/distill", c)).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("参数原样透传（去掉命令名与首尾空白）", async () => {
    await dispatchCommand("/distill  --recent 3d  ", ctx());
    expect(run).toHaveBeenCalledWith(expect.anything(), "--recent 3d");
  });

  it("无参数时 argsRaw 为空串", async () => {
    await dispatchCommand("/distill", ctx());
    expect(run).toHaveBeenCalledWith(expect.anything(), "");
  });

  it("未命中返回 false 且不报错", async () => {
    const c = ctx();
    await expect(dispatchCommand("/Users/wangxf/nova", c)).resolves.toBe(false);
    expect(c.notify).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("命令抛错时仍返回 true 并提示，不冒泡", async () => {
    run.mockRejectedValueOnce(new Error("boom"));
    const c = ctx();
    await expect(dispatchCommand("/distill", c)).resolves.toBe(true);
    expect(c.notify).toHaveBeenCalledWith(expect.stringContaining("boom"), "error");
  });
});

describe("listCommands", () => {
  it("别名不产生重复条目", () => {
    expect(listCommands().filter(c => c.name === "distill")).toHaveLength(1);
  });
});
