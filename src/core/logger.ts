// ===== Nova 统一日志工具 =====
//
// 为 Nova 关键链路提供统一的日志格式，方便排查问题。
// 日志同时输出到 console 和后端 debug_log（Tauri stdout）。
//
// 使用方式：
//   import { logger } from "../core/logger";
//   logger.init("模块初始化完成", { connector: "kiro-cli" });
//   logger.memory("智能回忆命中 3 条记忆");
//   logger.send("sendMessage 开始", { input: "..." });

import { invoke } from "@tauri-apps/api/core";

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

/** 日志模块标识 */
type LogModule =
  | "INIT"       // 初始化加载
  | "RESTORE"    // 恢复（chat history、session/load）
  | "MEMORY"     // 记忆（回忆、提取、存储）
  | "SEND"       // 消息发送链路
  | "ACP"        // ACP 进程管理
  | "SKILL"      // Skill 加载
  | "PLUGIN"     // 插件加载
  | "CONNECTOR"  // 连接器注册/销毁
  | "IDLE_KILL"  // 闲置 kill
  | "EXTRACT";   // 记忆提取

const MODULE_EMOJI: Record<LogModule, string> = {
  INIT: "🚀",
  RESTORE: "🔄",
  MEMORY: "🧠",
  SEND: "📤",
  ACP: "⚡",
  SKILL: "🎯",
  PLUGIN: "🔌",
  CONNECTOR: "🔗",
  IDLE_KILL: "⏰",
  EXTRACT: "💡",
};

class NovaLogger {
  private enabled = true;

  /** 后端 debug_log 输出 */
  private async backendLog(msg: string): Promise<void> {
    try {
      await invoke("debug_log", { msg });
    } catch {
      // Tauri 未就绪时静默忽略
    }
  }

  /** 核心日志方法 */
  private log(level: LogLevel, module: LogModule, message: string, data?: Record<string, any>): void {
    if (!this.enabled) return;

    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const emoji = MODULE_EMOJI[module];
    const prefix = `[${ts}] ${emoji} [${module}]`;
    const dataStr = data ? ` | ${JSON.stringify(data)}` : "";
    const fullMsg = `${prefix} ${message}${dataStr}`;

    // Console 输出（带颜色）
    switch (level) {
      case "ERROR":
        console.error(fullMsg);
        break;
      case "WARN":
        console.warn(fullMsg);
        break;
      case "DEBUG":
        console.debug(fullMsg);
        break;
      default:
        console.log(fullMsg);
    }

    // 后端输出（用于 Tauri 日志捕获）
    this.backendLog(`${emoji} [${module}] ${message}${dataStr}`);
  }

  // ─── 模块级快捷方法 ───

  /** 初始化加载日志 */
  init(message: string, data?: Record<string, any>): void {
    this.log("INFO", "INIT", message, data);
  }

  /** 恢复（聊天历史、session）日志 */
  restore(message: string, data?: Record<string, any>): void {
    this.log("INFO", "RESTORE", message, data);
  }

  /** 记忆相关日志 */
  memory(message: string, data?: Record<string, any>): void {
    this.log("INFO", "MEMORY", message, data);
  }

  /** 消息发送日志 */
  send(message: string, data?: Record<string, any>): void {
    this.log("INFO", "SEND", message, data);
  }

  /** ACP 进程管理日志 */
  acp(message: string, data?: Record<string, any>): void {
    this.log("INFO", "ACP", message, data);
  }

  /** Skill 加载日志 */
  skill(message: string, data?: Record<string, any>): void {
    this.log("INFO", "SKILL", message, data);
  }

  /** 插件加载日志 */
  plugin(message: string, data?: Record<string, any>): void {
    this.log("INFO", "PLUGIN", message, data);
  }

  /** 连接器日志 */
  connector(message: string, data?: Record<string, any>): void {
    this.log("INFO", "CONNECTOR", message, data);
  }

  /** 闲置 Kill 日志 */
  idleKill(message: string, data?: Record<string, any>): void {
    this.log("WARN", "IDLE_KILL", message, data);
  }

  /** 记忆提取日志 */
  extract(message: string, data?: Record<string, any>): void {
    this.log("INFO", "EXTRACT", message, data);
  }

  /** 通用 warn */
  warn(module: LogModule, message: string, data?: Record<string, any>): void {
    this.log("WARN", module, message, data);
  }

  /** 通用 error */
  error(module: LogModule, message: string, data?: Record<string, any>): void {
    this.log("ERROR", module, message, data);
  }

  /** 启用/禁用日志 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

/** 全局单例 */
export const logger = new NovaLogger();
