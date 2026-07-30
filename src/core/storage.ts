// ===== 存储服务 =====

import { invoke } from "@tauri-apps/api/core";

/**
 * 插件专属存储 — 每个插件拥有隔离的命名空间
 * 
 * 数据持久化到 ~/.nova/plugin-data/{pluginId}.json
 */
export class PluginStorage {
  private pluginId: string;
  private cache: Record<string, any> = {};
  private loaded = false;

  constructor(pluginId: string) {
    this.pluginId = pluginId;
  }

  /** 加载插件数据（惰性，首次 get/set 时自动调用） */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await invoke<string>("get_plugin_data", { pluginId: this.pluginId });
      this.cache = data ? JSON.parse(data) : {};
    } catch {
      this.cache = {};
    }
    this.loaded = true;
  }

  /** 读取值 */
  async get<T = any>(key: string, defaultValue?: T): Promise<T | undefined> {
    await this.ensureLoaded();
    const value = this.cache[key];
    return value !== undefined ? value : defaultValue;
  }

  /** 写入值 */
  async set(key: string, value: any): Promise<void> {
    await this.ensureLoaded();
    this.cache[key] = value;
    await this.persist();
  }

  /** 删除值 */
  async remove(key: string): Promise<void> {
    await this.ensureLoaded();
    delete this.cache[key];
    await this.persist();
  }

  /** 获取所有键 */
  async keys(): Promise<string[]> {
    await this.ensureLoaded();
    return Object.keys(this.cache);
  }

  /** 清空插件所有数据 */
  async clear(): Promise<void> {
    this.cache = {};
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await invoke("save_plugin_data", {
        pluginId: this.pluginId,
        data: JSON.stringify(this.cache),
      });
    } catch (e) {
      console.error(`[PluginStorage:${this.pluginId}] persist failed:`, e);
    }
  }
}

/**
 * 全局存储服务 — 管理核心配置和通用状态
 * 按命名空间隔离：core.*, connector.*, ui.*
 */
export class StorageService {
  private static instance: StorageService;
  private cache: Record<string, any> = {};
  private loaded = false;

  static getInstance(): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService();
    }
    return StorageService.instance;
  }

  async get<T = any>(namespace: string, key: string, defaultValue?: T): Promise<T | undefined> {
    await this.ensureLoaded();
    const ns = this.cache[namespace] || {};
    const value = ns[key];
    return value !== undefined ? value : defaultValue;
  }

  async set(namespace: string, key: string, value: any): Promise<void> {
    await this.ensureLoaded();
    if (!this.cache[namespace]) this.cache[namespace] = {};
    this.cache[namespace][key] = value;
    await this.persist();
  }

  /** 重置缓存标志，下次 get/set 时会重新从磁盘加载（用于外部脚本修改文件后同步） */
  invalidate(): void {
    this.loaded = false;
    this.cache = {};
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await invoke<string>("get_app_storage");
      this.cache = data ? JSON.parse(data) : {};
    } catch {
      this.cache = {};
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    try {
      await invoke("save_app_storage", { data: JSON.stringify(this.cache) });
    } catch (e) {
      console.error("[StorageService] persist failed:", e);
    }
  }
}
