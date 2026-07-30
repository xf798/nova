// ===== 插件系统类型 =====

import type { ReactNode } from "react";
import type { PluginContext } from "./context";

/** 侧边栏扩展项 */
export interface SidebarItem {
  id: string;
  label: string;
  icon: ReactNode;
  order: number;          // 排序（越小越靠前）
  component: () => ReactNode;
}

/** 设置面板扩展区块 */
export interface SettingsSection {
  id: string;
  title: string;
  order: number;
  component: () => ReactNode;
}

/** 插件页面（可选，不在侧边栏但可通过「能力」页面打开） */
export interface PluginPage {
  id: string;
  component: () => ReactNode;
}

/** 插件定义（内置插件 + 运行时插件共用） */
export interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;

  // UI 扩展点（声明式）
  sidebarItems?: SidebarItem[];
  settingsSections?: SettingsSection[];
  /** 插件页面 — 即使不在侧边栏也可通过路由打开 */
  page?: PluginPage;

  // 生命周期
  activate?(context: PluginContext): void;
  deactivate?(): void;
}

// ===== 运行时插件 manifest (manifest.json) =====
//
// 放置在 ~/.nova/plugins/<plugin-dir>/manifest.json
//
// {
//   "id": "auto-program",
//   "name": "AutoProgram",
//   "version": "3.0.0",
//   "description": "自动化开发流水线",
//   "entry": "index.js",           ← ESM bundle 入口
//   "sidebar": {                    ← 可选，侧边栏配置
//     "label": "AutoProgram",
//     "icon": "pipeline",           ← 内置图标 key 或 SVG 字符串
//     "order": 15
//   }
// }

/** 运行时插件 manifest.json 的类型定义 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 入口文件（相对于插件目录，默认 "index.js"） */
  entry?: string;
  /** 侧边栏配置 */
  sidebar?: {
    label: string;
    icon: string;   // 内置图标 key 或 inline SVG 字符串
    order: number;
  };
}

/**
 * 运行时插件的导出接口约定：
 * 
 * 插件 ESM bundle 必须 default export 一个对象，包含：
 * - activate(context: PluginContext, React: typeof React): Plugin | void
 *   接收 PluginContext + 宿主 React 引用（避免重复打包 React）
 *   返回 Plugin 对象（含 sidebarItems 等）或 void
 * - deactivate?(): void
 */
export interface RuntimePluginExports {
  activate(context: PluginContext, hostModules: HostModules): Plugin | void;
  deactivate?(): void;
}

/** 宿主向插件注入的模块引用 */
export interface HostModules {
  React: typeof import("react");
  /** 宿主提供的常用工具（如 tauri shell command 等） */
  shell: { Command: any };
}
