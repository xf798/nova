// ===== API 连接器持久化存储 =====
//
// 将用户自定义的 API 连接器配置独立存储到 ~/.nova/data/connectors.json，
// 启动时自动加载并注册到 connectorRegistry。

import { invoke } from "@tauri-apps/api/core";
import { OpenAIConnector } from "./builtin/openai-api";
import { connectorRegistry } from "./registry";

/** 持久化存储的 API 连接器配置（不含运行时状态） */
interface PersistedApiConnector {
  id: string;
  name: string;
  type: "api";
  apiEndpoint: string;
  apiKey: string;
  model: string;
  description?: string;
  icon?: string;
}

/**
 * 从 ~/.nova/data/connectors.json 加载所有已保存的 API 连接器并注册到 registry。
 * 应在 initBuiltinConnectors 中调用。
 */
export async function loadPersistedApiConnectors(): Promise<void> {
  try {
    const raw = await invoke<string>("read_connectors_file");
    const configs: PersistedApiConnector[] = JSON.parse(raw || "[]");

    for (const cfg of configs) {
      // 避免重复注册
      if (connectorRegistry.get(cfg.id)) continue;

      const connector = new OpenAIConnector({
        id: cfg.id,
        name: cfg.name,
        apiEndpoint: cfg.apiEndpoint,
        apiKey: cfg.apiKey,
        model: cfg.model,
        description: cfg.description,
        icon: cfg.icon,
        enabled: true,
      });
      connectorRegistry.register(connector);
      console.log(`[ApiStorage] 加载已保存的 API 连接器: ${cfg.name} (${cfg.id})`);
    }

    if (configs.length > 0) {
      console.log(`[ApiStorage] 共加载 ${configs.length} 个 API 连接器`);
    }
  } catch (e) {
    console.error("[ApiStorage] 加载 API 连接器失败:", e);
  }
}

/**
 * 保存当前所有 API 连接器配置到 ~/.nova/data/connectors.json。
 * 在添加、编辑、删除 API 连接器后调用。
 */
export async function persistApiConnectors(): Promise<void> {
  try {
    // 收集 registry 中所有 API 类型连接器（排除 internal 的）
    const apiConnectors = connectorRegistry.getAll()
      .filter(c => c.config.type === "api" && !c.config.internal);

    const configs: PersistedApiConnector[] = apiConnectors.map(c => ({
      id: c.config.id,
      name: c.config.name,
      type: "api" as const,
      apiEndpoint: c.config.apiEndpoint || "",
      apiKey: c.config.apiKey || "",
      model: c.config.model || "",
      description: c.config.description,
      icon: c.config.icon,
    }));

    await invoke("write_connectors_file", { data: JSON.stringify(configs, null, 2) });
    console.log(`[ApiStorage] 已保存 ${configs.length} 个 API 连接器到 connectors.json`);
  } catch (e) {
    console.error("[ApiStorage] 持久化 API 连接器失败:", e);
  }
}

/**
 * 从持久化中移除指定 ID 的 API 连接器。
 */
export async function removePersistedApiConnector(id: string): Promise<void> {
  try {
    const raw = await invoke<string>("read_connectors_file");
    const configs: PersistedApiConnector[] = JSON.parse(raw || "[]");
    const filtered = configs.filter(c => c.id !== id);
    await invoke("write_connectors_file", { data: JSON.stringify(filtered, null, 2) });
    console.log(`[ApiStorage] 已移除 API 连接器: ${id}`);
  } catch (e) {
    console.error("[ApiStorage] 移除 API 连接器失败:", e);
  }
}
