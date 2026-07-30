// ===== Skill 类型定义 =====

/** Skill 触发方式 */
export type SkillTrigger = "auto" | "manual";

/** Skill 配置项声明 */
export interface SkillSettingItem {
  /** 配置项 key（存储和读取用） */
  key: string;
  /** 显示标签 */
  label: string;
  /** 输入类型 */
  type: "text" | "password" | "toggle";
  /** 占位文字 */
  placeholder?: string;
  /** 描述说明 */
  description?: string;
  /** 对应的环境变量名（优先级高于配置值） */
  env?: string;
}

/** SKILL.md frontmatter */
export interface SkillFrontmatter {
  /** Skill 唯一标识 */
  id?: string;
  /** 显示名称 */
  name?: string;
  /** 简介 */
  summary?: string;
  description?: string;
  /** 条件激活：文件路径 glob 模式列表 */
  paths?: string[];
  /** 触发方式 */
  trigger?: SkillTrigger;
  /** 标签 */
  tags?: string[];
  /** 语义召回关键词（蒸馏产物用；无固定 path 的场景型 skill 靠它被召回） */
  keywords?: string[];
  /** Skill 需要的配置项（动态注入 Settings 页面） */
  settings?: SkillSettingItem[];
  /** 需要的环境变量列表（兼容旧格式） */
  requires?: { env?: string[] };
}

/** 完整的 Skill 对象 */
export interface Skill {
  /** Skill 目录名（唯一标识） */
  name: string;
  /** frontmatter 解析结果 */
  frontmatter: SkillFrontmatter;
  /** SKILL.md 正文（markdown，不含 frontmatter） */
  content: string;
  /** 文件路径 */
  path: string;
  /** 是否有 references 子目录 */
  hasReferences: boolean;
  /** 是否已加载完整内容 */
  loaded: boolean;
}

/** 后端返回的原始 skill 信息 */
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  has_references: boolean;
}
