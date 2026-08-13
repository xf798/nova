import type { ConnectorConfig } from "./base";
import { StorageService } from "../core/storage";

const NAMESPACE = "connectors";
const STORAGE_KEY = "cli";

export interface PersistedCliConnector {
  id: string;
  name: string;
  command?: string;
  defaultArgs?: string[];
  cwd?: string;
  description?: string;
  icon?: string;
  enabled: boolean;
}

let cachedConfigs: PersistedCliConnector[] = [];

export function normalizeCliConnectorConfigs(raw: unknown): PersistedCliConnector[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(item => item && typeof item === "object")
    .map(item => item as Partial<PersistedCliConnector>)
    .filter(item => typeof item.id === "string" && item.id.trim() && typeof item.name === "string")
    .map(item => ({
      id: item.id!.trim(),
      name: item.name!.trim(),
      command: typeof item.command === "string" ? item.command.trim() : undefined,
      defaultArgs: Array.isArray(item.defaultArgs) ? item.defaultArgs.map(String) : undefined,
      cwd: typeof item.cwd === "string" && item.cwd.trim() ? item.cwd.trim() : undefined,
      description: typeof item.description === "string" ? item.description : undefined,
      icon: typeof item.icon === "string" ? item.icon : undefined,
      enabled: item.enabled !== false,
    }));
}

export async function loadCliConnectorConfigs(): Promise<PersistedCliConnector[]> {
  const raw = await StorageService.getInstance().get<unknown>(NAMESPACE, STORAGE_KEY, []);
  cachedConfigs = normalizeCliConnectorConfigs(raw);
  return cachedConfigs.map(config => ({ ...config, defaultArgs: config.defaultArgs ? [...config.defaultArgs] : undefined }));
}

export async function persistCliConnectorConfigs(configs: ConnectorConfig[]): Promise<void> {
  cachedConfigs = configs
    .filter(config => config.type === "cli" && !config.internal)
    .map(config => ({
      id: config.id,
      name: config.name,
      command: config.command?.trim() || undefined,
      defaultArgs: config.defaultArgs ? [...config.defaultArgs] : undefined,
      cwd: config.cwd?.trim() || undefined,
      description: config.description,
      icon: config.icon,
      enabled: config.enabled,
    }));
  await StorageService.getInstance().set(NAMESPACE, STORAGE_KEY, cachedConfigs);
}

/** 供标题、记忆、蒸馏等临时实例继承内置 Kiro CLI 的用户配置。 */
export function getDefaultCliConnectorConfig(): Partial<ConnectorConfig> {
  const config = cachedConfigs.find(item => item.id === "kiro-cli");
  return config ? { ...config, type: "cli", defaultArgs: config.defaultArgs ? [...config.defaultArgs] : undefined } : {};
}
