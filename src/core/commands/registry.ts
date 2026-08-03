// ===== Slash 命令分发器 =====
//
// 极简命令系统：ChatInput 发送前用 resolveCommand 判断是否命中已注册命令。
// 命中则执行命令逻辑、阻止普通对话；未命中则原样当普通消息发送。
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

/** 解析结果：命令名 + 命令名之后的原始参数串 */
function parseCommandInput(input: string): { name: string; argsRaw: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const withoutSlash = trimmed.slice(1);
  if (!withoutSlash) return null;

  const spaceIdx = withoutSlash.search(/\s/);
  const name = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase();
  const argsRaw = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1).trim();
  return { name, argsRaw };
}

/**
 * 查找输入对应的命令，未命中返回 null。
 *
 * 判定依据是「确实命中已注册命令」，而非「以 / 开头」。
 * 后者会把绝对路径（/Users/…、/tmp/…、/etc/hosts）误判成命令，
 * 之前的实现对这类输入弹「未知命令」并吞掉消息，导致路径发不出去。
 *
 * 调用方据此决定是走命令分支还是当普通消息发送。同步返回，
 * 便于在清空输入框之前完成判定。
 */
export function resolveCommand(input: string): SlashCommand | null {
  const parsed = parseCommandInput(input);
  if (!parsed) return null;
  return registry.get(parsed.name) || null;
}

/**
 * 分发命令。
 *
 * @returns 命中并已处理返回 true（调用方应阻止普通发送）；未命中返回 false
 *          （调用方应按普通消息发送，不要吞掉输入）。
 */
export async function dispatchCommand(input: string, ctx: CommandContext): Promise<boolean> {
  const parsed = parseCommandInput(input);
  if (!parsed) return false;

  const cmd = registry.get(parsed.name);
  // 未命中不报错也不拦截：/ 开头的普通文本（路径等）应原样发出
  if (!cmd) return false;

  try {
    await cmd.run(ctx, parsed.argsRaw);
  } catch (e: any) {
    console.warn(`[Commands] /${parsed.name} 执行失败:`, e?.message || e);
    ctx.notify(`/${parsed.name} 执行失败：${e?.message || e}`, "error");
  }
  return true;
}
