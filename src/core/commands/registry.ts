// ===== Slash 命令分发器 =====
//
// 极简命令系统：ChatInput 发送前拦截 "/" 开头输入。
// 命中命令则执行命令逻辑、阻止普通对话；未命中则正常发送。
//
// 后续可复用于 /compact、/summary 等。

/** 命令执行上下文 */
export interface CommandContext {
  /** 当前活跃会话 ID */
  sessionId: string | null;
  /** 弹 toast 提示 */
  notify: (msg: string, type?: "info" | "success" | "error") => void;
}

/** 一个 slash 命令 */
export interface SlashCommand {
  /** 命令名（不含斜杠），如 "distill" */
  name: string;
  /** 别名 */
  aliases?: string[];
  /** 说明 */
  description: string;
  /** 执行：argsRaw 是命令名之后的原始字符串 */
  run: (ctx: CommandContext, argsRaw: string) => Promise<void>;
}

const registry = new Map<string, SlashCommand>();

/** 注册命令（含别名） */
export function registerCommand(cmd: SlashCommand): void {
  registry.set(cmd.name, cmd);
  for (const a of cmd.aliases || []) registry.set(a, cmd);
}

/** 获取所有命令（去重） */
export function listCommands(): SlashCommand[] {
  return Array.from(new Set(registry.values()));
}

/** 是否是命令输入（"/" 开头） */
export function isCommandInput(input: string): boolean {
  return /^\s*\/\S/.test(input);
}

/**
 * 分发命令。
 *
 * @returns 命中并已处理返回 true（调用方应阻止普通发送）；未命中返回 false。
 */
export async function dispatchCommand(input: string, ctx: CommandContext): Promise<boolean> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return false;

  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const name = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase();
  const argsRaw = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1).trim();

  const cmd = registry.get(name);
  if (!cmd) {
    ctx.notify(`未知命令：/${name}`, "error");
    // 已识别为命令语法但无匹配 → 仍拦截，避免把 /xxx 当普通消息发出
    return true;
  }

  try {
    await cmd.run(ctx, argsRaw);
  } catch (e: any) {
    console.warn(`[Commands] /${name} 执行失败:`, e?.message || e);
    ctx.notify(`/${name} 执行失败：${e?.message || e}`, "error");
  }
  return true;
}
