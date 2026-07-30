// ===== 连接器注册中心 =====

import type { Connector, ConnectorConfig } from "./base";
import { KiroCliConnector } from "./builtin/kiro-cli";
import { WeComBotConnector } from "./builtin/wecom-bot";
import { connectorInstances } from "./instance-manager";
import { loadPersistedApiConnectors } from "./api-storage";

class ConnectorRegistry {
  private connectors: Map<string, Connector> = new Map();

  /** 注册连接器 */
  register(connector: Connector): void {
    console.log(`[Nova:Registry] register: id=${connector.config.id}, name=${connector.config.name}`);
    this.connectors.set(connector.config.id, connector);
  }

  /** 注销连接器 */
  unregister(id: string): void {
    this.connectors.delete(id);
  }

  /** 获取连接器 */
  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  /** 获取所有已注册的连接器 */
  getAll(): Connector[] {
    return Array.from(this.connectors.values());
  }

  /** 获取所有启用的连接器 */
  getEnabled(): Connector[] {
    return this.getAll().filter(c => c.config.enabled);
  }

  /** 获取连接器配置列表 */
  getConfigs(): ConnectorConfig[] {
    return this.getAll().map(c => c.config);
  }

  /** 获取指定类型的连接器 */
  getByType(type: string): Connector[] {
    return this.getAll().filter(c => c.config.type === type);
  }

  /** 获取 bot 类型连接器（类型收窄） */
  getBotConnectors(): WeComBotConnector[] {
    return this.getByType("bot") as WeComBotConnector[];
  }
}

// 单例
export const connectorRegistry = new ConnectorRegistry();

// 注册内置连接器
export async function initBuiltinConnectors(): Promise<void> {
  console.log(`[Nova:Registry] initBuiltinConnectors: 开始`);
  connectorRegistry.register(new KiroCliConnector());

  // 注册企微机器人连接器（从持久化配置加载）
  const wecomBot = new WeComBotConnector();
  await wecomBot.loadPersistedConfig();
  connectorRegistry.register(wecomBot);

  // 加载用户自定义的 API 连接器
  await loadPersistedApiConnectors();

  console.log(`[Nova:Registry] initBuiltinConnectors: 完成`);
}

/** 释放所有连接器持有的子进程资源 */
export async function disposeAllConnectors(): Promise<void> {
  console.log(`[Nova:Registry] disposeAllConnectors: 开始`);
  // 清理实例管理器中的会话级实例
  await connectorInstances.disposeAll();
  // 清理注册中心中的连接器（模板实例 + pipeline 实例等）
  const tasks = connectorRegistry.getAll()
    .filter(c => c.dispose)
    .map(c => c.dispose!().catch(err => {
      console.warn(`[Registry] dispose ${c.config.id} 失败:`, err);
    }));
  await Promise.all(tasks);
  console.log(`[Nova:Registry] disposeAllConnectors: 完成`);
}

// ─── HMR 热更新时自动清理旧进程 ───
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    console.log("[Registry] HMR dispose: 清理所有 connector 子进程");
    disposeAllConnectors();
  });
}
