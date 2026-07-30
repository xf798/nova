// ===== Connector 实例管理器（统一 per-session 实例池） =====
//
// 每个 Nova 会话 × 连接器 拥有独立的 connector 实例：
// - CLI 类型（kiro-cli）：独立 ACP 子进程 + session，解决多会话共用单例导致的
//   "Prompt already in progress" 冲突。
// - API 类型（OpenAI 兼容）：独立轻量实例，隔离 per-session 模型选择等状态。
//
// 池管理策略：
// - 统一 key 为 `${sessionId}::${connectorId}`，同一会话切换连接器各自保留实例
// - holdsProcess 标记区分「持有子进程」的重实例和零成本的 API 实例
// - 容量上限（MAX_ACTIVE_INSTANCES）只对持进程实例计数，避免一堆零成本 API
//   实例把配额占满、反过来驱逐真正占进程的 CLI 实例
// - 闲置清理对两类实例都做（防止 Map 无界增长），但只有持进程实例会真正杀进程

import { KiroCliConnector } from "./builtin/kiro-cli";
import { OpenAIConnector } from "./builtin/openai-api";
import type { Connector, ConnectorConfig } from "./base";
import { logger } from "../core/logger";

// ─── 常量 ───

/**
 * 闲置超时时间（毫秒）。
 *
 * 设计依据：
 * - ACP session/prompt 请求超时为 600000ms（10分钟）
 * - 用户可能在两次对话之间有较长思考时间
 * - 设为 15 分钟，大于 prompt 超时（10min），保证正在执行的请求不会被误杀
 * - 单个实例自身也有 10min 闲置 timer（resetIdleTimer），作为双重保险
 */
const POOL_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 分钟

/**
 * 清理巡检间隔（毫秒）。
 * 每 2 分钟扫描一次池中的实例，清理超时的。
 */
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // 2 分钟

/**
 * 最大同时活跃「持进程」实例数。
 * 超过此数量时，优先驱逐最久未活跃的持进程实例。
 * 注意：API 类型实例不占用此配额。
 */
const MAX_ACTIVE_INSTANCES = 10;

/** 池 key 分隔符（用 :: 降低与 sessionId / connectorId 自身字符冲突的概率） */
const KEY_SEP = "::";

// ─── 类型 ───

/** 实例元数据（用于追踪活跃度） */
interface InstanceMeta {
  /** 关联的 connector 实例 */
  connector: Connector;
  /** 所属会话 ID */
  sessionId: string;
  /** 连接器 ID（base connector 的 id） */
  connectorId: string;
  /** 是否持有子进程（CLI 类型），决定是否占用容量配额 / 需要杀进程 */
  holdsProcess: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 最后活跃时间（send 调用时更新） */
  lastActiveAt: number;
  /** 是否正在处理请求 */
  busy: boolean;
}

/** 实例池状态快照（用于监控/UI 展示） */
export interface ProcessPoolStats {
  /** 当前活跃实例总数 */
  totalInstances: number;
  /** 持有子进程的实例数（占用容量配额的部分） */
  processInstances: number;
  /** 正在处理请求的实例数 */
  busyInstances: number;
  /** 闲置中的实例数 */
  idleInstances: number;
  /** 每个实例的摘要信息 */
  instances: {
    sessionId: string;
    connectorId: string;
    holdsProcess: boolean;
    createdAt: number;
    lastActiveAt: number;
    idleDurationMs: number;
    busy: boolean;
  }[];
}

// ─── 实现 ───

class ConnectorInstanceManager {
  /** 统一实例池：`${sessionId}::${connectorId}` → InstanceMeta */
  private pool: Map<string, InstanceMeta> = new Map();

  /** 定期清理定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startCleanupLoop();
  }

  // ─── 内部：key / 查询辅助 ───

  private makeKey(sessionId: string, connectorId: string): string {
    return `${sessionId}${KEY_SEP}${connectorId}`;
  }

  /** 取某会话下的全部实例条目 */
  private entriesOfSession(sessionId: string): [string, InstanceMeta][] {
    const prefix = `${sessionId}${KEY_SEP}`;
    return Array.from(this.pool.entries()).filter(([key]) => key.startsWith(prefix));
  }

