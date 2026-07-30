// ===== 插件上下文 =====

import { PluginStorage } from "../core/storage";
import { eventBus } from "../core/events";
import { toolRegistry } from "../core/tools";
import type { ToolHandler, ToolParam, ToolResult } from "../core/tools";
import { connectorRegistry } from "../connectors/registry";
import { KiroCliConnector } from "../connectors/builtin/kiro-cli";
import type { SidebarItem, SettingsSection } from "./types";

/**
 * UI 扩展 API — 插件通过此接口注册 UI 组件
 */
export interface UIExtensionAPI {
  /** 注册侧边栏项（activate 时调用） */
  registerSidebarItem(item: SidebarItem): void;
  /** 注册设置面板区块 */
  registerSettingsSection(section: SettingsSection): void;
  /** 显示 toast 通知 */
  showNotification(message: string, type?: "info" | "success" | "error"): void;
}

/**
 * Tools API — 插件通过此接口注册和调用 tools
 */
export interface PluginToolsAPI {
  /** 注册 tool（插件 activate 时调用） */
  register(name: string, handler: ToolHandler, meta?: {
    description: string;
    params?: ToolParam[];
    returns?: string;
    category?: string;
  }): void;
  /** 注销 tool */
  unregister(name: string): void;
  /** 调用其他 tool */
  call(name: string, params?: any): Promise<ToolResult>;
  /** 列出所有可用 tools */
  list(): { name: string; description: string }[];
}

/** @deprecated 使用 PluginToolsAPI */
export type PluginActionsAPI = PluginToolsAPI;

/**
 * PluginContext — 每个插件 activate() 时收到的运行上下文
 * 
 * 提供：
 * - storage: 插件专属持久化存储
 * - events: 全局事件总线
 * - connectors: 连接器注册中心（只读访问）
 * - ui: UI 扩展 API
 * - createCliConnector: 创建指定 cwd 的 kiro-cli 连接器实例
 * - tools: Tool 注册与调用
 */
export interface PluginContext {
  /** 插件专属存储 */
  storage: PluginStorage;
  /** 全局事件总线 */
  events: typeof eventBus;
  /** 连接器注册中心 */
  connectors: typeof connectorRegistry;
  /** UI 扩展 */
  ui: UIExtensionAPI;
  /** 创建 kiro-cli 连接器实例（指定工作目录，用于 LLM 调用） */
  createCliConnector(options: { id: string; cwd: string }): KiroCliConnector;
  /** Tool 注册与调用（让 LLM 和其他插件调用你的能力） */
  tools: PluginToolsAPI;
  /** @deprecated 使用 tools */
  actions: PluginToolsAPI;
}

// 通知回调（由 App 层设置）
let notificationHandler: ((message: string, type: "info" | "success" | "error") => void) | null = null;

export function setNotificationHandler(handler: typeof notificationHandler): void {
  notificationHandler = handler;
}

/**
 * 为指定插件创建 PluginContext
 */
export function createPluginContext(pluginId: string): PluginContext {
  const storage = new PluginStorage(pluginId);

  const ui: UIExtensionAPI = {
    registerSidebarItem(_item: SidebarItem) {
      // 动态注册（目前通过 Plugin.sidebarItems 声明式注册，这里留作运行时扩展）
      console.warn(`[Plugin:${pluginId}] runtime registerSidebarItem not yet supported, use declarative sidebarItems`);
    },
    registerSettingsSection(_section: SettingsSection) {
      console.warn(`[Plugin:${pluginId}] runtime registerSettingsSection not yet supported, use declarative settingsSections`);
    },
    showNotification(message: string, type: "info" | "success" | "error" = "info") {
      if (notificationHandler) {
        notificationHandler(message, type);
      } else {
        console.log(`[Notification:${type}] ${message}`);
      }
    },
  };

  const actions: PluginToolsAPI = {
    register(name, handler, meta) {
      toolRegistry.register(name, handler, {
        pluginId,
        description: meta?.description || name,
        params: meta?.params,
        returns: meta?.returns,
        category: meta?.category || pluginId,
      });
    },
    unregister(name) {
      toolRegistry.unregister(name);
    },
    call(name, params) {
      return toolRegistry.call(name, params);
    },
    list() {
      return toolRegistry.list().map(m => ({ name: m.name, description: m.description }));
    },
  };

  return {
    storage,
    events: eventBus,
    connectors: connectorRegistry,
    ui,
    createCliConnector(options: { id: string; cwd: string }) {
      const connector = new KiroCliConnector({ id: options.id, cwd: options.cwd, internal: true });
      // 注册到 registry，确保 HMR/退出时 disposeAllConnectors() 能清理它
      connectorRegistry.register(connector);
      return connector;
    },
    actions,
    tools: actions,
  };
}
