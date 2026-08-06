// ===== 企业微信机器人连接器 =====
//
// 管理企微机器人的 WebSocket 连接生命周期。
// 注意：此连接器不直接处理 AI 对话，而是作为消息入口，
// 收到的消息会通过 Tauri event 转发给前端，由当前活跃的 AI 连接器处理。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_WECOM_POLICY, parseWecomPolicy } from "../../core/wecomPolicy";
import type { Connector, ConnectorConfig, ConnectorCapabilities, SendOptions, SendResult } from "../base";

export type WeComBotStatus = "disconnected" | "connecting" | "connected" | "error";

export class WeComBotConnector implements Connector {
  readonly config: ConnectorConfig;
  readonly capabilities: ConnectorCapabilities = {
    nativeSession: false,
    needsHistory: false,
    supportsModelSwitch: false,
    needsMemorySupplement: false,
  };

  private _status: WeComBotStatus = "disconnected";
  private _statusMessage = "";
  private _statusListenerCleanup: (() => void) | null = null;
  private _onStatusChange: ((status: WeComBotStatus, message?: string) => void) | null = null;

  constructor(config?: Partial<ConnectorConfig>) {
    this.config = {
      id: config?.id || "wecom-bot",
      name: config?.name || "企微机器人",
      type: "bot",
      icon: config?.icon || "",
      description: config?.description || "企业微信智能机器人",
      enabled: config?.enabled ?? true,
      botPlatform: config?.botPlatform || "wecom",
      botId: config?.botId || "",
      botSecret: config?.botSecret || "",
      botName: config?.botName || "",
      autoConnect: config?.autoConnect ?? true,
      wecomPolicy: config?.wecomPolicy ? parseWecomPolicy(config.wecomPolicy) : { ...DEFAULT_WECOM_POLICY },
    };

    // 启动状态监听
    this.initStatusListener();
  }

  private async initStatusListener(): Promise<void> {
    try {
      const unlisten = await listen<{ status: string; message?: string }>("wecom-status", (event) => {
        this._status = event.payload.status as WeComBotStatus;
        this._statusMessage = event.payload.message || "";
        this._onStatusChange?.(this._status, this._statusMessage);
      });
      this._statusListenerCleanup = unlisten;
    } catch {
      // 非 Tauri 环境下忽略
    }
  }

  /** 注册状态变更回调 */
  onStatusChange(cb: (status: WeComBotStatus, message?: string) => void): void {
    this._onStatusChange = cb;
  }

  /** 获取当前连接状态 */
  get status(): WeComBotStatus {
    return this._status;
  }

  /** 获取状态消息 */
  get statusMessage(): string {
    return this._statusMessage;
  }

  /** 检测连接是否正常 */
  async healthCheck(): Promise<boolean> {
    if (!this.config.botId || !this.config.botSecret) return false;
    try {
      const status = await invoke<string>("get_wecom_status");
      console.log('[WeCom healthCheck] get_wecom_status returned:', status);
      this._status = status as WeComBotStatus;
      // connected 或 connecting 都算可用（connecting 说明正在重连中）
      return status === "connected" || status === "connecting";
    } catch (e) {
      console.error('[WeCom healthCheck] error:', e);
      return false;
    }
  }

  /** 启动企微机器人连接 */
  async connect(): Promise<void> {
    if (!this.config.botId || !this.config.botSecret) {
      throw new Error("缺少 Bot ID 或 Secret");
    }
    await invoke("start_wecom_bot", {
      botId: this.config.botId,
      secret: this.config.botSecret,
    });
  }

  /** 断开企微机器人连接 */
  async disconnect(): Promise<void> {
    await invoke("stop_wecom_bot");
  }

  /** 回复企微消息 */
  async replyMessage(requestId: string, content: string, responseUrl?: string): Promise<void> {
    await invoke("reply_wecom_message", {
      requestId,
      content,
      responseUrl: responseUrl || null,
    });
  }

  /**
   * send 方法 — Bot 连接器不直接处理 AI 对话。
   * 如果调用此方法，它会将消息作为主动推送发送到企微。
   */
  async send(
    _input: string,
    _options: SendOptions,
    onChunk: (content: string) => void,
    _onMeta?: (meta: import("../base").StreamMeta) => void,
  ): Promise<SendResult> {
    // Bot 连接器的 send 用于主动推送消息（暂不实现复杂逻辑）
    const msg = `[Bot 连接器] 暂不支持直接发送消息，请使用 AI 连接器处理对话。`;
    onChunk(msg);
    return { content: msg };
  }

  abort(): void {
    // Bot 连接器无需 abort
  }

  /** 更新配置并持久化 */
  async updateConfig(patch: Partial<ConnectorConfig>): Promise<void> {
    Object.assign(this.config, patch);
    await this.persistConfig();
  }

  /** 持久化配置到 app-storage */
  async persistConfig(): Promise<void> {
    try {
      const existing = await invoke<string>("get_app_storage");
      const data = JSON.parse(existing || "{}");
      data.wecom_bot_id = this.config.botId;
      data.wecom_secret = this.config.botSecret;
      data.wecom_bot_name = this.config.botName;
      data.wecom_auto_connect = this.config.autoConnect;
      data.wecom_policy = this.config.wecomPolicy || DEFAULT_WECOM_POLICY;
      await invoke("save_app_storage", { data: JSON.stringify(data) });
    } catch (e) {
      console.error("[WeComBot] 持久化配置失败:", e);
    }
  }

  /** 从 app-storage 加载已保存的配置 */
  async loadPersistedConfig(): Promise<void> {
    try {
      const existing = await invoke<string>("get_app_storage");
      const data = JSON.parse(existing || "{}");
      if (data.wecom_bot_id) (this.config as any).botId = data.wecom_bot_id;
      if (data.wecom_secret) (this.config as any).botSecret = data.wecom_secret;
      if (data.wecom_bot_name) (this.config as any).botName = data.wecom_bot_name;
      if (data.wecom_auto_connect !== undefined) (this.config as any).autoConnect = data.wecom_auto_connect;
      // 策略缺失时保持默认（所有人可用 + 四类高危全拦），不因旧存储放开权限
      (this.config as any).wecomPolicy = parseWecomPolicy(data.wecom_policy);
    } catch {
      // 忽略
    }
  }

  /** 销毁监听器 */
  destroy(): void {
    this._statusListenerCleanup?.();
    this._statusListenerCleanup = null;
    this._onStatusChange = null;
  }
}
