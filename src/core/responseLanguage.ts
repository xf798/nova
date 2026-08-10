/**
 * 回复语言约束
 *
 * 光靠 Agent 自觉不可靠：实测「录音新版」会话里最终答复 85:1 是中文，
 * 但夹在工具调用之间的过程叙述句有 15 段是英文
 * （如 "Now let me make the L1 edits. First the two audio call sites:"），
 * 思考段更是 14 段全英文。也就是说模型把「正式回答」和「过程叙述」
 * 当成了两档，只对前者切换语言。换个会话或换个模型还会漂回去。
 *
 * 所以约束放在 Nova 这层统一注入，对所有连接器生效：
 * kiro-cli 的 agent prompt 不由 Nova 控制，但注入走的是和记忆、技能
 * 相同的通道，后端换成谁都跑不掉。
 */

/** 覆盖键：系统语言不是中文但仍想要中文回复时用（无 UI，改 localStorage 即可） */
const OVERRIDE_KEY = "nova.responseLanguage";

/** 目标语言标签，zh = 简体中文 */
export type ResponseLanguage = "zh" | "en" | "other";

/** 把 BCP-47 标签归到我们关心的几档 */
export function normalizeLanguage(tag: string | undefined | null): ResponseLanguage {
  const t = (tag || "").trim().toLowerCase();
  if (!t) return "other";
  if (t === "zh" || t.startsWith("zh-") || t.startsWith("zh_")) return "zh";
  if (t === "en" || t.startsWith("en-") || t.startsWith("en_")) return "en";
  return "other";
}

/**
 * 判定应当使用的回复语言。
 *
 * 优先级：localStorage 覆盖 > 系统/浏览器语言 > 中文兜底。
 * 兜底选中文而非英文：Nova 目前的使用者是中文用户，
 * 取不到语言时按中文处理比按英文处理更可能正确。
 */
export function detectPreferredLanguage(): ResponseLanguage {
  try {
    const override = localStorage.getItem(OVERRIDE_KEY);
    if (override) return normalizeLanguage(override);
  } catch {
    // localStorage 不可用（非浏览器环境）时忽略
  }
  try {
    return normalizeLanguage(navigator.language);
  } catch {
    return "zh";
  }
}

/**
 * 构造注入用的语言约束段。
 *
 * 只在需要中文时注入：模型默认就用英文，给英文用户再加一段是纯噪音。
 * 约束里必须点名「过程叙述」和「思考」—— 漏的正是这两处，
 * 只说「用中文回复」模型会理解成只管最终答复。
 */
export function buildLanguageDirective(
  lang: ResponseLanguage = detectPreferredLanguage(),
): string | null {
  if (lang !== "zh") return null;
  return `<response_language>
全程使用简体中文，包括：
- 最终答复
- 夹在工具调用之间的过程叙述（如「现在改这两处调用点」）
- 思考内容（用户界面会渲染思考段落，它同样是用户可见的输出）
代码、标识符、文件路径、命令、报错原文保持原样，不要翻译。
</response_language>`;
}
