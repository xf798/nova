// ===== 插件加载器 =====
//
// 运行时从 ~/.nova/plugins/ 目录扫描并动态加载插件。
// 插件为预编译的 ESM bundle，通过 import() 加载。
// 同时保留内置插件的静态加载（作为 fallback）。

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import React from "react";
import { pluginRegistry } from "./registry";
import type { Plugin, PluginManifest, RuntimePluginExports, HostModules } from "./types";
import { createPluginContext } from "./context";

// 内置插件引用（fallback，当外部目录没有同 id 的插件时使用）
import { workspacePlugin } from "./builtin/workspace";

/** 所有内置插件 */
const BUILTIN_PLUGINS: Plugin[] = [
  workspacePlugin,
];

/** 插件启用状态配置 */
interface PluginConfig {
  enabled: Record<string, boolean>;
}

const DEFAULT_CONFIG: PluginConfig = {
  enabled: {
    workspace: true,
  },
};

let _config: PluginConfig = { ...DEFAULT_CONFIG };

/** 宿主模块注入（传给运行时插件，避免重复打包 React） */
const HOST_MODULES: HostModules = {
  React,
  shell: { Command },
};

/** 外部插件目录 */
const PLUGINS_DIR_NAME = ".nova/plugins";

/** 已加载的运行时插件 ID（用于跳过同 ID 的内置插件） */
const loadedExternalIds = new Set<string>();

// ─── 主入口 ───

/** 加载所有插件（外部 + 内置） */
export async function loadPlugins(): Promise<void> {
  // 1. 读取启用配置
  try {
    const data = await invoke<string>("get_plugin_data", { pluginId: "__plugin_loader" });
    const parsed = JSON.parse(data || "{}");
    if (parsed.enabled) {
      _config.enabled = { ...DEFAULT_CONFIG.enabled, ...parsed.enabled };
    }
  } catch {}

  // 2. 加载外部运行时插件
  await loadExternalPlugins();

  // 3. 加载内置插件（跳过已被外部插件覆盖的）
  for (const plugin of BUILTIN_PLUGINS) {
    if (loadedExternalIds.has(plugin.id)) {
      console.log(`[PluginLoader] 内置插件 ${plugin.id} 被外部插件覆盖，跳过`);
      continue;
    }
    if (_config.enabled[plugin.id] !== false) {
      pluginRegistry.register(plugin);
    }
  }
}

// ─── 外部插件加载 ───

async function loadExternalPlugins(): Promise<void> {
  // 注入 React 到全局变量（供外部插件通过 shim 获取）
  (globalThis as any).__novaHostReact = React;

  try {
    // 获取用户 home 目录
    const homeCmd = Command.create("sh", ["-c", "echo $HOME"]);
    const homeResult = await homeCmd.execute();
    const home = homeResult.stdout.trim();
    if (!home) return;

    const pluginsDir = `${home}/${PLUGINS_DIR_NAME}`;
    console.log(`[PluginLoader] 扫描外部插件目录: ${pluginsDir}`);

    // 列出插件目录下的子目录
    let dirNames: string[];
    try {
      const lsCmd = Command.create("sh", ["-c", `ls -1 "${pluginsDir}" 2>/dev/null`]);
      const lsResult = await lsCmd.execute();
      if (lsResult.code !== 0 || !lsResult.stdout.trim()) {
        console.log("[PluginLoader] ~/.nova/plugins/ 目录不存在或为空，跳过外部插件加载");
        return;
      }
      dirNames = lsResult.stdout.trim().split("\n").filter(Boolean);
    } catch {
      console.log("[PluginLoader] ~/.nova/plugins/ 目录不存在，跳过外部插件加载");
      return;
    }

    // 遍历每个子目录
    for (const dirName of dirNames) {
      const pluginDir = `${pluginsDir}/${dirName}`;
      // 检查是否为目录且包含 manifest.json
      const checkCmd = Command.create("sh", ["-c", `test -d "${pluginDir}" && test -f "${pluginDir}/manifest.json" && echo "ok"`]);
      const checkResult = await checkCmd.execute();
      if (checkResult.stdout.trim() !== "ok") continue;

      try {
        await loadSinglePlugin(pluginDir, dirName);
      } catch (err: any) {
        console.error(`[PluginLoader] 加载插件 ${dirName} 失败:`, err.message || err);
      }
    }
  } catch (err: any) {
    console.error("[PluginLoader] 外部插件加载异常:", err.message || err);
  }
}