  /** 当前持进程实例数（用于容量判定） */
  private get processInstanceCount(): number {
    let n = 0;
    for (const meta of this.pool.values()) if (meta.holdsProcess) n++;
    return n;
  }

  /** 读取实例的有效活跃时间（CLI 实例自带更精确的 lastActiveAt） */
  private effectiveActiveAt(meta: InstanceMeta): number {
    const own = (meta.connector as { lastActiveAt?: number }).lastActiveAt;
    return typeof own === "number" ? Math.max(own, meta.lastActiveAt) : meta.lastActiveAt;
  }

  // ─── 公开 API ───

  /**
   * 获取指定会话 + 连接器的实例，不存在则按 base connector 的类型创建。
   *
   * @param sessionId Nova 会话 ID
   * @param baseConnector 注册中心里的「模板」连接器，用于决定类型与基础配置
   * @param config 覆盖配置（如 CLI 的 cwd）
   */
  getOrCreate(sessionId: string, baseConnector: Connector, config?: Partial<ConnectorConfig>): Connector {
    const connectorId = baseConnector.config.id;
    const key = this.makeKey(sessionId, connectorId);

    const existing = this.pool.get(key);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing.connector;
    }

    const holdsProcess = baseConnector.config.type === "cli";

    // 只有持进程实例受容量限制
    if (holdsProcess && this.processInstanceCount >= MAX_ACTIVE_INSTANCES) {
      this.evictLeastActive();
    }

    const connector = this.createInstance(sessionId, baseConnector, config);

    const now = Date.now();
    this.pool.set(key, {
      connector,
      sessionId,
      connectorId,
      holdsProcess,
      createdAt: now,
      lastActiveAt: now,
      busy: false,
    });

    logger.connector(`创建会话实例: ${sessionId.slice(0, 8)} / ${connectorId}`, {
      holdsProcess,
      totalInstances: this.pool.size,
      processInstances: this.processInstanceCount,
      maxAllowed: MAX_ACTIVE_INSTANCES,
    });

