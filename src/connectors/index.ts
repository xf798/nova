export type { Connector, ConnectorConfig, ConnectorCapabilities, ConnectorType, BotPlatform, SendOptions, SendResult, HistoryMessage, ModelInfo, TokenUsage, StreamMeta, StreamToolCall } from "./base";
export { connectorRegistry, initBuiltinConnectors, disposeAllConnectors } from "./registry";
export { KiroCliConnector } from "./builtin/kiro-cli";
export { OpenAIConnector } from "./builtin/openai-api";
export { WeComBotConnector } from "./builtin/wecom-bot";
export { connectorInstances } from "./instance-manager";
export { persistApiConnectors, removePersistedApiConnector } from "./api-storage";
export type { ProcessPoolStats } from "./instance-manager";