async function loadSinglePlugin(pluginDir: string, dirName: string): Promise<void> {
  // 1. 读取 manifest.json
  const manifestPath = `${pluginDir}/manifest.json`;
  const catCmd = Command.create("sh", ["-c", `cat "${manifestPath}"`]);
  const catResult = await catCmd.execute();
  if (catResult.code !== 0) {
    throw new Error(`无法读取 manifest.json: ${catResult.stderr}`);
  }
  const manifest: PluginManifest = JSON.parse(catResult.stdout);

  // 验证必须字段
  if (!manifest.id || !manifest.name || !manifest.version) {
    throw new Error(`manifest.json 缺少必须字段 (id/name/version)`);
  }

  // 检查是否启用
  if (_config.enabled[manifest.id] === false) {
    console.log(`[PluginLoader] 插件 ${manifest.id} 已禁用，跳过`);
    return;
  }

  // 2. 动态加载入口文件
  const entryFile = manifest.entry || "index.js";
  const entryPath = `${pluginDir}/${entryFile}`;

  // 将本地路径转为可访问的 URL
  const assetUrl = convertFileSrc(entryPath);
  console.log(`[PluginLoader] 加载插件 ${manifest.id}: path=${entryPath}, assetUrl=${assetUrl}`);

  let exports: RuntimePluginExports;

  // IIFE 格式加载（最可靠方式：通过 shell cat 读取文件内容后 eval）
  try {
    const catCmd = Command.create("sh", ["-c", `cat "${entryPath}"`]);
    const catResult = await catCmd.execute();
    if (catResult.code !== 0) {
      throw new Error(`读取入口文件失败: ${catResult.stderr}`);
    }
    const scriptText = catResult.stdout;
    console.log(`[PluginLoader] 读取脚本成功, 长度: ${scriptText.length}`);

    const globalVarName = `__novaPlugin_${manifest.id.replace(/-/g, "_")}`;
    const fn = new Function(scriptText + `\nreturn typeof ${globalVarName} !== 'undefined' ? ${globalVarName} : null;`);
    const result = fn();

    if (!result) {
      // 可能是 ESM 格式 — 尝试 import()
      console.log(`[PluginLoader] IIFE eval 无结果，尝试 ESM import...`);
      const module = await import(/* @vite-ignore */ assetUrl);
      exports = module.default || module;
    } else {
      console.log(`[PluginLoader] IIFE eval 成功, keys:`, Object.keys(result));
      exports = result.default || result;
    }
  } catch (err: any) {
    throw new Error(`无法加载插件入口文件: ${err.message}`);
  }

  if (!exports || typeof exports.activate !== "function") {
    throw new Error(`插件 ${manifest.id} 的入口文件没有导出 activate 函数`);
  }

  // 3. 创建上下文并激活
  const context = createPluginContext(manifest.id);
  const pluginResult = exports.activate(context, HOST_MODULES);

  // 4. 构造完整 Plugin 对象
  const plugin: Plugin = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    // 如果 activate 返回了 Plugin 对象，合并其 UI 扩展
    ...(pluginResult || {}),
    // 确保 id/name/version 来自 manifest
    ...(pluginResult ? {} : {}),
  };

  // 如果 manifest 声明了 sidebar 但 plugin 没有 sidebarItems，用 manifest 的
  if (manifest.sidebar && !plugin.sidebarItems?.length) {
    // sidebar 图标：如果是 SVG 字符串则渲染为 dangerouslySetInnerHTML
    const iconSvg = manifest.sidebar.icon || "";
    const iconElement = iconSvg.startsWith("<svg")
      ? React.createElement("span", { dangerouslySetInnerHTML: { __html: iconSvg } })
      : React.createElement("span", null, "⚡");

    plugin.sidebarItems = [{
      id: manifest.id,
      label: manifest.sidebar.label,
      icon: iconElement,
      order: manifest.sidebar.order || 50,
      component: () => React.createElement("div", null, `插件 ${manifest.name} 未提供侧边栏组件`),
    }];
  }

  // 5. 注册到 registry
  pluginRegistry.register(plugin);
  loadedExternalIds.add(manifest.id);

  console.log(`[PluginLoader] 已加载外部插件: ${manifest.name} v${manifest.version} (${dirName}/)`);
}

// ─── 插件管理 API ───

/** 启用插件 */
export async function enablePlugin(pluginId: string): Promise<void> {
  _config.enabled[pluginId] = true;
  const plugin = BUILTIN_PLUGINS.find(p => p.id === pluginId);
  if (plugin && !pluginRegistry.get(pluginId)) {
    pluginRegistry.register(plugin);
  }
  await persistConfig();
}

/** 禁用插件 */
export async function disablePlugin(pluginId: string): Promise<void> {
  _config.enabled[pluginId] = false;
  pluginRegistry.unregister(pluginId);
  await persistConfig();
}

/** 判断插件是否启用 */
export function isPluginEnabled(pluginId: string): boolean {
  return _config.enabled[pluginId] !== false;
}

/** 获取所有可用插件（含启用状态） */
export function getAvailablePlugins(): { plugin: Plugin; enabled: boolean }[] {
  // 内置插件
  const builtinList = BUILTIN_PLUGINS.map(p => ({
    plugin: p,
    enabled: _config.enabled[p.id] !== false,
  }));

  // 外部加载的插件
  const externalList = Array.from(loadedExternalIds).map(id => {
    const plugin = pluginRegistry.get(id);
    return plugin ? { plugin, enabled: true } : null;
  }).filter(Boolean) as { plugin: Plugin; enabled: boolean }[];

  return [...builtinList, ...externalList];
}

/** 重新加载外部插件（热刷新） */
export async function reloadExternalPlugins(): Promise<void> {
  // 先卸载所有外部插件
  for (const id of loadedExternalIds) {
    pluginRegistry.unregister(id);
  }
  loadedExternalIds.clear();

  // 重新加载
  await loadExternalPlugins();
}

async function persistConfig(): Promise<void> {
  try {
    await invoke("save_plugin_data", {
      pluginId: "__plugin_loader",
      data: JSON.stringify(_config),
    });
  } catch {}
}
