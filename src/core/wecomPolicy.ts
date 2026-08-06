/**
 * 企微机器人访问策略
 *
 * 机器人一旦分享给他人，任何能 @ 到它的人都能驱动本机的 AI 去读文件、
 * 执行命令、翻个人信息。这里把权限拆成两层，都可在连接器里配置：
 *
 *   1. 访问范围 —— 谁能用这个机器人（所有人 / 仅名单内成员）
 *   2. 敏感操作 —— 名单内的人能做什么（四类高危能力分别开关）
 *
 * 默认值刻意保持「所有人 + 四类全拦」：既不改变已在运行的机器人的可用性，
 * 又保证高危操作从一开始就是关着的。收紧到名单制需要主动配置，
 * 因此 UI 里提供「最近发言人」一键加白，避免要手抄 sender_id。
 */

/** 高危能力分类（守卫规则按此归类，可分别开关） */
export type GuardCategory = "local-files" | "system-ops" | "browser" | "privacy";

export const GUARD_CATEGORIES: { key: GuardCategory; label: string; desc: string }[] = [
  { key: "local-files", label: "本地文件", desc: "查看、读取、删除本机文件与目录" },
  { key: "system-ops", label: "命令与系统", desc: "执行 shell、装卸软件、改系统配置、读凭证、扫网络" },
  { key: "browser", label: "浏览器记录", desc: "浏览历史与访问记录" },
  { key: "privacy", label: "个人信息", desc: "聊天记录、通讯录、日程、照片、邮件、财务、证件、位置等" },
];

/** 访问范围 */
export type WecomAccessMode = "everyone" | "allowlist";

export interface WecomPolicy {
  /** 访问范围：everyone = 任何能 @ 到机器人的人；allowlist = 仅名单内成员 */
  accessMode: WecomAccessMode;
  /** 允许的成员，逐项匹配 sender_name 或 sender_id */
  allowedUsers: string[];
  /** 允许的会话/群 chat_id，空表示不限制会话 */
  allowedChats: string[];
  /** 已关闭的高危能力拦截（不在列表里的类别 = 仍然拦截） */
  disabledGuards: GuardCategory[];
}

export const DEFAULT_WECOM_POLICY: WecomPolicy = {
  accessMode: "everyone",
  allowedUsers: [],
  allowedChats: [],
  disabledGuards: [],
};

// ── 解析 ──

const VALID_CATEGORIES = new Set<string>(GUARD_CATEGORIES.map(c => c.key));

/** 归一化用于比较：去空白、转小写 */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

function parseStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(v => String(v).trim()).filter(Boolean);
  }
  // 兼容以逗号/换行分隔的字符串（手工编辑 app-storage 时容易写成这种）
  if (typeof raw === "string") {
    return raw.split(/[,\n;、]/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 宽松解析持久化的策略。
 *
 * 存储可能来自旧版本、手工编辑或另一端写入，任何字段缺失或类型不对
 * 都回落到默认值，而不是抛错让机器人整个不可用。
 */
export function parseWecomPolicy(raw: unknown): WecomPolicy {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_WECOM_POLICY };
  const o = raw as Record<string, unknown>;

  const mode = norm(String(o.accessMode ?? ""));
  const accessMode: WecomAccessMode = mode === "allowlist" ? "allowlist" : "everyone";

  const disabledGuards = parseStringList(o.disabledGuards)
    .map(norm)
    .filter(k => VALID_CATEGORIES.has(k)) as GuardCategory[];

  return {
    accessMode,
    allowedUsers: parseStringList(o.allowedUsers),
    allowedChats: parseStringList(o.allowedChats),
    disabledGuards: [...new Set(disabledGuards)],
  };
}

/** 该类别的拦截是否生效 */
export function isGuardEnabled(policy: WecomPolicy, category: GuardCategory): boolean {
  return !policy.disabledGuards.includes(category);
}

// ── 访问范围检查 ──

export interface WecomSender {
  senderId: string;
  senderName: string;
  chatId: string;
}

export interface AccessResult {
  allowed: boolean;
  /** 被拒原因（日志用） */
  reason?: "not-in-allowlist" | "chat-not-allowed";
  /** 回给发送者的拒绝消息 */
  rejectMessage?: string;
}

/**
 * 判断这条消息的发送者是否被允许使用机器人。
 *
 * 名单同时匹配 sender_name 和 sender_id：企微推送的 sender_id 是一串
 * 不可读的 ID，让用户只能按 ID 配白名单不现实；但仅按姓名匹配又可能撞名，
 * 所以两者都接受，由使用者选择精确度。
 */
export function checkWecomAccess(sender: WecomSender, policy: WecomPolicy): AccessResult {
  // 会话限制独立于成员限制：即使放开所有人，也可以只允许特定群
  if (policy.allowedChats.length > 0) {
    const chats = policy.allowedChats.map(norm);
    if (!chats.includes(norm(sender.chatId))) {
      return {
        allowed: false,
        reason: "chat-not-allowed",
        rejectMessage: "⛔ 该会话未被授权使用此机器人。",
      };
    }
  }

  if (policy.accessMode === "everyone") return { allowed: true };

  const allowed = policy.allowedUsers.map(norm);
  const hit = allowed.includes(norm(sender.senderId)) || allowed.includes(norm(sender.senderName));
  if (hit) return { allowed: true };

  return {
    allowed: false,
    reason: "not-in-allowlist",
    rejectMessage: "⛔ 你不在该机器人的授权名单内，无法使用。请联系机器人所有者添加权限。",
  };
}

// ── 最近发言人（供白名单一键添加） ──
//
// 配白名单最大的障碍是不知道该填什么：sender_id 不可读，姓名也可能与
// 企微显示不一致。这里记录机器人实际收到过的发言人，UI 直接给出可点选项。

export interface SeenSender {
  senderId: string;
  senderName: string;
  chatId: string;
  /** 最近一次发言时间戳 */
  at: number;
  /** 是否曾被策略拦截 */
  blocked?: boolean;
}

const SENDERS_KEY = "nova.wecom.recentSenders";
const MAX_SENDERS = 12;

/** 读取最近发言人，按时间倒序 */
export function getRecentSenders(): SeenSender[] {
  try {
    const raw = localStorage.getItem(SENDERS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter(s => s && typeof s.senderId === "string")
      .sort((a, b) => (b.at || 0) - (a.at || 0));
  } catch {
    return [];
  }
}

/** 记录一次发言（同一 sender 只保留最新一条） */
export function rememberSender(s: Omit<SeenSender, "at">): void {
  try {
    const list = getRecentSenders().filter(x => x.senderId !== s.senderId);
    list.unshift({ ...s, at: Date.now() });
    localStorage.setItem(SENDERS_KEY, JSON.stringify(list.slice(0, MAX_SENDERS)));
  } catch {
    // localStorage 不可用时静默跳过，不影响消息处理
  }
}
