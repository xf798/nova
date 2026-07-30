// ===== SKILL.md 解析器 =====
//
// 解析 SKILL.md 的 YAML frontmatter + markdown 正文。
// 不依赖外部 YAML 库，手写最小化解析器。

import type { Skill, SkillFrontmatter, SkillInfo, SkillSettingItem } from "./types";

// 从 SKILL.md 原始文本解析出 frontmatter 和正文
// 格式：--- 分隔的 YAML frontmatter + markdown 正文
export function parseSkillMd(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const fm: SkillFrontmatter = {};
  let body = raw;

  // 检测 frontmatter 起始 ---
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (fmMatch) {
    const fmText = fmMatch[1];
    body = fmMatch[2] || "";

    // 逐行解析 frontmatter
    const lines = fmText.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        i++;
        continue;
      }

      // 检测 key: value 或 key:（后跟数组）
      const kvMatch = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1];
        const value = kvMatch[2].trim();

        if (value === "") {
          // settings 块需要特殊解析（对象数组）
          if (key === "settings") {
            const { items, endIndex } = parseSettingsBlock(lines, i + 1);
            if (items.length > 0) {
              fm.settings = items;
            }
            i = endIndex;
          } else {
            // 可能是数组，检查后续缩进行
            const arr: string[] = [];
            i++;
            while (i < lines.length) {
              const arrLine = lines[i];
              const arrMatch = arrLine.match(/^\s+-\s+"?(.*?)"?\s*$/);
              if (arrMatch) {
                arr.push(arrMatch[1]);
                i++;
              } else {
                break;
              }
            }
            if (arr.length > 0) {
              setFrontmatter(fm, key, arr);
            }
          }
        } else {
          // 去除引号
          const cleanValue = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
          setFrontmatter(fm, key, cleanValue);
          i++;
        }
      } else {
        i++;
      }
    }
  }

  return { frontmatter: fm, body: body.trim() };
}

/** 设置 frontmatter 字段 */
function setFrontmatter(fm: SkillFrontmatter, key: string, value: string | string[]): void {
  switch (key) {
    case "id":
      if (typeof value === "string") fm.id = value;
      break;
    case "name":
    case "title":
      if (typeof value === "string") fm.name = value;
      break;
    case "summary":
      if (typeof value === "string") fm.summary = value;
      break;
    case "description":
      if (typeof value === "string") fm.description = value;
      break;
    case "paths":
    case "path":
      fm.paths = Array.isArray(value) ? value : [value];
      break;
    case "trigger":
      if (typeof value === "string" && (value === "auto" || value === "manual")) {
        fm.trigger = value;
      }
      break;
    case "tags":
      fm.tags = Array.isArray(value) ? value : value.split(",").map(t => t.trim());
      break;
    case "keywords":
      fm.keywords = Array.isArray(value) ? value : value.split(",").map(t => t.trim());
      break;
  }
}

/**
 * 解析 settings 对象数组块（YAML list-of-objects 格式）
 */
export function parseSettingsBlock(lines: string[], startIndex: number): { items: SkillSettingItem[]; endIndex: number } {
  const items: SkillSettingItem[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    // 新的 setting item 起始: "  - key: xxx"
    const itemStart = line.match(/^\s+-\s+key\s*:\s*(.+)$/);
    if (itemStart) {
      const item: SkillSettingItem = { key: itemStart[1].trim(), label: "", type: "text" };
      i++;
      // 解析该 item 的后续属性行
      while (i < lines.length) {
        const propLine = lines[i];
        // 下一个 item 或 block 结束
        if (propLine.match(/^\s+-\s+key\s*:/) || !propLine.match(/^\s+/)) break;
        const propMatch = propLine.match(/^\s+([\w-]+)\s*:\s*(.+)$/);
        if (propMatch) {
          const pk = propMatch[1].trim();
          const pv = propMatch[2].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
          switch (pk) {
            case "label": item.label = pv; break;
            case "type": item.type = pv as any; break;
            case "placeholder": item.placeholder = pv; break;
            case "description": item.description = pv; break;
            case "env": item.env = pv; break;
          }
          i++;
        } else {
          i++;
        }
      }
      if (!item.label) item.label = item.key;
      items.push(item);
    } else if (!line.match(/^\s/)) {
      // 非缩进行 → block 结束
      break;
    } else {
      i++;
    }
  }

  return { items, endIndex: i };
}

/**
 * 将后端 SkillInfo + content 构建为完整 Skill 对象
 */
export function buildSkill(info: SkillInfo, content: string): Skill {
  const { frontmatter, body } = parseSkillMd(content);

  // 如果 frontmatter 没有指定 name，用目录名
  if (!frontmatter.name) {
    frontmatter.name = info.name;
  }
  // 如果没有 description，用后端的 description
  if (!frontmatter.description && !frontmatter.summary) {
    frontmatter.description = info.description;
  }

  return {
    name: info.name,
    frontmatter,
    content: body,
    path: info.path,
    hasReferences: info.has_references,
    loaded: true,
  };
}

/**
 * 创建一个仅含元信息的 Skill（内容未加载）
 */
export function createSkillMeta(info: SkillInfo): Skill {
  return {
    name: info.name,
    frontmatter: {
      name: info.name,
      description: info.description,
    },
    content: "",
    path: info.path,
    hasReferences: info.has_references,
    loaded: false,
  };
}
