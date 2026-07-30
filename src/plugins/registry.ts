// ===== 插件注册中心 =====

import type { Plugin, SidebarItem, SettingsSection } from "./types";
import { createPluginContext } from "./context";
import type { PluginContext } from "./context";

class PluginRegistry {
  private plugins: Map<string, Plugin> = new Map();
  private contexts: Map<string, PluginContext> = new Map();

  /** 注册并激活插件 */
  register(plugin: Plugin): void {
    this.plugins.set(plugin.id, plugin);
    const context = createPluginContext(plugin.id);
    this.contexts.set(plugin.id, context);
    plugin.activate?.(context);
  }

  /** 注销插件 */
  unregister(id: string): void {
    const plugin = this.plugins.get(id);
    plugin?.deactivate?.();
    this.plugins.delete(id);
    this.contexts.delete(id);
  }

  /** 获取插件的 context */
  getContext(pluginId: string): PluginContext | undefined {
    return this.contexts.get(pluginId);
  }

  /** 获取所有插件 */
  getAll(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /** 获取指定插件 */
  get(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  /** 获取所有侧边栏扩展项（按 order 排序） */
  getSidebarItems(): SidebarItem[] {
    return this.getAll()
      .flatMap(p => p.sidebarItems || [])
      .sort((a, b) => a.order - b.order);
  }

  /** 获取所有设置扩展区块（按 order 排序） */
  getSettingsSections(): SettingsSection[] {
    return this.getAll()
      .flatMap(p => p.settingsSections || [])
      .sort((a, b) => a.order - b.order);
  }

  /** 获取插件页面组件（通过 sidebarItems 或 page 字段） */
  getPageComponent(pluginId: string): (() => import("react").ReactNode) | null {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return null;
    // 优先从 sidebarItems 取
    const sidebarItem = plugin.sidebarItems?.find(i => i.id === pluginId);
    if (sidebarItem) return sidebarItem.component;
    // 其次从 page 字段取
    if (plugin.page) return plugin.page.component;
    return null;
  }
}

// 单例
export const pluginRegistry = new PluginRegistry();
