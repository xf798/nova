// ===== Kiro CLI 连接器 (ACP 模式) =====
// 使用 Agent Client Protocol (JSON-RPC over stdio) 与 kiro-cli 通信
// 参考: https://kiro.dev/docs/cli/acp/

import { Command } from "@tauri-apps/plugin-shell";
import type { Connector, ConnectorConfig, ConnectorCapabilities, SendOptions, SendResult, ModelInfo, HistoryMessage, TokenUsage, StreamMeta } from "../base";
import { TimelineBuilder } from "../timeline";
import { logger } from "../../core/logger";

// ─── 本地文件日志（追加写入 ~/.nova/logs/acp-session.log）───
const ACP_LOG_FILE = "/Users/wangxf/.nova/logs/acp-session.log";

// ─── 多实例模式 ───
// 每个 KiroCliConnector 实例拥有独立的 ACP 进程和 session，
// 不再使用模块级变量做进程交接。HMR 时直接 kill 重建。

async function fileLog(message: string): Promise<void> {
  const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const line = `[${timestamp}] ${message}`;
  try {
    const escaped = line.replace(/'/g, "'\\''");
    const cmd = Command.create("sh", [
      "-c",
      `mkdir -p "$(dirname '${ACP_LOG_FILE}')" && printf '%s\\n' '${escaped}' >> '${ACP_LOG_FILE}'`,
    ]);
    await cmd.execute();
  } catch {
    // 日志写入失败不影响主流程
  }
}

/**
 * ACP 流式 chunk 的事件名判定。
 *
 * 名字必须和 Agent 实际发送的一致，写错了不会报错、只会静默丢内容：
 * 思考内容曾因为匹配 thought_message_chunk（从文档猜的名字）而全部丢失，
 * 实际 kiro-cli 发的是 agent_thought_chunk。导出供测试固定真实名字。
 *
 * 大小写两种写法都留着：不同引擎版本出现过 snake_case 与 PascalCase 混用。
 */
export function isThoughtChunk(type: string): boolean {
  return (
    type === "agent_thought_chunk" || type === "AgentThoughtChunk" ||
    // 早期从文档里读到的名字，实际未观测到，留作兼容
    type === "thought_message_chunk" || type === "ThoughtMessageChunk"
  );
}

export function isTextChunk(type: string): boolean {
  return type === "agent_message_chunk" || type === "AgentMessageChunk";
}

/**
 * 高频流式 chunk 不写文件日志。
 *
 * fileLog 每行 spawn 一个 sh 进程，正文和思考都是逐 token 推送的，
 * 一次长任务能有十几万条。这些内容本身已经进 timeline 和消息正文，
 * 日志里再存一份只是把磁盘和进程数吃掉。
 */
export function isHighFrequencyChunk(type: string): boolean {
  return isTextChunk(type) || isThoughtChunk(type);
}

/** ACP JSON-RPC 请求 */
interface AcpRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, any>;
}

/** ACP JSON-RPC 通知（无 id） */
interface AcpNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, any>;
}

/** ACP JSON-RPC 响应 */
interface AcpResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

type AcpMessage = AcpRequest | AcpNotification | AcpResponse;

interface AcpTextContent {
  type: "text";
  text: string;
}

// ─── ACP v1 Agent Capabilities（initialize 返回） ───

/** Agent 在 initialize response 中声明的能力 */
export interface AgentCapabilities {
  /** 是否支持 session/load（恢复历史会话并重放消息） */
  loadSession?: boolean;
  /** Session 生命周期能力 */
  sessionCapabilities?: {
    /** 支持 session/resume（无重放恢复） */
    resume?: Record<string, unknown>;
    /** 支持 session/close（优雅关闭） */
    close?: Record<string, unknown>;
    /** 支持 additionalDirectories */
    additionalDirectories?: Record<string, unknown>;
  };
  /** MCP 传输能力 */
  mcpCapabilities?: {
    http?: boolean;
    sse?: boolean;
  };
  /** 认证能力 */
  auth?: {
    logout?: boolean;
  };
  /** 其他扩展字段 */
  [key: string]: unknown;
}

// ─── ACP v1 标准 Tool Call 类型 ───

/** 工具调用类别 — 影响 UI 图标展示 */
export type ToolKind =
  | "read" | "edit" | "delete" | "move"
  | "search" | "execute" | "think" | "fetch" | "other";

/** 工具调用执行状态 */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** Tool Call Content — diff 类型 */
export interface ToolCallDiffContent {
  type: "diff";
  path: string;
  oldText?: string;
  newText: string;
}

/** Tool Call Content — 普通内容 */
export interface ToolCallRegularContent {
  type: "content";
  content: AcpTextContent;
}

/** Tool Call Content — terminal */
export interface ToolCallTerminalContent {
  type: "terminal";
  terminalId: string;
}

export type ToolCallContent = ToolCallDiffContent | ToolCallRegularContent | ToolCallTerminalContent;

/** 文件位置（follow-the-agent） */
export interface ToolCallLocation {
  path: string;
  line?: number;
}

/** 标准化的 Tool Call 信息（用于 UI 展示） */
export interface AcpToolCall {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  startedAt: number;
  completedAt?: number;
}

// ─── MCP Server 配置 ───

/** MCP Server stdio 传输配置 */
export interface McpServerStdioConfig {
  name: string;
  command: string;
  args: string[];
  env?: { name: string; value: string }[];
}

/** MCP Server HTTP 传输配置 */
export interface McpServerHttpConfig {
  type: "http";
  name: string;
  url: string;
  headers?: { name: string; value: string }[];
}

/** MCP Server 配置（联合类型） */
export type McpServerConfig = McpServerStdioConfig | McpServerHttpConfig;

/**
 * 将内部 McpServerConfig[] 转换为 kiro-cli ACP session 可用的格式。
 * 
 * ⚠️ 已知限制（kiro-cli 2.13-2.14 bug）：
 * ACP session/new 的 mcpServers 数组参数完全无法接受非空值。
 * 无论传入何种格式（数组/Object map、stdio/http），kiro-cli 都会 crash（exit 0）。
 * 错误信息：
 *   - Array: "data did not match any variant of untagged enum McpServer"
 *   - Object: "invalid type: map, expected a sequence"
 * 
 * 当前策略：始终传空数组，通过以下替代方案注入 MCP：
 * 1. 写入 ~/.nova/mcp-session.json 配置文件（动态端口），由 kiro-cli 自动加载
 * 2. 等 kiro-cli 修复此 bug 后再恢复传参方式
 */
function mcpServersForAcp(_servers: McpServerConfig[]): any[] {
  // kiro-cli bug: session/new mcpServers 不接受非空数组
  // 改用 mcp.json 配置文件方式注入
  return [];
}

// ─── Terminal 实例管理 ───

/** 终端退出状态 */
interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

/** 活跃终端实例 */
interface TerminalInstance {
  id: string;
  output: string;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  outputByteLimit: number;
  process: any;  // Tauri ChildProcess
  waitResolvers: ((status: TerminalExitStatus) => void)[];
}

/** ACP session/update 的 update 载荷（兼容 v2 引擎的字段差异） */
interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: AcpTextContent | ToolCallContent[];
  messageId?: string | null;
  // 标准 tool_call / tool_call_update 字段
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  // v2 引擎兼容字段（非标准，但 kiro-cli 可能发送）
  toolName?: string;
  name?: string;
  tool_name?: string;
  tool_call_id?: string;
  tool_kind?: string;
  toolCall?: { name?: string };
  tool?: { name?: string };
  state?: string;
  parameters?: unknown;
}

/**
 * 流式 Markdown 可能暂时只有代码围栏开头。为当前渲染帧补一个临时闭合围栏，
 * 避免 ReactMarkdown 把尚未接收完的代码误渲染成普通段落；原始累积内容不变。
 */
export function stabilizeStreamingMarkdown(markdown: string): string {
  let openFence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of markdown.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;

    const fence = match[1];
    const marker = fence[0] as "`" | "~";
    const suffix = match[2];

    if (!openFence) {
      // 反引号围栏的信息字符串中不能包含反引号。
      if (marker === "`" && suffix.includes("`")) continue;
      openFence = { marker, length: fence.length };
      continue;
    }

    if (
      marker === openFence.marker &&
      fence.length >= openFence.length &&
      suffix.trim() === ""
    ) {
      openFence = null;
    }
  }

  if (!openFence) return markdown;
  const newline = markdown.endsWith("\n") ? "" : "\n";
  return `${markdown}${newline}${openFence.marker.repeat(openFence.length)}`;
}



/** 闲置超时时间（毫秒）— 超过此时间未使用则自动 kill ACP 进程，释放资源 */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

export class KiroCliConnector implements Connector {
  readonly config: ConnectorConfig;
  readonly capabilities: ConnectorCapabilities = {
    nativeSession: true,
    needsHistory: false,
    supportsModelSwitch: true, // 通过 session/set_model 切换
    needsMemorySupplement: true,
  };
  private acpProcess: any = null;
  private abortResolve: (() => void) | null = null;
  private nextId: number = 1;
  private sessionId: string | null = null;
  private initialized: boolean = false;
  private buffer: string = "";
  private pendingRequests: Map<number, { resolve: (msg: any) => void; reject: (err: Error) => void }> = new Map();
  private notificationHandler: ((update: AcpSessionUpdate) => void) | null = null;
  currentModel: string = "auto";
  /** 并发初始化锁 — 确保多个 send() 共享同一个 ensureAcpProcess 过程 */
  private initPromise: Promise<void> | null = null;
  /** 闲置 kill 定时器 */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Agent 能力声明（initialize 后填充） */
  private agentCapabilities: AgentCapabilities | null = null;
  /** 当前活跃的 prompt request ID（用于精确取消） */
  private activePromptId: number | null = null;
  /** 活跃的终端实例（terminalId → TerminalInstance） */
  private terminals: Map<string, TerminalInstance> = new Map();
  /** 注册的 MCP Server 配置（创建 session 时传递给 agent） */
  private mcpServers: McpServerConfig[] = [];

