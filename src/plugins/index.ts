export type { Plugin, SidebarItem, SettingsSection, PluginPage, PluginManifest, RuntimePluginExports, HostModules } from "./types";
export type { PluginContext, UIExtensionAPI } from "./context";
export { createPluginContext, setNotificationHandler } from "./context";
export { pluginRegistry } from "./registry";
export { loadPlugins, enablePlugin, disablePlugin, isPluginEnabled, getAvailablePlugins, reloadExternalPlugins } from "./loader";

// memory 插件已作为核心能力内置到 Settings，不再通过插件系统注册
