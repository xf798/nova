// ===== 蒸馏产出的可迁移性闸门 =====
//
// prompt 已要求 Skill 必须写清机制、按问题类型命名，但模型仍会偷懒退化成
// 「这次我敲了哪些命令」的步骤清单。实测 15 个历史 skill 里只有 3 个
// 含任何原因层面的表述，其余纯操作序列——换个人、换个项目就用不了。
//
// 这里在落盘前做一次机械校验：不合格的不静默丢弃，而是降级为待人工处理，
// 避免低质量资产直接进入召回池，把真正有用的挤掉。

import type { SkillCandidate } from "./types";

/**
 * 机制层表述的信号。
 *
 * 不能只认「根因/因为/导致」这类因果连接词——实测会误判：
 * 「DSML 每个 parameter 只有开始标记、没有闭合标记，边界靠下一个标记切断」
 * 是很清晰的机制陈述，却一个连接词都没有。
 * 因此同时接受「解释性小节标题」这类结构信号。
 */
const MECHANISM_HINTS = [
  "根因", "原因", "因为", "由于", "本质", "机制", "原理",
  "为什么", "导致", "触发", "成因", "技术事实", "核心原则",
  "脆弱", "约束", "限制", "前提", "决定", "否则", "会造成",
];

/** 解释性小节：出现即认为作者有意写「为什么」，而不只是罗列步骤 */
const EXPLANATORY_SECTIONS = /##\s*(根因|机制|原理|技术事实|核心原则|背景|设计考虑|注意事项|边界|陷阱|坑)/;

/**
 * 纯操作清单的判定：正文绝大多数非空行都是命令或裸步骤，
 * 几乎没有解释性散文。这个信号比「有没有因果词」可靠得多。
 */
function isBareCommandList(body: string): boolean {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const content = lines.filter((l) => !l.startsWith("#"));
  if (content.length < 3) return false;
  const mechanical = content.filter((l) =>
    /^\d+[.、)]/.test(l) ||          // 1. 2. 3.
    /^[-*]\s/.test(l) ||             // - 列表
    /^(git|npm|cd|ls|curl|sh|bash|python|node|docker|kubectl|mv|cp|rm|chmod|xattr|codesign)\b/.test(l) ||
    /^```/.test(l)
  );
  // 机械行占比过高即认为没有解释。阈值取 0.75：5 行里 4 行是命令/裸步骤
  // 就已经属于「只能照抄」的形态；而写清了机制的文档必然有多行散文说明，
  // 占比远低于此，不会被误伤。
  return mechanical.length / content.length > 0.75;
}

/** 只在本人环境成立的专有名词模式：出现在名称里说明抽象层次不够 */
const PRIVATE_NAME_HINTS = [
  "meinian", "salescloud", "neo-ai", "neo-apps", "neo-ui",
  "tchub", "crm-cd", "nova-releases",
];

export interface SkillQualityIssue {
  /** 机器可判定的问题标识 */
  code: "no-mechanism" | "bare-command-list" | "project-scoped-name" | "desc-duplicates-body" | "too-thin";
  message: string;
}

export interface SkillQualityVerdict {
  /** 是否达到可复用标准 */
  reusable: boolean;
  issues: SkillQualityIssue[];
}

/** 取正文里「适用场景」一节的首句，用于和 description 比对 */
function firstScenarioLine(body: string): string {
  const m = body.match(/##\s*适用场景\s*\n+([^\n]+)/);
  return m ? m[1].trim() : "";
}

function normalize(s: string): string {
  return s.replace(/[\s。，、；：（）()【】"'`]/g, "").toLowerCase();
}

/**
 * 判定一个 Skill 候选是否具备可迁移价值。
 *
 * 判据都是机械可测的，不做语义评分：宁可漏判，也不要因为规则太主观
 * 而把合格产出拦下来。
 */
export function assessSkillQuality(skill: SkillCandidate): SkillQualityVerdict {
  const issues: SkillQualityIssue[] = [];
  const body = skill.body || "";

  const hasMechanism =
    MECHANISM_HINTS.some((w) => body.includes(w)) || EXPLANATORY_SECTIONS.test(body);

  if (!hasMechanism) {
    issues.push({
      code: "no-mechanism",
      message: "正文没有任何原因/机制层面的表述，只有操作步骤，换场景无法迁移",
    });
  }

  if (isBareCommandList(body)) {
    issues.push({
      code: "bare-command-list",
      message: "正文几乎全是命令与裸步骤，缺少解释，读者只能照抄无法迁移",
    });
  }

  const name = (skill.name || "").toLowerCase();
  const hitPrivate = PRIVATE_NAME_HINTS.find((p) => name.includes(p));
  if (hitPrivate) {
    issues.push({
      code: "project-scoped-name",
      message: `名称含项目专有词「${hitPrivate}」，应按问题类型命名`,
    });
  }

  const scenario = firstScenarioLine(body);
  if (scenario && skill.description && normalize(scenario) === normalize(skill.description)) {
    issues.push({
      code: "desc-duplicates-body",
      message: "description 与正文「适用场景」首句重复，等于占两份召回预算说同一句话",
    });
  }

  // 正文过短基本不可能同时讲清信号、机制、处置、边界
  if (body.length < 120) {
    issues.push({
      code: "too-thin",
      message: `正文仅 ${body.length} 字，不足以承载可复用的方法`,
    });
  }

  // 拦截门槛刻意保守：机制检测存在误判风险（好的技术陈述可以不用因果词），
  // 因此单独缺机制只警告；只有「过短」或「既无机制又是纯命令清单」才拦下。
  const fatal =
    issues.some((i) => i.code === "too-thin") ||
    (!hasMechanism && issues.some((i) => i.code === "bare-command-list"));

  return { reusable: !fatal, issues };
}
