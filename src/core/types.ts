// ===== 核心类型定义 =====

import type { TokenUsage, StreamMeta } from "../connectors/base";
import type { SessionMemory } from "./memory";

// 引用消息
export interface QuotedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

/** 召回明细（可观测）：本次发送注入的记忆/技能 */
export interface RecallInfo {
  memories: {
    content: string;
    category: string;
    distilled: boolean;
    score: number;
  }[];
  skills: {
    name: string;
    displayName: string;
    /** 来源：常驻 / 路径匹配 / 语义召回 */
    source: "always" | "path" | "query";
    distilled: boolean;
    score?: number;
  }[];
  /** 对 kiro-cli 等原生加载连接器，召回为 Nova 预估（非实际注入） */
  estimated?: boolean;
}

// 消息
export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  connectorId?: string;
  attachments?: string[];
  usage?: TokenUsage;
  /** 结构化 metadata（toolcall/thought），独立于 content 存储 */
  meta?: StreamMeta;
  /** 被引用的历史消息 */
  quotedMessage?: QuotedMessage;
  /** 召回明细（可观测：本次注入的记忆/技能） */
  recall?: RecallInfo;
}

// 会话
export interface ChatSession {
  id: string;
  title: string;
  connectorId: string;         // 使用的连接器 ID
  connectorSessionId: string | null;  // 连接器内部的 session ID
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  /** 会话记忆状态（摘要等） */
  memory?: SessionMemory;
  /** 是否置顶 */
  pinned?: boolean;
  /** Per-session 模型选择（覆盖连接器默认模型） */
  modelId?: string;
}

// Re-export core services
export { eventBus } from "./events";
export { PluginStorage, StorageService } from "./storage";
