// ===== Skill 加载器 =====
//
// 通过 Tauri 后端命令加载 ~/.nova/skills/ 下的 skill。
// 后端已有 get_skills() 和 get_skill_content(name) 命令。

import { invoke } from "@tauri-apps/api/core";
import { skillRegistry } from "./skillRegistry";
import { buildSkill, createSkillMeta } from "./skillParser";
import type { SkillInfo } from "./types";

/** 是否已加载 */
let _loaded = false;

/**
 * 加载所有 skill 到注册表
 *
 * 先获取列表（元信息），再按需加载完整内容。
 * 对于 paths 模式匹配的 skill，延迟加载 content。
 * 对于 auto 触发无 paths 的 skill，立即加载 content。
 */
export async function loadSkills(): Promise<void> {
  console.log(`[Nova:Skills] 开始加载 skills`);
  skillRegistry.clear();

  try {
    const infos = await invoke<SkillInfo[]>("get_skills");
    if (!infos || infos.length === 0) {
      console.log(`[Nova:Skills] 获取到 skill 列表: 0 个`);
      _loaded = true;
      return;
    }

    console.log(`[Nova:Skills] 获取到 skill 列表: ${infos.length} 个`);

    let successCount = 0;
    for (const info of infos) {
      try {
        // 立即加载所有 skill 的完整内容（数量通常不多）
        const content = await invoke<string>("get_skill_content", { name: info.name });
        const skill = buildSkill(info, content);
        skillRegistry.register(skill);
        successCount++;
        console.log(`[Nova:Skills] 加载成功: ${info.name}`);
      } catch (err) {
        // 如果内容加载失败，仍然注册元信息
        skillRegistry.register(createSkillMeta(info));
        console.log(`[Nova:Skills] 加载失败: ${info.name}, 错误: ${err}`);
      }
    }

    _loaded = true;
    console.log(`[Nova:Skills] 全部加载完成, 成功加载: ${successCount} 个`);
  } catch (e) {
    console.error("[SkillLoader] failed to load skills:", e);
    _loaded = false;
  }
}

/**
 * 重新加载（刷新）
 */
export async function reloadSkills(): Promise<void> {
  _loaded = false;
  await loadSkills();
}

/**
 * 确保 skill 已加载（惰性）
 */
export async function ensureSkillsLoaded(): Promise<boolean> {
  if (_loaded) return true;
  await loadSkills();
  return _loaded;
}

/**
 * 获取当前激活的 skill 上下文（注入到 system prompt）
 *
 * @deprecated 使用 getStableSkillContext() + getVariableSkillContext() 代替
 * @param filePaths 当前操作的文件路径列表
 * @returns system prompt 文本或 null
 */
export async function getActiveSkillContext(filePaths: string[] = []): Promise<string | null> {
  await ensureSkillsLoaded();
  return skillRegistry.buildSystemContext(filePaths);
}

/**
 * 获取 stable 层 skill 上下文 — always-active skills（不依赖文件路径）
 *
 * 放在 system prompt 前缀，高 cache 命中率。
 */
export async function getStableSkillContext(): Promise<string | null> {
  await ensureSkillsLoaded();
  const ctx = skillRegistry.buildStableContext();
  console.log(`[Nova:Skills] getStableSkillContext: ${ctx ? `length=${ctx.length}` : 'null'}`);
  return ctx;
}

/**
 * 获取 variable 层 skill 上下文 — path-matched skills（依赖文件路径）
 *
 * 放在 stable 层之后，工作区/附件变化时可能不同。
 */
export async function getVariableSkillContext(filePaths: string[] = []): Promise<string | null> {
  await ensureSkillsLoaded();
  const ctx = skillRegistry.buildVariableContext(filePaths);
  console.log(`[Nova:Skills] getVariableSkillContext: ${ctx ? `length=${ctx.length}` : 'null'}`);
  return ctx;
}

/**
 * 获取 query 语义召回的 skill 上下文 — 场景型 skill（靠 keywords/description 召回）
 *
 * 面向蒸馏产出的无固定路径的场景型 skill，让其在相关场景自动浮现。
 * 放在 variable 层（每次可能不同）。
 */
export async function getQuerySkillContext(
  query: string,
  opts?: { threshold?: number; maxResults?: number },
): Promise<string | null> {
  if (!query || !query.trim()) return null;
  await ensureSkillsLoaded();
  const ctx = skillRegistry.buildQueryContext(query, opts);
  console.log(`[Nova:Skills] getQuerySkillContext: ${ctx ? `length=${ctx.length}` : 'null'}`);
  return ctx;
}

/**
 * 获取当前激活的 skill 名单（给 UI 用）
 *
 * @param filePaths 当前操作的文件路径列表
 * @returns { name, description, matched }[]
 */
export async function getActiveSkillList(filePaths: string[] = []): Promise<{ name: string; description: string; matched: boolean }[]> {
  await ensureSkillsLoaded();
  return skillRegistry.getActiveSkillList(filePaths);
}

/**
 * 保存新 skill 到磁盘
 */
export async function saveSkill(name: string, content: string): Promise<void> {
  await invoke("save_skill", { name, content });
  // 重新加载
  await reloadSkills();
}

/**
 * 删除 skill
 */
export async function deleteSkill(name: string): Promise<void> {
  await invoke("delete_skill", { name });
  skillRegistry.unregister(name);
}

/**
 * 同步 skill 到 kiro-cli 工作空间
 */
export async function syncToKiro(): Promise<string> {
  return await invoke<string>("sync_skills_to_kiro");
}

/**
 * 从 kiro-cli 同步 skill 到应用
 */
export async function syncFromKiro(): Promise<string> {
  const result = await invoke<string>("sync_kiro_skills_to_app");
  await reloadSkills();
  return result;
}

/** 是否已加载 */
export function isSkillsLoaded(): boolean {
  return _loaded;
}
