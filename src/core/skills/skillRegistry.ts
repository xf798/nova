// ===== Skill 注册表 =====
//
// 管理已加载的 skill，提供按路径匹配的条件激活查询。

import type { Skill } from "./types";
import { tokenize } from "../memory/recall";

/**
 * 将 glob 模式转换为 RegExp
 *
 * 支持：
 *   **  → 任意层级目录
 *   *   → 当前层级通配
 *   ?   → 单字符
 *   其余字符转义
 */
function globToRegExp(pattern: string): RegExp {
  // 转义正则特殊字符
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // ** → 任意路径（含 /）
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    // * → 非 / 的任意字符
    .replace(/\*/g, "[^/]*")
    // ? → 非 / 的单字符
    .replace(/\?/g, "[^/]")
    // 恢复 GLOBSTAR
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");

  return new RegExp(`^${regex}$`);
}

/**
 * SkillRegistry — 管理已加载的 skill 集合
 */
class SkillRegistryClass {
  private skills = new Map<string, Skill>();
  private matchCache = new Map<string, RegExp>();

  /** 注册 skill */
  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
    // 预编译 paths 匹配
    if (skill.frontmatter.paths) {
      for (const pattern of skill.frontmatter.paths) {
        if (!this.matchCache.has(pattern)) {
          this.matchCache.set(pattern, globToRegExp(pattern));
        }
      }
    }
  }

  /** 注销 skill */
  unregister(name: string): void {
    this.skills.delete(name);
  }

  /** 清空 */
  clear(): void {
    this.skills.clear();
    this.matchCache.clear();
  }

  /** 获取单个 skill */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** 获取所有 skill */
  getAll(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * 按文件路径匹配 skill（条件激活）
   *
   * @param filePaths 当前操作的文件路径列表
   * @returns 匹配的 skill 列表
   */
  matchByPaths(filePaths: string[]): Skill[] {
    if (filePaths.length === 0) return [];

    const matched = new Set<Skill>();

    for (const skill of this.skills.values()) {
      const paths = skill.frontmatter.paths;
      if (!paths || paths.length === 0) continue;

      for (const pattern of paths) {
        const regex = this.matchCache.get(pattern);
        if (!regex) continue;

        for (const filePath of filePaths) {
          if (regex.test(filePath)) {
            matched.add(skill);
            break;
          }
        }
      }
    }

    return Array.from(matched);
  }

  /**
   * 按查询语义匹配 skill（关键词/描述/标签打分召回）
   *
   * 面向"场景型" skill（无固定文件路径，靠 keywords/description 被召回）。
   * 复用 recall.ts 的分词器，对 name/description/keywords/tags 打分，
   * 取分数 >= threshold 的 top-N。
   *
   * @param query 用户当前输入
   * @param opts 阈值与上限
   * @returns 命中的 skill（按分数降序）
   */
  matchByQuery(
    query: string,
    opts?: { threshold?: number; maxResults?: number },
  ): Skill[] {
    return this.queryScored(query, opts).map((s) => s.skill);
  }

  /** query 打分（内部复用：matchByQuery + getActiveWithSource） */
  private queryScored(
    query: string,
    opts?: { threshold?: number; maxResults?: number },
  ): { skill: Skill; score: number }[] {
    const threshold = opts?.threshold ?? 0.2;
    const maxResults = opts?.maxResults ?? 3;
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scored: { skill: Skill; score: number }[] = [];
    for (const skill of this.skills.values()) {
      // 常驻 skill 已在 stable 层注入，跳过避免重复
      if (this.isAlwaysActive(skill)) continue;
      const score = this.scoreSkill(skill, queryTokens);
      if (score >= threshold) scored.push({ skill, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
  }

  /**
   * 获取本次激活的 skill 及来源（供召回可观测 UI）
   *
   * 合并三路：常驻(always) / 路径匹配(path) / 语义召回(query)，按此优先级去重。
   *
   * @param filePaths 当前文件路径（附件/工作区）
   * @param query 用户输入（有则计算语义召回）
   */
  getActiveWithSource(
    filePaths: string[] = [],
    query?: string,
  ): { name: string; displayName: string; source: "always" | "path" | "query"; distilled: boolean; score?: number }[] {
    const result: { name: string; displayName: string; source: "always" | "path" | "query"; distilled: boolean; score?: number }[] = [];
    const seen = new Set<string>();
    const isDistilled = (s: Skill) => (s.frontmatter.tags || []).includes("distilled");
    const push = (s: Skill, source: "always" | "path" | "query", score?: number) => {
      if (seen.has(s.name)) return;
      seen.add(s.name);
      result.push({
        name: s.name,
        displayName: s.frontmatter.name || s.name,
        source,
        distilled: isDistilled(s),
        score,
      });
    };

    for (const s of this.getAlwaysActive()) push(s, "always");
    for (const s of this.matchByPaths(filePaths)) push(s, "path");
    if (query && query.trim()) {
      for (const { skill, score } of this.queryScored(query)) push(skill, "query", score);
    }
    return result;
  }

  /** 对单个 skill 相对 query 打分（0~1） */
  private scoreSkill(skill: Skill, queryTokens: string[]): number {
    const fm = skill.frontmatter;
    // 关键词命中（权重最高）
    const kwTokens = new Set(
      (fm.keywords || []).flatMap((k) => tokenize(k)),
    );
    // 描述 + 名称
    const descTokens = new Set(
      tokenize(`${fm.name || skill.name} ${fm.description || fm.summary || ""}`),
    );
    // 标签
    const tagTokens = new Set((fm.tags || []).flatMap((t) => tokenize(t)));

    let kwHits = 0;
    let descHits = 0;
    let tagHits = 0;
    for (const t of queryTokens) {
      if (kwTokens.has(t)) kwHits++;
      if (descTokens.has(t)) descHits++;
      if (tagTokens.has(t)) tagHits++;
    }
    const denom = Math.min(queryTokens.length, 8);
    const kwScore = kwTokens.size > 0 ? Math.min(1, kwHits / denom) : 0;
    const descScore = descTokens.size > 0 ? Math.min(1, descHits / denom) : 0;
    const tagScore = tagTokens.size > 0 ? Math.min(1, tagHits / denom) : 0;

    return Math.min(1, kwScore * 0.55 + descScore * 0.3 + tagScore * 0.15);
  }

  /**
   * 构建 variable 层 query-matched skill 上下文
   *
   * @param query 用户当前输入
   * @param opts 阈值与上限
   * @returns system prompt 文本，或 null
   */
  buildQueryContext(
    query: string,
    opts?: { threshold?: number; maxResults?: number },
  ): string | null {
    const matched = this.matchByQuery(query, opts);
    if (matched.length === 0) return null;
    return this.formatSkills(matched, "[激活的 Skill · 场景召回]");
  }

  /**
   * 获取所有 auto 触发且无 paths 限制的 skill
   * 这些 skill 在每次对话时都应注入
   *
   * 注意：带 keywords 的「场景型」skill（多为蒸馏产物）不算常驻，
   * 它们只通过 matchByQuery 在相关场景召回，避免每次都注入膨胀上下文。
   */
  getAlwaysActive(): Skill[] {
    return this.getAll().filter(s => {
      const trigger = s.frontmatter.trigger;
      const hasPaths = s.frontmatter.paths && s.frontmatter.paths.length > 0;
      const hasKeywords = s.frontmatter.keywords && s.frontmatter.keywords.length > 0;
      // trigger=auto 且没有 paths 限制、且不是场景型（无 keywords） → 始终激活
      return trigger === "auto" && !hasPaths && !hasKeywords;
    });
  }

  /** 判断 skill 是否为常驻（用于 matchByQuery 去重，避免与 stable 层重复注入） */
  private isAlwaysActive(s: Skill): boolean {
    const trigger = s.frontmatter.trigger;
    const hasPaths = s.frontmatter.paths && s.frontmatter.paths.length > 0;
    const hasKeywords = s.frontmatter.keywords && s.frontmatter.keywords.length > 0;
    return trigger === "auto" && !hasPaths && !hasKeywords;
  }

  /**
   * 构建 stable 层 skill 上下文 — always-active skills（trigger=auto 且无 paths）
   *
   * 这部分不依赖文件路径，几乎不变 → 放在 system prompt 前缀 → 高 cache 命中率。
   *
   * @returns system prompt 文本，或 null
   */
  buildStableContext(): string | null {
    const alwaysActive = this.getAlwaysActive();
    if (alwaysActive.length === 0) return null;
    return this.formatSkills(alwaysActive, "[激活的 Skill · 常驻]");
  }

  /**
   * 构建 variable 层 skill 上下文 — path-matched skills（依赖文件路径）
   *
   * 每次工作区/附件变化时可能不同 → 放在 stable 层之后。
   *
   * @param filePaths 当前操作的文件路径列表
   * @returns system prompt 文本，或 null
   */
  buildVariableContext(filePaths: string[] = []): string | null {
    const pathMatched = this.matchByPaths(filePaths);
    if (pathMatched.length === 0) return null;
    return this.formatSkills(pathMatched, "[激活的 Skill · 路径匹配]");
  }

  /**
   * 格式化 skill 列表为 system prompt 文本
   */
  private formatSkills(skills: Skill[], header: string): string {
    const sections = skills.map(skill => {
      const title = skill.frontmatter.name || skill.name;
      const desc = skill.frontmatter.description || skill.frontmatter.summary || "";
      const sectionHeader = desc ? `## ${title}\n${desc}` : `## ${title}`;

      // 只取正文的前 2000 字符，避免上下文膨胀
      const body = skill.content
        ? skill.content.length > 2000
          ? skill.content.slice(0, 2000) + "\n...[截断]"
          : skill.content
        : "";

      return body ? `${sectionHeader}\n${body}` : sectionHeader;
    });

    return `${header}\n${sections.join("\n\n---\n\n")}`;
  }

  /**
   * 构建注入到 system prompt 的 skill 上下文（stable + variable 合并）
   *
   * @deprecated 使用 buildStableContext() + buildVariableContext() 代替，以获得更好的 cache 命中率
   * @param filePaths 当前操作的文件路径（可选）
   * @returns system prompt 文本，或 null
   */
  buildSystemContext(filePaths: string[] = []): string | null {
    const alwaysActive = this.getAlwaysActive();
    const pathMatched = this.matchByPaths(filePaths);

    // 去重合并
    const all = new Set<Skill>([...alwaysActive, ...pathMatched]);
    if (all.size === 0) return null;

    const sections = Array.from(all).map(skill => {
      const title = skill.frontmatter.name || skill.name;
      const desc = skill.frontmatter.description || skill.frontmatter.summary || "";
      const header = desc ? `## ${title}\n${desc}` : `## ${title}`;

      // 只取正文的前 2000 字符，避免上下文膨胀
      const body = skill.content
        ? skill.content.length > 2000
          ? skill.content.slice(0, 2000) + "\n...[截断]"
          : skill.content
        : "";

      return body ? `${header}\n${body}` : header;
    });

    return `[激活的 Skill]\n${sections.join("\n\n---\n\n")}`;
  }

  /**
   * 获取当前激活的 skill 列表（给 UI 用）
   *
   * @param filePaths 当前操作的文件路径列表
   * @returns { name, description }[]
   */
  getActiveSkillList(filePaths: string[] = []): { name: string; description: string; matched: boolean }[] {
    const alwaysActive = this.getAlwaysActive();
    const pathMatched = this.matchByPaths(filePaths);

    const result: { name: string; description: string; matched: boolean }[] = [];
    const seen = new Set<string>();

    for (const skill of alwaysActive) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        result.push({
          name: skill.frontmatter.name || skill.name,
          description: skill.frontmatter.description || skill.frontmatter.summary || "",
          matched: false,
        });
      }
    }

    for (const skill of pathMatched) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        result.push({
          name: skill.frontmatter.name || skill.name,
          description: skill.frontmatter.description || skill.frontmatter.summary || "",
          matched: true,
        });
      }
    }

    return result;
  }

  /** 获取统计 */
  getStats(): { total: number; loaded: number; withPaths: number } {
    const all = this.getAll();
    return {
      total: all.length,
      loaded: all.filter(s => s.loaded).length,
      withPaths: all.filter(s => s.frontmatter.paths && s.frontmatter.paths.length > 0).length,
    };
  }
}

/** 全局单例 */
export const skillRegistry = new SkillRegistryClass();