    return connector;
  }

  /** 按 base connector 类型构造实例 */
  private createInstance(
    sessionId: string,
    baseConnector: Connector,
    config?: Partial<ConnectorConfig>,
  ): Connector {
    if (baseConnector.config.type === "cli") {
      const cli = new KiroCliConnector({
        id: `kiro-cli-session-${sessionId.slice(0, 8)}`,
        ...config,
      });

      // 注册 Nova MCP Server（如果已启动）
      const mcpPort = (window as any).__novaMcpPort;
      if (mcpPort) {
        cli.registerMcpServer({
          type: "http",
          name: "nova-tools",
          url: `http://127.0.0.1:${mcpPort}/mcp`,
        });
      }
      return cli;
    }

    // API 类型：沿用 base 配置克隆一个独立实例（保留原 id，便于日志/回溯）
    return new OpenAIConnector({ ...baseConnector.config, ...config });
  }

  /**
   * 获取已有实例（不自动创建）。
   * 省略 connectorId 时返回该会话下的第一个实例。
   */
  get(sessionId: string, connectorId?: string): Connector | undefined {
    if (connectorId) {
      return this.pool.get(this.makeKey(sessionId, connectorId))?.connector;
    }
    return this.entriesOfSession(sessionId)[0]?.[1].connector;
  }

  /**
   * 标记实例为忙碌（正在处理 send 请求）。忙碌的实例不会被闲置清理。
   * 省略 connectorId 时作用于该会话下所有实例。
   */
  markBusy(sessionId: string, connectorId?: string): void {
    this.setBusy(sessionId, connectorId, true);
  }

  /**
   * 标记实例为空闲（send 请求完成）。
   * 省略 connectorId 时作用于该会话下所有实例。
   */
  markIdle(sessionId: string, connectorId?: string): void {
    this.setBusy(sessionId, connectorId, false);
  }

  private setBusy(sessionId: string, connectorId: string | undefined, busy: boolean): void {
    const now = Date.now();
    if (connectorId) {
      const meta = this.pool.get(this.makeKey(sessionId, connectorId));
      if (meta) {
        meta.busy = busy;
        meta.lastActiveAt = now;
      }
      return;
    }
    for (const [, meta] of this.entriesOfSession(sessionId)) {
      meta.busy = busy;
      meta.lastActiveAt = now;
    }
  }

  /**
   * 记录活跃度（每次与实例交互时调用）。
   * 省略 connectorId 时作用于该会话下所有实例。
   */
  touch(sessionId: string, connectorId?: string): void {
    const now = Date.now();
    if (connectorId) {
      const meta = this.pool.get(this.makeKey(sessionId, connectorId));
      if (meta) meta.lastActiveAt = now;
      return;
    }
    for (const [, meta] of this.entriesOfSession(sessionId)) {
      meta.lastActiveAt = now;
    }
  }

  /**
   * 创建临时实例（用于后台任务：记忆提取、摘要、蒸馏等）。
   * 调用方负责在使用完后调 dispose()。不进池、不受管理。
   */
  createTemporary(label?: string): KiroCliConnector {
    const id = `kiro-cli-temp-${label || Date.now()}`;
    logger.connector(`创建临时实例: ${id}`);
    return new KiroCliConnector({ id });
  }

  /**
   * 销毁会话的 connector 实例（会话关闭时调用）。
   * 省略 connectorId 时销毁该会话下所有实例。
   */
  async dispose(sessionId: string, connectorId?: string): Promise<void> {
    const targets: [string, InstanceMeta | undefined][] = connectorId
      ? [[this.makeKey(sessionId, connectorId), this.pool.get(this.makeKey(sessionId, connectorId))]]
      : this.entriesOfSession(sessionId);

    const tasks: Promise<void>[] = [];
    for (const [key, meta] of targets) {
      if (!meta) continue;
      this.pool.delete(key);
      logger.connector(`销毁会话实例: ${sessionId.slice(0, 8)} / ${meta.connectorId}`, {
        remainingInstances: this.pool.size,
        idleDurationMs: Date.now() - meta.lastActiveAt,
      });
      if (meta.connector.dispose) {
        tasks.push(
          meta.connector.dispose().catch((err: any) =>
            logger.error("CONNECTOR", `dispose 失败: ${err.message}`),
          ),
        );
      }
    }
    await Promise.all(tasks);
  }

  /**
   * 销毁所有实例（应用退出、HMR 时调用）。
   */
  async disposeAll(): Promise<void> {
    logger.connector(`销毁所有实例`, { count: this.pool.size });
    this.stopCleanupLoop();

    const tasks = Array.from(this.pool.values())
      .filter(meta => !!meta.connector.dispose)
      .map(meta =>
        meta.connector.dispose!().catch((err: any) =>
          logger.error("CONNECTOR", `dispose 失败: ${err.message}`),
        ),
      );
    await Promise.all(tasks);
    this.pool.clear();
  }

  /** 当前活跃实例总数 */
  get size(): number {
    return this.pool.size;
  }

  /** 当前持有子进程的实例数 */
  get processSize(): number {
    return this.processInstanceCount;
  }

  /**
   * 获取池状态快照（用于监控和 UI 展示）。
   */
  getPoolStats(): ProcessPoolStats {
    const now = Date.now();
    const instances = Array.from(this.pool.values()).map(meta => {
      const activeAt = this.effectiveActiveAt(meta);
      return {
        sessionId: meta.sessionId,
        connectorId: meta.connectorId,
        holdsProcess: meta.holdsProcess,
        createdAt: meta.createdAt,
        lastActiveAt: activeAt,
        idleDurationMs: now - activeAt,
        busy: meta.busy,
      };
    });

    return {
      totalInstances: this.pool.size,
      processInstances: this.processInstanceCount,
      busyInstances: instances.filter(i => i.busy).length,
      idleInstances: instances.filter(i => !i.busy).length,
      instances,
    };
  }

  /**
   * 检查指定会话是否有持进程的活跃实例。
   */
  hasActiveProcess(sessionId: string): boolean {
    return this.entriesOfSession(sessionId).some(([, meta]) => meta.holdsProcess);
  }

  /**
   * 获取所有有实例的会话 ID 列表（去重）。
   */
  getActiveSessionIds(): string[] {
    return Array.from(new Set(Array.from(this.pool.values()).map(m => m.sessionId)));
  }

  // ─── 内部：超时清理机制 ───

  /** 启动定期清理巡检循环 */
  private startCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleInstances();
    }, CLEANUP_INTERVAL_MS);
    logger.connector("实例池清理循环已启动", {
      intervalMs: CLEANUP_INTERVAL_MS,
      idleTimeoutMs: POOL_IDLE_TIMEOUT_MS,
    });
  }

  /** 停止清理循环 */
  private stopCleanupLoop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * 清理闲置实例。
   *
   * 闲置判定标准：
   * 1. 非 busy 状态（没有正在处理的请求）
   * 2. 有效活跃时间距今超过 POOL_IDLE_TIMEOUT_MS
   *
   * 两类实例都清理（避免池无界增长），持进程实例会真正 dispose 掉子进程。
   */
  private cleanupIdleInstances(): void {
    const now = Date.now();
    const toCleanup: string[] = [];

    for (const [key, meta] of this.pool) {
      if (meta.busy) continue; // 忙碌中的实例不清理
      if (now - this.effectiveActiveAt(meta) >= POOL_IDLE_TIMEOUT_MS) {
        toCleanup.push(key);
      }
    }

    if (toCleanup.length === 0) return;

    logger.idleKill(`清理巡检: 发现 ${toCleanup.length} 个闲置实例`, {
      totalInstances: this.pool.size,
      timeoutMs: POOL_IDLE_TIMEOUT_MS,
      keys: toCleanup,
    });

    // 异步清理，不阻塞巡检循环
    for (const key of toCleanup) {
      this.disposeIdle(key);
    }
  }

  /**
   * 清理单个闲置实例（内部方法）。
   * 与 dispose() 的区别：
   * - dispose() 是主动显式调用（用户关闭会话）
   * - disposeIdle() 是定时器触发的被动清理
   */
  private async disposeIdle(key: string): Promise<void> {
    const meta = this.pool.get(key);
    if (!meta) return;

    // 二次确认：取出时再检查一次是否仍然闲置（避免 race condition）
    if (meta.busy) {
      logger.idleKill(`跳过: 实例 ${key} 在清理前变为 busy`);
      return;
    }

    const idleDuration = Date.now() - this.effectiveActiveAt(meta);
    this.pool.delete(key);

    logger.idleKill(`释放闲置实例: ${meta.sessionId.slice(0, 8)} / ${meta.connectorId}`, {
      holdsProcess: meta.holdsProcess,
      idleDurationMs: idleDuration,
      idleDurationMin: Math.round(idleDuration / 60000),
      remainingInstances: this.pool.size,
    });

    if (!meta.connector.dispose) return;
    try {
      await meta.connector.dispose();
    } catch (err: any) {
      logger.error("IDLE_KILL", `dispose 失败: ${err.message}`, { key });
    }
  }

  /**
   * 驱逐最久未活跃的闲置「持进程」实例（进程配额满时调用）。
   * 只驱逐非 busy 的持进程实例；如果都 busy 则不驱逐。
   */
  private evictLeastActive(): void {
    let oldestKey: string | null = null;
    let oldestActiveAt = Infinity;

    for (const [key, meta] of this.pool) {
      if (!meta.holdsProcess) continue; // 只驱逐占进程配额的实例
      if (meta.busy) continue;          // 不驱逐忙碌实例
      const activeAt = this.effectiveActiveAt(meta);
      if (activeAt < oldestActiveAt) {
        oldestActiveAt = activeAt;
        oldestKey = key;
      }
    }

    if (!oldestKey) {
      logger.warn("CONNECTOR", "进程配额已满且持进程实例均 busy，无法驱逐", {
        processInstances: this.processInstanceCount,
        maxAllowed: MAX_ACTIVE_INSTANCES,
      });
      return;
    }

    const meta = this.pool.get(oldestKey);
    this.pool.delete(oldestKey);

    logger.idleKill(`配额满驱逐最久未活跃实例: ${oldestKey}`, {
      idleDurationMs: Date.now() - oldestActiveAt,
      processInstances: this.processInstanceCount,
    });

    // 异步 dispose，不阻塞当前 getOrCreate
    if (meta?.connector.dispose) {
      meta.connector.dispose().catch((err: any) =>
        logger.error("IDLE_KILL", `驱逐 dispose 失败: ${err.message}`),
      );
    }
  }
}

/** 全局单例 */
export const connectorInstances = new ConnectorInstanceManager();

// ─── HMR 热更新时清理 ───
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    logger.connector("HMR dispose: 清理所有实例");
    connectorInstances.disposeAll();
  });
}