  /** 标记当前是否正在执行闲置 kill（用于区分 close 事件是正常退出还是崩溃） */
  private isIdleKilling: boolean = false;

  /** 最后活跃时间戳（send/abort/ensureSession 时更新） */
  private _lastActiveAt: number = Date.now();

  /** 获取最后活跃时间 */
  get lastActiveAt(): number {
    return this._lastActiveAt;
  }

  /** 进程是否存活 */
  get isProcessAlive(): boolean {
    return this.acpProcess !== null && this.initialized;
  }

  /** 是否已被释放 */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** 重置闲置 kill 定时器 */
  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this._lastActiveAt = Date.now();
    this.idleTimer = setTimeout(async () => {
      if (!this.acpProcess) return;
      logger.idleKill(`实例闲置超时，优雅退出`, {
        connector: this.config.id,
        sessionId: this.sessionId,
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      });
      fileLog(`⏰ 闲置超时，优雅退出 | sessionId: ${this.sessionId}`);
      this.isIdleKilling = true;
      await this.gracefulClose();
      await this.killAcpProcess();
      this.isIdleKilling = false;
    }, IDLE_TIMEOUT_MS);
  }

  constructor(config?: Partial<ConnectorConfig>) {
    this.config = {
      id: config?.id || "kiro-cli",
      name: config?.name || "Kiro CLI",
      type: "cli",
      icon: config?.icon || "",
      command: "kiro-cli",
      defaultArgs: ["acp", "--agent-engine", "v2", "--trust-all-tools"],
      cwd: config?.cwd || "/Users/wangxf/workspace",
      description: "Kiro AI 助手",
      enabled: true,
      ...config,
    };
  }

  setModel(modelId: string): void {
    this.currentModel = modelId;
  }

  /**
   * 注册 MCP Server。下次创建 session 时会将所有注册的 server 传递给 agent。
   * 如果 session 已存在，需要调用 resetProcess() 让下次 send 重建 session 使之生效。
   */
  registerMcpServer(server: McpServerConfig): void {
    // 去重（按 name 判断）
    const existing = this.mcpServers.findIndex(s => s.name === server.name);
    if (existing >= 0) {
      this.mcpServers[existing] = server;
    } else {
      this.mcpServers.push(server);
    }
    fileLog(`[MCP] 注册 server: ${server.name} | 当前总数: ${this.mcpServers.length}`);
  }

  /**
   * 注销 MCP Server。
   */
  unregisterMcpServer(name: string): void {
    this.mcpServers = this.mcpServers.filter(s => s.name !== name);
    fileLog(`[MCP] 注销 server: ${name} | 当前总数: ${this.mcpServers.length}`);
  }

  /**
   * 获取当前注册的 MCP Server 列表。
   */
  getMcpServers(): McpServerConfig[] {
    return [...this.mcpServers];
  }

  // ─── MCP 注入到 ~/.kiro/settings/mcp.json ───

  private static readonly KIRO_MCP_CONFIG = "/Users/wangxf/.kiro/settings/mcp.json";

  /**
   * 将当前注册的 HTTP MCP servers 写入 kiro-cli 全局配置。
   * kiro-cli 启动时会自动加载此配置文件中的 MCP servers。
   * 
   * 策略：读取现有 mcp.json → 注入/更新 nova-tools 条目 → 写回。
   */
  private async injectMcpToKiroConfig(): Promise<void> {
    const httpServers = this.mcpServers.filter(s => "url" in s) as McpServerHttpConfig[];
    if (httpServers.length === 0) return;

    try {
      const configPath = KiroCliConnector.KIRO_MCP_CONFIG;
      
      // 读取现有配置
      const readCmd = Command.create("sh", ["-c", `cat "${configPath}" 2>/dev/null || echo '{}'`]);
      const readResult = await readCmd.execute();
      let config: any;
      try {
        config = JSON.parse(readResult.stdout.trim() || "{}");
      } catch {
        config = {};
      }
      if (!config.mcpServers) config.mcpServers = {};

      // 注入每个 HTTP MCP server
      let changed = false;
      for (const server of httpServers) {
        const existing = config.mcpServers[server.name];
        const newEntry: any = { url: server.url };
        // 如果已存在且 url 相同则跳过
        if (existing && existing.url === server.url && !existing.disabled) continue;
        config.mcpServers[server.name] = newEntry;
        changed = true;
      }

      if (!changed) {
        fileLog(`[MCP] mcp.json 已包含最新配置，跳过写入`);
        return;
      }

      // 写回配置
      const json = JSON.stringify(config, null, 2);
      const escaped = json.replace(/'/g, "'\\''");
      const writeCmd = Command.create("sh", ["-c", `printf '%s' '${escaped}' > "${configPath}"`]);
      await writeCmd.execute();
      fileLog(`[MCP] ✅ 已注入 ${httpServers.length} 个 MCP server 到 ${configPath}`);
    } catch (err: any) {
      fileLog(`[MCP] ⚠️ 注入 mcp.json 失败: ${err.message}`);
      // 非致命错误，不阻塞进程启动
    }
  }

  /**
   * 从 kiro-cli 全局配置中移除 Nova MCP servers（dispose 时调用）。
   */
  private async removeMcpFromKiroConfig(): Promise<void> {
    try {
      const configPath = KiroCliConnector.KIRO_MCP_CONFIG;
      const readCmd = Command.create("sh", ["-c", `cat "${configPath}" 2>/dev/null || echo '{}'`]);
      const readResult = await readCmd.execute();
      let config: any;
      try {
        config = JSON.parse(readResult.stdout.trim() || "{}");
      } catch {
        return;
      }
      if (!config.mcpServers) return;

      // 移除 Nova 注入的 servers
      let changed = false;
      for (const server of this.mcpServers) {
        if (server.name in config.mcpServers) {
          delete config.mcpServers[server.name];
          changed = true;
        }
      }

      if (!changed) return;

      const json = JSON.stringify(config, null, 2);
      const escaped = json.replace(/'/g, "'\\''");
      const writeCmd = Command.create("sh", ["-c", `printf '%s' '${escaped}' > "${configPath}"`]);
      await writeCmd.execute();
      fileLog(`[MCP] 🧹 已从 ${configPath} 移除 Nova MCP servers`);
    } catch (err: any) {
      fileLog(`[MCP] ⚠️ 移除 mcp.json 条目失败: ${err.message}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const command = Command.create("kiro-cli", ["--version"], { encoding: "utf-8" });
      let output = "";
      command.stdout.on("data", (d) => { output += d; });
      await command.spawn();
      await new Promise<void>((resolve) => {
        command.on("close", () => resolve());
        setTimeout(() => resolve(), 3000);
      });
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** 启动 ACP 进程并完成初始化握手（带并发锁） */
  private async ensureAcpProcess(): Promise<void> {
    if (this.disposed) {
      throw new Error("ACP connector disposed");
    }
    if (this.acpProcess && this.initialized) {
      console.log(`[ACP] ensureAcpProcess: 进程已存活，跳过启动`);
      return;
    }

    // 并发锁：如果已有初始化正在进行，等待它完成而不是重复启动
    if (this.initPromise) {
      console.log(`[ACP] ensureAcpProcess: 已有初始化进行中，等待...`);
      fileLog(`⏳ ensureAcpProcess 并发等待 | connector: ${this.config.id}`);
      try {
        await this.initPromise;
      } catch {
        // 如果先驱的初始化失败了，锁已释放，重新尝试
        console.warn(`[ACP] ensureAcpProcess: 并发等待的初始化失败，重新尝试`);
        fileLog(`⚠️ 并发等待的初始化失败，重新尝试 | connector: ${this.config.id}`);
      }
      // 确认状态：如果进程已就绪则直接返回，否则继续往下走
      if (this.acpProcess && this.initialized) return;
    }

    this.initPromise = this._doEnsureAcpProcess();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  /** 实际启动 ACP 进程逻辑（内部方法） */
  private async _doEnsureAcpProcess(): Promise<void> {

    console.log(`[ACP] 🚀 ensureAcpProcess: 启动新 ACP 进程 | connector: ${this.config.id}`);
    fileLog(`🚀 启动新 ACP 进程 | connector: ${this.config.id} | cwd: ${this.config.cwd}`);

    // ── 注入 Nova MCP Server 到 ~/.kiro/settings/mcp.json ──
    // kiro-cli ACP session/new mcpServers 参数有 bug（2.13-2.14 不支持非空数组），
    // 替代方案：将 Nova MCP Server 写入全局 mcp.json，kiro-cli 启动时自动加载。
    await this.injectMcpToKiroConfig();

    // 清理旧进程
    await this.killAcpProcess();

    const command = Command.create("kiro-cli", this.config.defaultArgs || ["acp", "--agent-engine", "v2"], {
      cwd: this.config.cwd,
      encoding: "utf-8",
    });

    this.buffer = "";

    command.stdout.on("data", (data: string) => {
      this.buffer += data;
      this.processBuffer();
    });

    command.stderr.on("data", (data: string) => {
      console.warn("[ACP stderr]", data);
      fileLog(`🔴 [stderr] ${data}`);
    });

    command.on("close", (data: any) => {
      const wasIdleKill = this.isIdleKilling;
      const previousSession = this.sessionId;
      const pendingCount = this.pendingRequests.size;
      const exitInfo = `code=${data?.code ?? "?"} signal=${data?.signal ?? "?"}`;

      if (wasIdleKill) {
        console.log(`[ACP] 🛏️ 进程因闲置超时正常退出 | sessionId: ${previousSession} | ${exitInfo}`);
        fileLog(`🛏️ 闲置超时正常退出 | sessionId: ${previousSession} | ${exitInfo}`);
      } else {
        console.error(`[ACP] 💀 进程异常退出！ sessionId: ${previousSession} | initialized: ${this.initialized} | pendingRequests: ${pendingCount} | ${exitInfo}`);
        fileLog(`💀 进程异常退出！ sessionId: ${previousSession} | initialized: ${this.initialized} | pendingRequests: ${pendingCount} | ${exitInfo}`);
      }

      this.acpProcess = null;
      this.initialized = false;
      this.sessionId = null;
      // 在途 prompt 随进程一起消失，标记必须一起清掉。
      // 否则 activePromptId 会一直留着，而它现在是「拒绝并发 prompt」的判据，
      // 残留会让这个会话永久发不出消息，连自动重连重试也会被自己挡住。
      this.activePromptId = null;
      for (const [id, pending] of this.pendingRequests) {
        console.warn(`[ACP] reject pending request id=${id}`);
        pending.reject(new Error(wasIdleKill ? "ACP process idle-killed" : "ACP process closed"));
      }
      this.pendingRequests.clear();
    });

    this.acpProcess = await command.spawn();

    // 发送 initialize
    const initResult = await this.sendRequest("initialize", {
      protocolVersion: "2025-01-01",
      capabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: {
        name: "nova",
        title: "Nova Desktop",
        version: "1.0.0",
      },
    });

    if (initResult.error) {
      console.error(`[ACP] ❌ initialize 握手失败: ${initResult.error.message}`);
      fileLog(`❌ initialize 握手失败: ${initResult.error.message}`);
      throw new Error(`ACP initialize failed: ${initResult.error.message}${initResult.error.data ? " | data: " + JSON.stringify(initResult.error.data) : ""}`);
    }

    // 解析 Agent 能力声明
    this.agentCapabilities = (initResult.result?.agentCapabilities as AgentCapabilities) || null;
    if (this.agentCapabilities) {
      const caps = this.agentCapabilities;
      fileLog(`🎯 agentCapabilities: loadSession=${caps.loadSession ?? false} | resume=${!!caps.sessionCapabilities?.resume} | close=${!!caps.sessionCapabilities?.close} | mcp.http=${caps.mcpCapabilities?.http ?? false}`);
      console.log(`[ACP] 🎯 agentCapabilities:`, JSON.stringify(caps));
    } else {
      fileLog(`⚠️ initialize response 中无 agentCapabilities`);
    }

    this.initialized = true;
    console.log(`[ACP] ✅ ACP 进程初始化完成 | connector: ${this.config.id} | pid: ${this.acpProcess?.pid}`);
    fileLog(`✅ ACP 初始化完成 | connector: ${this.config.id} | pid: ${this.acpProcess?.pid}`);
  }

  /** 解析 buffer 中的 newline-delimited JSON 消息 */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // 保留最后一个不完整的行
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as AcpMessage;
        this.handleMessage(msg);
      } catch {
        // 非 JSON 行忽略（可能是 stderr 混入）
      }
    }
  }

  /** 处理收到的 ACP 消息 */
  private handleMessage(msg: AcpMessage): void {
    // response: 有 id 且有 result 或 error
    if ("id" in msg && "result" in msg || "id" in msg && "error" in msg) {
      const resp = msg as AcpResponse;
      console.log(`[ACP:Msg] ← response id=${resp.id} ${resp.error ? 'ERROR: '+resp.error.message : 'OK'}`);
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        pending.resolve(resp);
      }
      return;
    }

    // notification 或 server->client request
    if ("method" in msg) {
      // 日志：对非 agent_message_chunk 的消息记录
      const msgMethod = (msg as any).method;
      if (msgMethod === "session/update" || msgMethod === "session/notification") {
        const params = (msg as any).params as { update?: AcpSessionUpdate } & Partial<AcpSessionUpdate>;
        const update = params.update ?? params;
        if (typeof update.sessionUpdate === "string" && update.sessionUpdate !== "agent_message_chunk") {
          console.log(`[ACP:Msg] ← notification/request method=${msgMethod} sessionUpdate=${update.sessionUpdate}`);
        }
      } else {
        console.log(`[ACP:Msg] ← notification/request method=${msgMethod}`);
      }
      // ACP v1 标准结构：session/update.params = { sessionId, update }。
      // 同时兼容早期 Kiro 文档中的 session/notification 以及扁平 params。
      if ((msg.method === "session/update" || msg.method === "session/notification") && this.notificationHandler) {
        const params = msg.params as { update?: AcpSessionUpdate } & Partial<AcpSessionUpdate>;
        const update = params.update ?? params;
        if (typeof update.sessionUpdate === "string") {
          // 详细日志：记录每种 sessionUpdate 的完整结构到文件。
          //
          // 必须排除高频 chunk 类型：fileLog 每行都要 spawn 一个 sh 进程，
          // 实测 acp-session.log 里 agent_thought_chunk 有 14.6 万条、
          // 且当时每条还额外走一次兜底日志 —— 近 30 万次进程创建、日志 65MB，
          // 全发生在 Agent 干活期间。
          const type = update.sessionUpdate;
          if (!isHighFrequencyChunk(type)) {
            fileLog(`[Notification] type="${type}" | FULL: ${JSON.stringify(update).slice(0, 500)}`);
          }
          this.notificationHandler(update as AcpSessionUpdate);
        }
      } else if (msg.method === "_kiro/auth/getAccessToken" && "id" in msg) {
        // V3 引擎会主动请求 auth token，返回空让其使用本地缓存凭证
        this.sendResponse((msg as any).id, {});
      } else if (msg.method === "fs/read_text_file" && "id" in msg) {
        // ACP 标准：Agent 请求读取文件内容
        this.handleFsReadTextFile((msg as any).id, msg.params);
      } else if (msg.method === "fs/write_text_file" && "id" in msg) {
        // ACP 标准：Agent 请求写入文件内容
        this.handleFsWriteTextFile((msg as any).id, msg.params);
      } else if (msg.method === "terminal/create" && "id" in msg) {
        // ACP 标准：Agent 请求创建终端执行命令
        this.handleTerminalCreate((msg as any).id, msg.params);
      } else if (msg.method === "terminal/output" && "id" in msg) {
        // ACP 标准：Agent 请求获取终端输出
        this.handleTerminalOutput((msg as any).id, msg.params);
      } else if (msg.method === "terminal/wait_for_exit" && "id" in msg) {
        // ACP 标准：Agent 等待终端命令完成
        this.handleTerminalWaitForExit((msg as any).id, msg.params);
      } else if (msg.method === "terminal/kill" && "id" in msg) {
        // ACP 标准：Agent 请求终止终端命令
        this.handleTerminalKill((msg as any).id, msg.params);
      } else if (msg.method === "terminal/release" && "id" in msg) {
        // ACP 标准：Agent 请求释放终端
        this.handleTerminalRelease((msg as any).id, msg.params);
      } else if (msg.method === "session/request_permission" && "id" in msg) {
        // 自动批准所有工具调用（等同于 --trust-all-tools）
        this.sendResponse((msg as any).id, { outcome: "allow", optionId: "allow_always" });
      } else if (msg.method === "session/request_question" && "id" in msg) {
        // 跳过问题
        this.sendResponse((msg as any).id, { answers: [] });
      }
    }
  }

  /** 发送 JSON-RPC request 并等待 response */
  private sendRequest(method: string, params: Record<string, any>): Promise<AcpResponse> {
    const id = this.nextId++;
    const request: AcpRequest = { jsonrpc: "2.0", id, method, params };
    const line = JSON.stringify(request) + "\n";

    // 记录非 prompt 请求的完整内容（prompt 太大只记摘要）
    if (method === "session/prompt") {
      fileLog(`📤 → ${method} | id=${id} | params keys: ${Object.keys(params).join(",")}`);
    } else {
      fileLog(`📤 → ${method} | id=${id} | params: ${JSON.stringify(params).slice(0, 500)}`);
    }

    // 追踪 prompt request ID，用于精确取消
    if (method === "session/prompt") {
      this.activePromptId = id;
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.acpProcess?.write(line).catch((err: Error) => {
        this.pendingRequests.delete(id);
        if (method === "session/prompt") this.activePromptId = null;
        reject(err);
      });
      // 超时：session/prompt 可能涉及 subagent 长任务，给 30 分钟；其他请求 2 分钟
      const timeoutMs = method === "session/prompt" ? 30 * 60 * 1000 : 2 * 60 * 1000;
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          if (method === "session/prompt") this.activePromptId = null;
          reject(new Error(`ACP request timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  /** 发送 JSON-RPC response（回复 server->client request） */
  private sendResponse(id: number, result: any): void {
    const response = { jsonrpc: "2.0", id, result };
    const line = JSON.stringify(response) + "\n";
    this.acpProcess?.write(line).catch(() => {});
  }

  /** 发送 JSON-RPC error response */
  private sendErrorResponse(id: number, code: number, message: string): void {
    const response = { jsonrpc: "2.0", id, error: { code, message } };
    const line = JSON.stringify(response) + "\n";
    this.acpProcess?.write(line).catch(() => {});
  }

  // ─── ACP File System Handlers ───

  /**
   * 处理 fs/read_text_file 请求。
   * Agent 请求 Nova 读取本地文件，支持 line/limit 参数进行范围读取。
   */
  private async handleFsReadTextFile(id: number, params: Record<string, any>): Promise<void> {
    const filePath: string = params.path;
    const startLine: number | undefined = params.line;  // 1-based
    const limit: number | undefined = params.limit;

    if (!filePath) {
      this.sendErrorResponse(id, -32602, "Missing required parameter: path");
      return;
    }

    fileLog(`[fs/read_text_file] path=${filePath} | line=${startLine ?? "all"} | limit=${limit ?? "all"}`);

    try {
      // 使用 cat 读取文件（通过 shell 避免 Tauri invoke 的限制）
      let shellCmd: string;
      if (startLine && limit) {
        // sed -n 'startLine,endLine p' file
        const endLine = startLine + limit - 1;
        shellCmd = `sed -n '${startLine},${endLine}p' "${filePath}"`;
      } else if (startLine) {
        shellCmd = `sed -n '${startLine},$p' "${filePath}"`;
      } else if (limit) {
        shellCmd = `head -n ${limit} "${filePath}"`;
      } else {
        shellCmd = `cat "${filePath}"`;
      }

      const cmd = Command.create("sh", ["-c", shellCmd]);
      const output = await cmd.execute();

      if (output.code !== 0) {
        const errMsg = output.stderr?.trim() || `Failed to read file: ${filePath}`;
        fileLog(`[fs/read_text_file] ❌ ${errMsg}`);
        this.sendErrorResponse(id, -32603, errMsg);
        return;
      }

      this.sendResponse(id, { content: output.stdout });
    } catch (err: any) {
      fileLog(`[fs/read_text_file] ❌ exception: ${err.message}`);
      this.sendErrorResponse(id, -32603, `Read failed: ${err.message}`);
    }
  }

  /**
   * 处理 fs/write_text_file 请求。
   * Agent 请求 Nova 写入文件。如果文件不存在则创建（包括父目录）。
   * 使用临时文件 + mv 的方式确保原子写入，避免 shell 转义问题。
   */
  private async handleFsWriteTextFile(id: number, params: Record<string, any>): Promise<void> {
    const filePath: string = params.path;
    const content: string = params.content;

    if (!filePath) {
      this.sendErrorResponse(id, -32602, "Missing required parameter: path");
      return;
    }
    if (content === undefined || content === null) {
      this.sendErrorResponse(id, -32602, "Missing required parameter: content");
      return;
    }

    fileLog(`[fs/write_text_file] path=${filePath} | ${content.length} chars`);

    try {
      // 确保父目录存在
      const dirCmd = Command.create("sh", ["-c", `mkdir -p "$(dirname "${filePath}")"`]);
      await dirCmd.execute();

      // 使用 Node-style base64 编码通过 shell 写入（避免转义问题）
      // 对于大文件，base64 编码会增加约 33% 的大小，但 shell arg 限制在 macOS 上是 ~256KB
      // 超大文件（>100KB）降级为分块写入
      const encoder = new TextEncoder();
      const bytes = encoder.encode(content);
      const CHUNK_SIZE = 65536; // 64KB per chunk for base64 safety

      if (bytes.length <= CHUNK_SIZE) {
        // 小文件：单次 base64 写入
        const base64 = this.bytesToBase64(bytes);
        const cmd = Command.create("sh", ["-c", `printf '%s' '${base64}' | base64 -d > "${filePath}"`]);
        const output = await cmd.execute();
        if (output.code !== 0) {
          throw new Error(output.stderr?.trim() || "write failed");
        }
      } else {
        // 大文件：分块追加写入
        let first = true;
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
          const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
          const base64 = this.bytesToBase64(chunk);
          const op = first ? ">" : ">>";
          first = false;
          const cmd = Command.create("sh", ["-c", `printf '%s' '${base64}' | base64 -d ${op} "${filePath}"`]);
          const output = await cmd.execute();
          if (output.code !== 0) {
            throw new Error(output.stderr?.trim() || "write chunk failed");
          }
        }
      }

      fileLog(`[fs/write_text_file] ✅ written ${content.length} chars to ${filePath}`);
      this.sendResponse(id, null);
    } catch (err: any) {
      fileLog(`[fs/write_text_file] ❌ exception: ${err.message}`);
      this.sendErrorResponse(id, -32603, `Write failed: ${err.message}`);
    }
  }

  /** 将 Uint8Array 转换为 base64 字符串 */
  private bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // ─── ACP Terminal Handlers ───

  /**
   * 处理 terminal/create 请求。
   * Agent 请求创建终端并执行命令。返回 terminalId，命令在后台运行。
   */
  private async handleTerminalCreate(id: number, params: Record<string, any>): Promise<void> {
    const command: string = params.command;
    const args: string[] = params.args || [];
    const env: { name: string; value: string }[] = params.env || [];
    const cwd: string = params.cwd || this.config.cwd || "/Users/wangxf/workspace";
    const outputByteLimit: number = params.outputByteLimit || 1024 * 1024; // 默认 1MB

    if (!command) {
      this.sendErrorResponse(id, -32602, "Missing required parameter: command");
      return;
    }

    const terminalId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    fileLog(`[terminal/create] id=${terminalId} | cmd=${command} ${args.join(" ")} | cwd=${cwd}`);

    try {
      // 构建完整 shell 命令
      const fullCmd = [command, ...args].join(" ");

      // 设置环境变量前缀
      const envPrefix = env.map(e => `${e.name}='${e.value.replace(/'/g, "'\\''")}'`).join(" ");
      const shellCmd = envPrefix ? `${envPrefix} ${fullCmd}` : fullCmd;

      const cmd = Command.create("sh", ["-c", shellCmd], {
        cwd,
        encoding: "utf-8",
      });

      const terminal: TerminalInstance = {
        id: terminalId,
        output: "",
        truncated: false,
        exitStatus: null,
        outputByteLimit,
        process: null,
        waitResolvers: [],
      };

      // 收集输出
      cmd.stdout.on("data", (data: string) => {
        terminal.output += data;
        // 检查是否超过字节限制
        if (terminal.output.length > outputByteLimit) {
          terminal.output = terminal.output.slice(-outputByteLimit);
          terminal.truncated = true;
        }
      });

      cmd.stderr.on("data", (data: string) => {
        terminal.output += data;
        if (terminal.output.length > outputByteLimit) {
          terminal.output = terminal.output.slice(-outputByteLimit);
          terminal.truncated = true;
        }
      });

      cmd.on("close", (data: any) => {
        terminal.exitStatus = {
          exitCode: data?.code ?? null,
          signal: data?.signal ?? null,
        };
        // 通知所有等待者
        for (const resolver of terminal.waitResolvers) {
          resolver(terminal.exitStatus);
        }
        terminal.waitResolvers = [];
      });

      terminal.process = await cmd.spawn();
      this.terminals.set(terminalId, terminal);

      this.sendResponse(id, { terminalId });
    } catch (err: any) {
      fileLog(`[terminal/create] ❌ ${err.message}`);
      this.sendErrorResponse(id, -32603, `Terminal create failed: ${err.message}`);
    }
  }

  /**
   * 处理 terminal/output 请求。
   * 返回终端当前的输出内容和退出状态（如果已退出）。
   */
  private handleTerminalOutput(id: number, params: Record<string, any>): void {
    const terminalId: string = params.terminalId;
    const terminal = this.terminals.get(terminalId);

    if (!terminal) {
      this.sendErrorResponse(id, -32603, `Terminal not found: ${terminalId}`);
      return;
    }

    const result: any = {
      output: terminal.output,
      truncated: terminal.truncated,
    };
    if (terminal.exitStatus) {
      result.exitStatus = terminal.exitStatus;
    }

    this.sendResponse(id, result);
  }

  /**
   * 处理 terminal/wait_for_exit 请求。
   * 阻塞直到命令完成，返回退出码。
   */
  private handleTerminalWaitForExit(id: number, params: Record<string, any>): void {
    const terminalId: string = params.terminalId;
    const terminal = this.terminals.get(terminalId);

    if (!terminal) {
      this.sendErrorResponse(id, -32603, `Terminal not found: ${terminalId}`);
      return;
    }

    // 如果已经退出，直接返回
    if (terminal.exitStatus) {
      this.sendResponse(id, terminal.exitStatus);
      return;
    }

    // 否则等待
    terminal.waitResolvers.push((exitStatus) => {
      this.sendResponse(id, exitStatus);
    });
  }

  /**
   * 处理 terminal/kill 请求。
   * 终止命令但不释放终端（输出仍可读取）。
   */
  private handleTerminalKill(id: number, params: Record<string, any>): void {
    const terminalId: string = params.terminalId;
    const terminal = this.terminals.get(terminalId);

    if (!terminal) {
      this.sendErrorResponse(id, -32603, `Terminal not found: ${terminalId}`);
      return;
    }

    if (terminal.process && !terminal.exitStatus) {
      try {
        terminal.process.kill();
      } catch {}
    }

    this.sendResponse(id, null);
  }

  /**
   * 处理 terminal/release 请求。
   * 终止命令（如果还在运行）并释放所有资源。
   */
  private handleTerminalRelease(id: number, params: Record<string, any>): void {
    const terminalId: string = params.terminalId;
    const terminal = this.terminals.get(terminalId);

    if (!terminal) {
      this.sendErrorResponse(id, -32603, `Terminal not found: ${terminalId}`);
      return;
    }

    // Kill if still running
    if (terminal.process && !terminal.exitStatus) {
      try {
        terminal.process.kill();
      } catch {}
    }

    // Release resources
    this.terminals.delete(terminalId);
    fileLog(`[terminal/release] ${terminalId} released`);

    this.sendResponse(id, null);
  }

  /** 释放所有活跃终端（进程退出时调用） */
  private releaseAllTerminals(): void {
    for (const [_id, terminal] of this.terminals) {
      if (terminal.process && !terminal.exitStatus) {
        try { terminal.process.kill(); } catch {}
      }
    }
    this.terminals.clear();
  }

  /** 标记当前 session 是否已注入过历史（避免重复注入） */
  private historyInjected: boolean = false;
  /** 需要注入到首次 prompt 的历史消息（session/load 不可用时的 fallback） */
  private pendingHistoryForPrompt: HistoryMessage[] | null = null;

  /**
   * 创建或复用 ACP session（支持三级恢复策略）：
   * 1. session/resume — 进程存活且 agent 支持时直接恢复
   * 2. session/load — 从磁盘恢复旧会话完整上下文（替代 session/new）
   * 3. fallback — session/new 创建新会话，把历史注入到首次 prompt
   * ACP 规范：session/load 和 session/new 是 either/or，不是先后调用。
   * previousSessionId 由调用方从 ChatSession.connectorSessionId 传入（单一真相源）。
   */
  private async ensureSession(cwd?: string, history?: HistoryMessage[], previousSessionId?: string): Promise<string | null> {
    await this.ensureAcpProcess();

    if (this.sessionId) return this.sessionId;

    const workingDir = cwd || this.config.cwd;

    // ── 策略 1: session/resume ──
    // 进程存活 + agent 支持 resume 时尝试直接恢复（无需重放消息）
    if (previousSessionId && this.agentCapabilities?.sessionCapabilities?.resume) {
      fileLog(`🔄 [恢复策略1] 尝试 session/resume | previousSessionId: ${previousSessionId}`);
      try {
        const resumeResp = await this.sendRequest("session/resume", {
          sessionId: previousSessionId,
          cwd: workingDir,
          mcpServers: mcpServersForAcp(this.mcpServers),
        });

        if (!resumeResp.error) {
          this.sessionId = previousSessionId;
          this.historyInjected = true; // resume 成功无需注入历史
          fileLog(`✅ session/resume 成功 | sessionId: ${this.sessionId}`);
          console.log(`[ACP] ✅ session/resume 成功 | sessionId: ${this.sessionId}`);
          return this.sessionId!;
        }

        fileLog(`⚠️ session/resume 失败: ${resumeResp.error.message} | 尝试下一策略`);
        console.log(`[ACP] ⚠️ session/resume 失败: ${resumeResp.error.message}`);
      } catch (err: any) {
        fileLog(`⚠️ session/resume 异常: ${err.message} | 尝试下一策略`);
      }
    }

    // ── 策略 2: session/load（在 session/new 之前尝试） ──
    // ACP 规范：session/load 是 session/new 的替代，不是后续步骤。
    // 它从磁盘恢复旧会话的完整上下文（messages.jsonl），包括所有对话历史和 tool call 结果。
    // 必填参数：sessionId + cwd + mcpServers。成功返回 result=null。
    // previousSessionId 由参数传入（来自 ChatSession.connectorSessionId，单一真相源）。

    if (this.agentCapabilities?.loadSession && previousSessionId && history && history.length > 0) {
      fileLog(`🔄 [恢复策略2] 尝试 session/load | previousSessionId: ${previousSessionId}`);
      try {
        const loadResp = await this.sendRequest("session/load", {
          sessionId: previousSessionId,
          cwd: workingDir,
          mcpServers: mcpServersForAcp(this.mcpServers),
        });

        if (!loadResp.error) {
          // session/load 成功：sessionId 不变，历史已从磁盘恢复
          this.sessionId = previousSessionId;
          this.historyInjected = true;
          fileLog(`✅ session/load 成功 | 完整上下文已从磁盘恢复 | sessionId: ${this.sessionId}`);
          console.log(`[ACP] ✅ session/load 成功 | 完整上下文已从磁盘恢复`);
          return this.sessionId!;
        }

        fileLog(`⚠️ session/load 失败: ${loadResp.error?.message} | fallback 到 session/new`);
        console.log(`[ACP] ⚠️ session/load 失败: ${loadResp.error?.message}`);
      } catch (err: any) {
        fileLog(`⚠️ session/load 异常: ${err.message} | fallback 到 session/new`);
        console.log(`[ACP] ⚠️ session/load 异常: ${err.message}`);
      }

      // session/load 可能导致进程崩溃（code=0），此时 acpProcess 为 null。
      // 不能直接发 session/new——sendRequest 的 optional chaining 会静默跳过 write，
      // 请求卡 2 分钟超时。返回 null 让 send() 的安全检查重启进程后再 session/new。
      if (!this.acpProcess) {
        fileLog(`💀 session/load 后进程已死，跳过 session/new，返回 null 让调用方重启`);
        return null;
      }
    } else {
      const reason = !this.agentCapabilities?.loadSession ? "agent 不支持 loadSession"
        : !previousSessionId ? "无 previousSessionId"
        : !history || history.length === 0 ? "无历史需要恢复"
        : "未知";
      fileLog(`⏭️ [恢复策略2] 跳过 session/load | 原因: ${reason}`);
    }

    // ── 策略 3: session/new + prompt 注入 ──
    // session/load 不可用或失败时，创建新 session，把历史注入到首次 prompt
    const acpMcpServers = mcpServersForAcp(this.mcpServers);
    fileLog(`[MCP] session/new mcpServers: ${JSON.stringify(acpMcpServers)} (注册数: ${this.mcpServers.length})`);
    const resp = await this.sendRequest("session/new", {
      cwd: workingDir,
      mcpServers: acpMcpServers,
    });

    if (resp.error) {
      fileLog(`❌ session/new 失败: ${resp.error.message}`);
      throw new Error(`session/new failed: ${resp.error.message}`);
    }

    this.sessionId = resp.result?.sessionId;
    fileLog(`session/new: ${this.sessionId} | previousSessionId: ${previousSessionId || "(none)"}`);

    // 如果没有历史消息需要恢复，直接返回
    if (!history || history.length === 0) {
      this.historyInjected = true;
      return this.sessionId!;
    }

    // 有历史但 session/load 失败了，暂存历史待首次 prompt 注入
    fileLog(`📋 [恢复策略3] 将 ${history.length} 条历史消息标记为待注入到首次 prompt`);
    this.pendingHistoryForPrompt = history;
    this.historyInjected = false;

    return this.sessionId!;
  }

  async send(
    input: string,
    options: SendOptions,
    onChunk: (content: string) => void,
    onMeta?: (meta: StreamMeta) => void,
  ): Promise<SendResult> {
    // ── 尽早拦截：disposed 实例不应该处理任何请求 ──
    if (this.disposed) {
      throw new Error("ACP connector disposed: 此实例已被释放，请使用新实例");
    }

    // ── 拒绝并发 prompt ──
    //
    // 一个 ACP session 同时只能有一个活跃 turn。往正在应答的 session 再发
    // 一个 session/prompt，Agent 会把它当成「用户打断」，前一个 turn 直接终止，
    // 正文末尾留下一句 "Response was interrupted by the user" —— 用户看到的是
    // 「任务自行停止了」，而实际上什么都没点。
    //
    // ChatView 有排队机制，但它依赖自己的 UI 状态判断忙闲；企微通道、
    // 后台蒸馏、MCP 的 chat.send 等路径都不经过那个队列，能直接把 prompt
    // 塞进正在工作的 session。所以这道约束必须放在它真正成立的地方。
    if (this.activePromptId !== null) {
      fileLog(`⛔ 拒绝并发 prompt | sessionId: ${this.sessionId} | 在途 promptId: ${this.activePromptId}`);
      throw new Error("当前会话正在应答中，请等回答结束后再发送（避免打断正在进行的任务）");
    }

    // 重置闲置定时器（有新请求进来，延迟 kill）
    this.resetIdleTimer();
    this._lastActiveAt = Date.now();

    // 暂停闲置定时器——send 进行期间不应触发 kill
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    try {

      fileLog(`send() | input: ${input.slice(0, 60)} | sessionId: ${this.sessionId || "(无)"} | process: ${this.acpProcess ? "alive" : "null"}`);

      // ── Session 管理（每实例一个 session，复用或新建） ──
      await this.ensureAcpProcess();

      // sessionId 单一真相源：options.sessionId 即 ChatSession.connectorSessionId。
      // 直接传给 ensureSession，不再用 lastSessionId 中间缓存。
      if (!this.sessionId) {
        await this.ensureSession(options.cwd, options.history, options.sessionId);
        fileLog(`新建/恢复 session: ${this.sessionId}`);

        // session 创建/恢复成功后，立即回调上层持久化 connectorSessionId
        // 这样即使 prompt 期间进程崩溃，UI 已有最新 sessionId
        if (this.sessionId && options.onSessionCreated) {
          options.onSessionCreated(this.sessionId);
        }

        // 安全检查：session/load 等操作可能崩了进程导致 sessionId 为 null
        // 重启进程并创建新 session（不含历史，策略3 的历史仍保留在 pendingHistoryForPrompt 中）
        if (!this.sessionId) {
          fileLog(`⚠️ ensureSession 返回 null sessionId，进程可能已崩溃，尝试重建`);
          await this.ensureAcpProcess();
          // 直接 session/new，不走 ensureSession（避免再次触发 session/load）
          const retryResp = await this.sendRequest("session/new", {
            cwd: options.cwd || this.config.cwd,
            mcpServers: mcpServersForAcp(this.mcpServers),
          });
          if (retryResp.result?.sessionId) {
            this.sessionId = retryResp.result.sessionId;
            fileLog(`✅ 重建 session 成功: ${this.sessionId}`);
            if (options.onSessionCreated) {
              options.onSessionCreated(retryResp.result.sessionId);
            }
          } else {
            throw new Error("ensureSession 两次失败，无法创建 session");
          }
        }
      }


      // 切换模型 — ACP session/set_model
      if (this.currentModel && this.currentModel !== "auto") {
        this.sendRequest("session/set_model", {
          sessionId: this.sessionId,
          modelId: this.currentModel,
        }).catch(() => {});
      }

      // 构建 prompt 内容
      const promptParts: { type: string; text?: string; path?: string }[] = [];

      // 跨会话记忆补充（分离 Nova 运行时上下文和用户记忆）
      if (options.memorySupplement) {
        // Nova 身份上下文（<nova_runtime>）独立注入，不走 <user_memory>
        const novaRuntimeMatch = options.memorySupplement.match(
          /^(<nova_runtime>[\s\S]*?<\/nova_runtime>(?:\n\n<nova_tools>[\s\S]*?<\/nova_tools>)?)\n\n([\s\S]*)$/
        );
        if (novaRuntimeMatch) {
          // Nova 上下文独立注入
          promptParts.push({ type: "text", text: novaRuntimeMatch[1] });
          // 剩余部分作为用户记忆
          if (novaRuntimeMatch[2].trim()) {
            promptParts.push({ type: "text", text: `<user_memory>\n${novaRuntimeMatch[2]}\n</user_memory>` });
          }
        } else {
          // 没有 Nova 上下文，全部作为用户记忆
          promptParts.push({
            type: "text",
            text: `<user_memory>\n${options.memorySupplement}\n</user_memory>`,
          });
        }
      }

      // skill 创建路径指令（始终注入，确保 agent 知道正确路径）
      promptParts.push({
        type: "text",
        text: "注意：如果需要创建 skill，请将其创建到 ~/.nova/skills/ 目录下，而不是 ~/.kiro/skills/。",
      });

      // ── 历史消息注入（策略 3 fallback：session/load 不可用时） ──
      // 注意：不在此处消耗 pendingHistoryForPrompt，等 prompt 发送成功后再标记
      // 避免 session/load 崩溃进程后、prompt 发送失败时历史被白白消耗导致重试丢失上下文
      let historyInjectedToPrompt = false;
      if (this.pendingHistoryForPrompt && this.pendingHistoryForPrompt.length > 0 && !this.historyInjected) {
        const historyLines = this.pendingHistoryForPrompt.map(m => {
          const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统";
          // 截断过长的单条消息，避免 prompt 过大
          const text = m.content.length > 800 ? m.content.slice(0, 800) + "..." : m.content;
          return `[${role}]: ${text}`;
        }).join("\n\n");

        promptParts.push({
          type: "text",
          text: `<conversation_history>\n以下是之前的对话历史（用于恢复上下文，请基于这些历史继续对话）：\n\n${historyLines}\n</conversation_history>`,
        });

        fileLog(`📋 历史注入到 prompt | ${this.pendingHistoryForPrompt.length} 条 | ${historyLines.length} chars`);
        historyInjectedToPrompt = true;
      }

      // 用户输入
      promptParts.push({ type: "text", text: input });

      // 附件
      if (options.attachments?.length) {
        for (const att of options.attachments) {
          promptParts.push({ type: "text", text: `[附件] ${att}` });
        }
      }

      // 合并为单个 text content（ACP prompt content 是数组）
      const content = promptParts.map(p => p.text).filter(Boolean).join("\n");

      // 按 ACP 的 agent_message_chunk 增量拼接原始 Markdown。
      // 仅在流式展示时补齐未闭合代码围栏，最终保存的仍是服务端原文。
      // 同时监听 ToolCall/ToolCallUpdate 展示工具调用状态。
      // 工具状态通过 <!--TOOL_CALLS:JSON--><!--TOOL_ACTIVE:name--> 附加在 chunk 末尾，渲染层解析后分离展示。
      let accumulated = "";
      let currentToolName = ""; // 当前活跃的工具名
      let thoughtAccumulated = ""; // Agent 思考过程（独立累积）
      let turnUsage: TokenUsage | undefined; // 本次 turn 的 token 消耗

      // ─── 过程时间线 ───
      // 按真实到达顺序记录 正文/思考/工具 三类事件，供 UI 还原交错时序。
      // 分段与乱序容错逻辑见 connectors/timeline.ts。
      const tl = new TimelineBuilder();

      // 收集所有工具调用信息，支持乱序（tool_call_update 可能先于 tool_call 到达）
      const toolCalls = new Map<string, AcpToolCall>();

      /** 从 update 载荷中提取 toolCallId（兼容多种字段命名） */
      const extractToolCallId = (u: AcpSessionUpdate): string =>
        u.toolCallId || u.tool_call_id || (u as any).id || `tc_${Date.now()}`;

      /** 从 update 载荷中提取 title（兼容 v2 引擎的各种写法） */
      const extractTitle = (u: AcpSessionUpdate): string =>
        u.title || u.toolName || u.name || u.tool_name || u.toolCall?.name || u.tool?.name || "thinking";

      /** 从 update 载荷中提取 kind 并规范化为标准 ToolKind */
      const extractKind = (u: AcpSessionUpdate): ToolKind => {
        const raw = u.kind || u.tool_kind || "";
        const validKinds: ToolKind[] = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"];
        return validKinds.includes(raw as ToolKind) ? (raw as ToolKind) : "other";
      };

      /** 从 update 载荷中提取 status 并规范化 */
      const extractStatus = (u: AcpSessionUpdate): ToolCallStatus => {
        const raw = u.status || u.state || "";
        switch (raw) {
          case "pending": return "pending";
          case "in_progress": case "running": return "in_progress";
          case "completed": case "done": return "completed";
          case "failed": case "error": return "failed";
          default: return "in_progress";
        }
      };

      /** 从 update 载荷中提取 tool call content（diff/terminal/regular content） */
      const extractToolCallContent = (u: AcpSessionUpdate): ToolCallContent[] | undefined => {
        // ACP 标准：tool_call/tool_call_update 的 content 字段是 ToolCallContent[]
        if (u.content && Array.isArray(u.content)) {
          return u.content as ToolCallContent[];
        }
        return undefined;
      };

      const emitChunk = () => {
        // onChunk 只传纯文本（流式 markdown）
        onChunk(stabilizeStreamingMarkdown(accumulated));
        // onMeta 传结构化 metadata（toolcall/thought）
        if (onMeta) {
          const meta: StreamMeta = {};
          if (toolCalls.size > 0) {
            meta.toolCalls = Array.from(toolCalls.values()).map(tc => ({
              toolCallId: tc.toolCallId,
              title: tc.title,
              kind: tc.kind,
              status: tc.status,
              startedAt: tc.startedAt,
              completedAt: tc.completedAt,
            }));
          }
          if (currentToolName) meta.activeTool = currentToolName;
          if (thoughtAccumulated) meta.thought = thoughtAccumulated;
          if (!tl.isEmpty) meta.timeline = tl.snapshot();
          onMeta(meta);
        }
      };

      this.notificationHandler = (update: AcpSessionUpdate) => {
        const type = update.sessionUpdate;

        // AgentMessageChunk — 流式文本
        if (isTextChunk(type)) {
          // content 在 message chunk 中是 AcpTextContent（单个对象，非数组）
          const c = update.content;
          if (!c || Array.isArray(c) || c.type !== "text" || !c.text) return;
          accumulated += c.text;
          tl.appendText(c.text);
          currentToolName = "";
          emitChunk();
        }
        // 思考过程 — ACP 标准名是 agent_thought_chunk。
        //
        // 原先只匹配 thought_message_chunk（当初从文档里猜的名字），
        // 而 kiro-cli 实际发的是 agent_thought_chunk，于是所有思考内容
        // 都掉进了兜底分支被丢掉：acp-session.log 里 146081 条
        // agent_thought_chunk，落到 timeline 的 thought 事件是 0 个。
        // 表现就是长时间只见工具在滚、没有任何解释性内容。
        else if (isThoughtChunk(type)) {
          const c = update.content;
          if (!c || Array.isArray(c) || c.type !== "text" || !c.text) return;
          thoughtAccumulated += c.text;
          tl.appendThought(c.text);
          emitChunk();
        }
        // ToolCall — 工具调用开始（ACP 标准: sessionUpdate="tool_call"）
        else if (type === "tool_call" || type === "ToolCall") {
          const toolCallId = extractToolCallId(update);
          const title = extractTitle(update);
          const kind = extractKind(update);
          const status = extractStatus(update);

          // 处理乱序：如果 tool_call_update(completed) 已先到，保留终结状态
          const existing = toolCalls.get(toolCallId);
          if (existing) {
            if (!existing.title || existing.title === "thinking") existing.title = title;
            if (existing.kind === "other") existing.kind = kind;
            // 不覆盖已经是 completed/failed 的状态
          } else {
            toolCalls.set(toolCallId, {
              toolCallId,
              title,
              kind,
              status: status === "completed" || status === "failed" ? status : "in_progress",
              content: extractToolCallContent(update),
              locations: update.locations,
              rawInput: update.rawInput,
              startedAt: Date.now(),
            });
          }

          currentToolName = title;
          fileLog(`[ToolCall] ${title} (${kind}) | id=${toolCallId} | status=${status}`);
          const tcForTimeline = toolCalls.get(toolCallId);
          if (tcForTimeline) tl.upsertTool(tcForTimeline);
          emitChunk();
        }
        // ToolCallUpdate — 工具执行进度/结束（ACP 标准: sessionUpdate="tool_call_update"）
        else if (type === "tool_call_update" || type === "ToolCallUpdate") {
          const toolCallId = extractToolCallId(update);
          const title = extractTitle(update);
          const kind = extractKind(update);
          const status = extractStatus(update);

          const isTerminal = status === "completed" || status === "failed";

          const existing = toolCalls.get(toolCallId);
          if (existing) {
            // 更新字段
            if (!existing.title || existing.title === "thinking") existing.title = title;
            if (existing.kind === "other") existing.kind = kind;
            if (isTerminal) {
              existing.status = status;
              existing.completedAt = Date.now();
            } else if (existing.status !== "completed" && existing.status !== "failed") {
              existing.status = status;
            }
            // 追加 content / locations / rawOutput
            const tcContent = extractToolCallContent(update);
            if (tcContent) existing.content = tcContent;
            if (update.locations) existing.locations = update.locations;
            if (update.rawOutput) existing.rawOutput = update.rawOutput;
          } else {
            // tool_call_update 先于 tool_call 到达（v2 引擎乱序问题）
            toolCalls.set(toolCallId, {
              toolCallId,
              title,
              kind,
              status,
              content: extractToolCallContent(update),
              locations: update.locations,
              rawOutput: update.rawOutput,
              startedAt: Date.now(),
              completedAt: isTerminal ? Date.now() : undefined,
            });
          }

          currentToolName = isTerminal ? "" : title;
          const tcUpdated = toolCalls.get(toolCallId);
          if (tcUpdated) tl.upsertTool(tcUpdated);
          emitChunk();
        }
        // TurnEnd — prompt turn 完成
        else if (type === "turn_end" || type === "TurnEnd") {
          fileLog(`[ACP:turn_end] FULL: ${JSON.stringify(update).slice(0, 500)}`);
          // 尝试从 turn_end notification 中提取 usage 信息
          const u = update as any;
          if (u.usage || u.tokenUsage || u.resourcePoints != null) {
            const raw = u.usage || u.tokenUsage || {};
            turnUsage = {
              inputTokens: raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens,
              outputTokens: raw.outputTokens ?? raw.output_tokens ?? raw.completionTokens,
              totalTokens: raw.totalTokens ?? raw.total_tokens,
              resourcePoints: u.resourcePoints ?? raw.resourcePoints,
            };
            fileLog(`[ACP:turn_end] usage extracted: ${JSON.stringify(turnUsage)}`);
          }
          currentToolName = "";
          emitChunk();
        }
        // 其他类型只写文件日志（高频 chunk 除外，见 isHighFrequencyChunk）
        else if (!isHighFrequencyChunk(type)) {
          fileLog(`[ACP:${type}] ${JSON.stringify(update).slice(0, 300)}`);
        }
      };

      // 发送 prompt
      fileLog(`📤 prompt | sessionId: ${this.sessionId} | ${content.length} chars`);
      // activePromptId 必须无条件清理：它是「拒绝并发 prompt」的判据，
      // 任何一条异常出口漏掉都会把这个会话永久卡在「正在应答中」。
      let promptResp: AcpResponse;
      try {
        promptResp = await this.sendRequest("session/prompt", {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: content }],
        });
      } finally {
        this.activePromptId = null;
      }

      this.notificationHandler = null;

      fileLog(`📥 prompt 返回 | error: ${promptResp.error?.message || "null"} | accumulated: ${accumulated.length} chars`);

      fileLog(`📥 prompt result 完整: ${JSON.stringify(promptResp.result ?? null).slice(0, 1000)}`);

      if (promptResp.error) {
        const errData = typeof promptResp.error.data === "string" ? promptResp.error.data : "";

        // ACP 标准：-32800 = Request Cancelled（用户主动取消）
        if (promptResp.error.code === -32800) {
          fileLog(`🛑 prompt 被用户取消 | sessionId: ${this.sessionId} | accumulated: ${accumulated.length} chars`);
          // 取消时返回已累积的部分内容（如果有的话）
          const finalContent = accumulated || "（已取消）";
          const cancelMeta: StreamMeta = {};
          if (toolCalls.size > 0) {
            cancelMeta.toolCalls = Array.from(toolCalls.values()).map(tc => ({
              toolCallId: tc.toolCallId,
              title: tc.title,
              kind: tc.kind,
              status: tc.status,
              startedAt: tc.startedAt,
              completedAt: tc.completedAt,
            }));
          }
          return {
            content: finalContent,
            sessionId: this.sessionId || undefined,
            meta: cancelMeta,
          };
          return {
            content: finalContent,
            sessionId: this.sessionId || undefined,
          };
        }

        if (errData.includes("Prompt already in progress") || promptResp.error.message.includes("Prompt already in progress")) {
          fileLog(`⚠️ prompt 冲突 | sessionId: ${this.sessionId}`);
          return {
            content: "⚠️ 上一条消息还在处理中，请稍等。",
            sessionId: this.sessionId || undefined,
          };
        }

        // ── 自动重试机制 ──
        // 条件：Internal error (-32603) 且尚未开始流式输出（accumulated === 0）
        // 最多重试 2 次，间隔递增（1s, 2s）
        const MAX_PROMPT_RETRIES = 2;
        const retryCount = options._promptRetryCount || 0;
        const isRetriableError = promptResp.error.code === -32603;
        const hasNoOutput = accumulated.length === 0;

        if (isRetriableError && hasNoOutput && retryCount < MAX_PROMPT_RETRIES) {
          const delay = (retryCount + 1) * 1000;
          fileLog(`🔄 prompt Internal error，自动重试 #${retryCount + 1}/${MAX_PROMPT_RETRIES} | delay: ${delay}ms | sessionId: ${this.sessionId}`);
          await new Promise(r => setTimeout(r, delay));
          // 重置状态，重新发送 prompt（不重建 session）
          return await this.send(input, { ...options, _promptRetryCount: retryCount + 1 }, onChunk, onMeta);
        }

        // ── 部分内容容错 ──
        // 如果已有流式内容但中途断裂，展示已有内容 + 提示
        if (accumulated.length > 0) {
          fileLog(`⚠️ prompt 中途断裂 | accumulated: ${accumulated.length} chars | error: ${promptResp.error.message}`);
          const partialMeta: StreamMeta = {};
          if (toolCalls.size > 0) {
            partialMeta.toolCalls = Array.from(toolCalls.values()).map(tc => ({
              toolCallId: tc.toolCallId,
              title: tc.title,
              kind: tc.kind,
              status: tc.status === "in_progress" ? "failed" as const : tc.status,
              startedAt: tc.startedAt,
              completedAt: tc.completedAt || Date.now(),
            }));
          }
          if (thoughtAccumulated) partialMeta.thought = thoughtAccumulated;
          // 提示必须进 timeline：MessageItem 在有 timeline 时只渲染 timeline，
          // 只拼到 content 上的话用户什么都看不到 —— 表现就是「说了一句开场白、
          // 跑了几个工具、然后没有下文」，完全看不出是报错断掉的。
          const interruptNotice = "\n\n---\n⚠️ *生成中断，以上为部分内容。*";
          tl.appendText(interruptNotice);
          tl.closeSegment();
          if (!tl.isEmpty) partialMeta.timeline = tl.snapshot();
          return {
            content: accumulated + interruptNotice,
            sessionId: this.sessionId || undefined,
            meta: partialMeta,
          };
        }

        // ── 错误信息友好化 ──
        fileLog(`❌ prompt 失败: ${promptResp.error.message} | data: ${errData.slice(0, 200)} | retries exhausted: ${retryCount}`);
        const friendlyMessage = this.getFriendlyErrorMessage(promptResp.error.message, errData);
        return {
          content: friendlyMessage,
          sessionId: this.sessionId || undefined,
        };
      }

      // prompt 成功——此时才消耗历史，避免进程崩溃重试时历史丢失
      if (historyInjectedToPrompt) {
        this.pendingHistoryForPrompt = null;
        this.historyInjected = true;
      }

      fileLog(`✅ send() 完成 | ${accumulated.length} chars | thought: ${thoughtAccumulated.length} chars | toolCalls: ${toolCalls.size}`);

      // 尝试从 prompt result 中提取 usage（如果 turn_end 没有提供的话）
      if (!turnUsage && promptResp.result) {
        const r = promptResp.result;
        const raw = r.usage || r.tokenUsage;
        if (raw || r.resourcePoints != null) {
          turnUsage = {
            inputTokens: raw?.inputTokens ?? raw?.input_tokens ?? raw?.promptTokens,
            outputTokens: raw?.outputTokens ?? raw?.output_tokens ?? raw?.completionTokens,
            totalTokens: raw?.totalTokens ?? raw?.total_tokens,
            resourcePoints: r.resourcePoints ?? raw?.resourcePoints,
          };
          fileLog(`[ACP:result] usage extracted: ${JSON.stringify(turnUsage)}`);
        }
      }

      // 将工具调用信息和思考内容通过 meta 返回（不嵌入 content）
      const finalContent = accumulated || "（无输出）";
      const finalMeta: StreamMeta = {};
      if (toolCalls.size > 0) {
        finalMeta.toolCalls = Array.from(toolCalls.values()).map(tc => ({
          toolCallId: tc.toolCallId,
          title: tc.title,
          kind: tc.kind,
          status: tc.status,
          startedAt: tc.startedAt,
          completedAt: tc.completedAt,
        }));
      }
      if (thoughtAccumulated) finalMeta.thought = thoughtAccumulated;
      tl.closeSegment();
      if (!tl.isEmpty) finalMeta.timeline = tl.snapshot();

      return {
        content: finalContent,
        sessionId: this.sessionId || undefined,
        usage: turnUsage,
        meta: finalMeta,
      };
    } catch (err: any) {
      this.notificationHandler = null;
      const sessionIdBeforeError = this.sessionId;

      // 自动重连重试：进程关闭时重启并重试一次
      const isProcessClosed = !this.acpProcess || err.message?.includes("ACP process closed") || err.message?.includes("ACP process idle-killed");
      if (isProcessClosed && !options._isRetry) {
        if (this.disposed) {
          throw new Error("ACP connector disposed");
        }
        fileLog(`🔄 进程关闭，重连重试 | error: ${err.message}`);
        this.initialized = false;
        this.sessionId = null;
        this.acpProcess = null;
        await new Promise(r => setTimeout(r, 300));
        try {
          return await this.send(input, { ...options, _isRetry: true }, onChunk);
        } catch (retryErr: any) {
          fileLog(`💀 重试失败: ${retryErr.message}`);
          return {
            content: `⚠️ ACP 进程断开且重连失败: ${retryErr.message}`,
            sessionId: sessionIdBeforeError || undefined,
          };
        }
      }

      // 一般错误
      if (!this.acpProcess) {
        this.initialized = false;
        this.sessionId = null;
      }
      fileLog(`❌ send() 异常: ${err.message}`);
      return {
        content: `⚠️ ${err.message || "ACP 通信异常"}`,
        sessionId: sessionIdBeforeError || undefined,
      };
    }
  }

  /**
   * 将技术错误信息转换为用户友好的提示文本。
   */
  private getFriendlyErrorMessage(message: string, data: string): string {
    const combined = `${message} ${data}`.toLowerCase();

    if (combined.includes("dispatch failure") || combined.includes("response stream")) {
      return "⚠️ AI 服务连接中断，请重新发送消息。";
    }
    if (combined.includes("timeout") || combined.includes("timed out")) {
      return "⚠️ AI 服务响应超时，请稍后重试。";
    }
    if (combined.includes("rate limit") || combined.includes("throttl")) {
      return "⚠️ 请求频率过高，请稍后再试。";
    }
    if (combined.includes("internal error") && !data) {
      return "⚠️ AI 服务暂时不可用，请重新发送。";
    }
    // 其他未知错误：显示简化信息
    return `⚠️ 请求失败：${message}`;
  }

  /**
   * 通过 _kiro.dev/commands/execute 调用 /usage 命令获取资源点信息。
   * 返回命令输出文本，失败时返回 null。
   */
  async getUsage(): Promise<string | null> {
    if (!this.acpProcess || !this.sessionId) return null;
    try {
      const resp = await this.sendRequest("_kiro.dev/commands/execute", {
        sessionId: this.sessionId,
        command: "/usage",
      });
      fileLog(`[/usage] result: ${JSON.stringify(resp.result || resp.error).slice(0, 500)}`);
      if (resp.error) return null;
      // 返回可能是 { output: "..." } 或 { content: "..." } 或直接字符串
      const result = resp.result;
      if (typeof result === "string") return result;
      if (result?.output) return result.output;
      if (result?.content) return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
      return JSON.stringify(result);
    } catch {
      return null;
    }
  }

  abort(): void {
    // 【临时诊断】查「任务自行停止」的真实调用方。
    // 用户反馈只用 Enter 发送、从未点过停止按钮，但每次 cancelled 前都有 abort()，
    // 而代码里只有停止按钮会调它 —— 说明还有没找到的触发路径。
    const stack = (new Error().stack || "(无栈)").split("\n").slice(1, 10).map(s => s.trim()).join(" << ");
    let focus = "(未知)";
    try {
      const ae = document.activeElement as HTMLElement | null;
      focus = ae ? `${ae.tagName}${ae.title ? `[title=${ae.title}]` : ""}${ae.className ? `.${ae.className.slice(0, 40)}` : ""}` : "(无)";
    } catch {}
    fileLog(`🔍 abort() 调用栈 | focus: ${focus} | stack: ${stack}`);

    fileLog(`abort() | sessionId: ${this.sessionId || "(无)"} | activePromptId: ${this.activePromptId || "(无)"}`);
    if (!this.acpProcess) return;

    // 1. 发送 ACP 标准 $/cancel_request（精确取消指定 request）
    if (this.activePromptId) {
      const cancelRequest = JSON.stringify({
        jsonrpc: "2.0",
        method: "$/cancel_request",
        params: { id: this.activePromptId },
      }) + "\n";
      this.acpProcess.write(cancelRequest).catch(() => {});
      fileLog(`📤 $/cancel_request | id=${this.activePromptId}`);
    }

    // 2. 同时发送 session/cancel（兼容不支持 $/cancel_request 的旧版 agent）
    if (this.sessionId) {
      const sessionCancel = JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.sessionId },
      }) + "\n";
      this.acpProcess.write(sessionCancel).catch(() => {});
    }

    if (this.abortResolve) {
      this.abortResolve();
      this.abortResolve = null;
    }
  }

  /** 杀掉 ACP 进程 */
  private async killAcpProcess(): Promise<void> {
    console.log(`[ACP] 🔪 killAcpProcess 开始 | pid: ${this.acpProcess?.pid} | sessionId: ${this.sessionId}`);
    if (this.acpProcess) {
      const pid = this.acpProcess.pid;
      console.log(`[ACP] 🔪 killAcpProcess: 开始杀进程 | pid: ${pid} | connector: ${this.config.id} | sessionId: ${this.sessionId}`);
      fileLog(`🔪 killAcpProcess: pid=${pid} | connector: ${this.config.id} | sessionId: ${this.sessionId}`);
      console.log(`[ACP] 🔪 killAcpProcess: pid=${pid} | sessionId: ${this.sessionId} | connector: ${this.config.id}`);
      fileLog(`🔪 killAcpProcess: pid=${pid} | sessionId: ${this.sessionId} | connector: ${this.config.id}`);
      try { this.acpProcess.kill(); } catch {}
      this.acpProcess = null;

      // kiro-cli 是 wrapper，会 fork 出 kiro-cli-chat 子进程。
      // 仅杀父进程会让子进程变成孤儿进程并继续持有 session lock。
      // 用 pkill -P 杀掉以 pid 为父的所有子进程，并等待命令执行完成。
      if (pid) {
        try {
          const cmd = Command.create("sh", ["-c", `pkill -TERM -P ${pid} 2>/dev/null; sleep 0.3; pkill -KILL -P ${pid} 2>/dev/null`]);
          // 先注册 close 监听，再 spawn，避免 race
          const done = new Promise<void>((resolve) => {
            cmd.on("close", () => resolve());
            setTimeout(() => resolve(), 2000); // 兜底：最多等 2s
          });
          await cmd.spawn();
          await done;
        } catch {}
        console.log(`[ACP] 🔪 killAcpProcess 完成，子进程已清理`);
      }
    }
    // 清理闲置定时器
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.initialized = false;
    this.sessionId = null;
    this.pendingRequests.clear();
    // 重置历史注入状态（下次新建 session 时需要重新判断）
    this.historyInjected = false;
    this.pendingHistoryForPrompt = null;
    // 释放所有活跃终端
    this.releaseAllTerminals();
    console.log(`[ACP] 🔪 killAcpProcess: 清理完毕 | connector: ${this.config.id}`);
  }

  /** 标记实例是否已被 dispose，阻止后续 send 重试启动新进程 */
  private disposed: boolean = false;

  /** 重置 ACP 进程 — 配置变更后调用，kill 旧进程，下次 send 时会用新配置重新启动 */
  async resetProcess(): Promise<void> {
    console.log(`[ACP] 🔄 resetProcess: 配置已变更，重置进程 | connector: ${this.config.id}`);
    await this.killAcpProcess();
  }

  /** 释放 ACP 子进程资源 */
  async dispose(): Promise<void> {
    this.disposed = true;
    console.log('[ACP] 🧹 dispose() | connector:', this.config.id, '| sessionId:', this.sessionId, '| process:', this.acpProcess ? 'alive' : 'null');
    fileLog(`🧹 dispose() | sessionId: ${this.sessionId || "(无)"} | process: ${this.acpProcess ? 'alive' : 'null'}`);

    // 清理闲置定时器
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // 从 mcp.json 移除 Nova MCP servers
    await this.removeMcpFromKiroConfig();

    // 优雅关闭 session
    await this.gracefulClose();
    await this.killAcpProcess();
  }

  /**
   * 优雅关闭当前 session（如果 agent 支持 session/close）。
   * 发送 session/close 让 agent 取消进行中的工作并释放资源。
   * 超时 3 秒后放弃等待。
   */
  private async gracefulClose(): Promise<void> {
    if (!this.acpProcess || !this.sessionId) return;
    if (!this.agentCapabilities?.sessionCapabilities?.close) {
      // Agent 不支持 session/close，跳过
      return;
    }

    fileLog(`🤝 session/close | sessionId: ${this.sessionId}`);
    try {
      const closePromise = this.sendRequest("session/close", {
        sessionId: this.sessionId,
      });

      // 最多等 3 秒
      await Promise.race([
        closePromise,
        new Promise<void>(r => setTimeout(r, 3000)),
      ]);

      fileLog(`✅ session/close 完成`);
    } catch (err: any) {
      // session/close 失败不影响后续 kill
      fileLog(`⚠️ session/close 失败: ${err.message}`);
    }
  }

  async listModels(): Promise<{ models: ModelInfo[]; defaultModel: string }> {
    try {
      const command = Command.create("kiro-cli", ["chat", "--list-models", "--format", "json"], {
        cwd: this.config.cwd,
        encoding: "utf-8",
      });
      let output = "";
      command.stdout.on("data", (d) => { output += d; });
      await command.spawn();
      await new Promise<void>((resolve) => { command.on("close", () => resolve()); });
      const data = JSON.parse(output);
      return {
        models: data.models || [],
        defaultModel: data.default_model || "auto",
      };
    } catch {
      return { models: [], defaultModel: "auto" };
    }
  }

  async listSessions(): Promise<{ id: string; label: string }[]> {
    try {
      const command = Command.create("kiro-cli", ["chat", "--list-sessions", "--format", "json"], {
        cwd: this.config.cwd,
        encoding: "utf-8",
      });
      let output = "";
      command.stdout.on("data", (d) => { output += d; });
      await command.spawn();
      await new Promise<void>((resolve) => { command.on("close", () => resolve()); });
      const data = JSON.parse(output);
      const sessions: { id: string; label: string }[] = [];
      for (const ws of data) {
        for (const s of ws.sessions || []) {
          sessions.push({ id: s.sessionId, label: s.sessionId.slice(0, 8) });
        }
      }
      return sessions;
    } catch {
      return [];
    }
  }
}
