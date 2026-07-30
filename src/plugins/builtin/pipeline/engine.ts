// ===== Pipeline Engine — E2E 自动化流水线状态机 =====
//
// v2: 增加阶段间文件自动复制 + TCHub 异步状态同步

import { Command } from "@tauri-apps/plugin-shell";
import type { PluginContext } from "../../context";
import type { KiroCliConnector } from "../../../connectors/builtin/kiro-cli";
import { connectorRegistry } from "../../../connectors/registry";
import { tchubClient } from "./tchub-client";
import type { WorkstreamStatus, WorkstreamStage } from "./tchub-client";

// ─── 类型定义 ───

export type StageId = "pm" | "ux" | "dev";
export type StageStatus = "pending" | "running" | "success" | "failed" | "blocked" | "skipped";
export type PipelineStatus = "idle" | "running" | "paused" | "completed" | "failed";
export type TCHubSyncStatus = "idle" | "syncing" | "synced" | "error";

export interface StageState {
  status: StageStatus;
  progress: number;       // 0-100
  output: string;         // 最终输出摘要
  error: string;          // 错误信息
  blockers: string[];     // 阻塞点
  artifacts: string[];    // 产出文件路径
  duration: number;       // 耗时(ms)
  startedAt?: string;
  filesCopied?: string[]; // 阶段完成后复制到下游的文件
}

export interface LogEntry {
  timestamp: string;
  stage: StageId | "system";
  level: "info" | "warn" | "error" | "success";
  message: string;
}

export interface PipelineConfig {
  prdPath: string;        // PRD 文件路径
  specName: string;       // spec 标识（英文 kebab-case）
  targetDir: string;      // 代码生成目标目录
  pmCwd: string;          // ai-pm-team 工作目录
  uxCwd: string;          // ai-ux-team 工作目录
  devCwd: string;         // ai-develop-team 工作目录
  // TCHub 集成（可选）
  workstreamId?: string;  // TCHub workstream 关联
  syncToTchub?: boolean;  // 是否自动同步状态（默认 true）
  // 阶段跳过配置
  skipStages?: StageId[]; // 要跳过的阶段列表
}

export interface PipelineState {
  id: string;
  config: PipelineConfig;
  status: PipelineStatus;
  currentStage: StageId | null;
  stages: Record<StageId, StageState>;
  logs: LogEntry[];
  startedAt?: string;
  completedAt?: string;
  // TCHub 同步状态
  tchubSync: TCHubSyncStatus;
  tchubLastSync?: string;
  // 用户决断请求
  pendingDecision?: {
    stage: StageId;
    message: string;
    options: { label: string; action: "retry" | "skip" | "continue" }[];
  };
}

// 运行历史记录（持久化用）
export interface PipelineRunStageRecord {
  status: StageStatus;
  duration: number;
  artifactCount: number;
  error?: string;
}

export interface PipelineRunRecord {
  id: string;
  status: PipelineStatus;
  config: {
    specName: string;
    targetDir: string;
    workstreamId?: string;
  };
  stages: Record<StageId, PipelineRunStageRecord>;
  startedAt: string;
  completedAt: string;
  totalDuration: number; // ms
}

type StateListener = (state: PipelineState) => void;

// ─── 默认配置 ───

const DEFAULT_CWD = "/Users/wangxf/workspace";
const DEFAULT_CONFIG: PipelineConfig = {
  prdPath: "",
  specName: "",
  targetDir: "",
  pmCwd: `${DEFAULT_CWD}/ai-pm-team`,
  uxCwd: `${DEFAULT_CWD}/ai-ux-team`,
  devCwd: `${DEFAULT_CWD}/ai-develop-team`,
  syncToTchub: true,
};

function createInitialStage(): StageState {
  return { status: "pending", progress: 0, output: "", error: "", blockers: [], artifacts: [], duration: 0 };
}

function createInitialState(): PipelineState {
  return {
    id: "",
    config: { ...DEFAULT_CONFIG },
    status: "idle",
    currentStage: null,
    stages: { pm: createInitialStage(), ux: createInitialStage(), dev: createInitialStage() },
    logs: [],
    tchubSync: "idle",
  };
}

// ─── Engine ───

export class PipelineEngine {
  private context: PluginContext | null = null;
  private state: PipelineState = createInitialState();
  private listeners: Set<StateListener> = new Set();
  private connectors: Map<StageId, KiroCliConnector> = new Map();
  private aborted = false;
  private paused = false;
  private pauseResolve: (() => void) | null = null;

  /** 初始化（由插件 activate 调用） */
  init(context: PluginContext): void {
    this.context = context;
    // 尝试恢复上次运行状态
    context.storage.get<PipelineState>("last_run").then(saved => {
      if (saved && saved.status !== "running") {
        this.state = saved;
        this.notify();
      }
    });
  }

  /** 释放 connector 资源（流水线完成/失败后调用） */
  private disposeConnectors(): void {
    for (const conn of this.connectors.values()) {
      connectorRegistry.unregister(conn.config.id);
      conn.dispose().catch(err => console.warn("[Pipeline] dispose connector 失败:", err));
    }
    this.connectors.clear();
    console.log("[Pipeline] connectors 已释放");
  }

  /** 销毁（插件 deactivate） */
  destroy(): void {
    this.aborted = true;
    for (const conn of this.connectors.values()) {
      connectorRegistry.unregister(conn.config.id);
      conn.abort();
    }
    this.connectors.clear();
    this.listeners.clear();
  }

  /** 订阅状态变更 */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 获取当前状态（快照） */
  getState(): PipelineState {
    return this.state;
  }

  // ─── 控制操作 ───

  /** 启动流水线（支持自动从 TCHub 拉取 auto_program workstream） */
  async start(config: PipelineConfig): Promise<void> {
    if (this.state.status === "running") return;

    this.aborted = false;
    this.paused = false;

    // 如果没有指定 prdPath，自动从 TCHub 拉取 auto_program workstream
    if (!config.prdPath) {
      const resolved = await this.resolveFromTCHub(config);
      if (!resolved) return; // resolveFromTCHub 内部已设置错误状态
      config = resolved;
    }

    this.state = {
      ...createInitialState(),
      id: `run-${Date.now()}`,
      config: { ...DEFAULT_CONFIG, ...config },
      status: "running",
      startedAt: new Date().toISOString(),
      tchubSync: config.workstreamId ? "idle" : "idle",
    };
    this.log("system", "info", `流水线启动: ${config.specName}`);
    this.notify();

    // TCHub: 同步启动状态
    if (config.workstreamId && config.syncToTchub !== false) {
      this.syncTCHub("design_active", "design", "流水线启动");
    }

    // 创建各工程的 connector
    this.connectors.set("pm", this.context!.createCliConnector({ id: "pipeline-pm", cwd: config.pmCwd }));
    this.connectors.set("ux", this.context!.createCliConnector({ id: "pipeline-ux", cwd: config.uxCwd }));
    this.connectors.set("dev", this.context!.createCliConnector({ id: "pipeline-dev", cwd: config.devCwd }));

    // 按顺序执行三个阶段
    const stages: StageId[] = ["pm", "ux", "dev"];
    for (const stage of stages) {
      if (this.aborted) break;
      await this.waitIfPaused();
      if (this.aborted) break;

      // 检查是否需要跳过该阶段
      if (config.skipStages?.includes(stage)) {
        this.state.stages[stage].status = "skipped";
        this.log("system", "info", `跳过阶段: ${this.getStageLabel(stage)}（配置跳过）`);
        this.notify();
        continue;
      }

      const success = await this.runStage(stage);
      if (!success && !this.aborted) {
        this.state.status = "failed";
        this.log("system", "error", `流水线失败于阶段: ${stage}`);

        // 请求用户决断
        this.state.pendingDecision = {
          stage,
          message: `阶段「${this.getStageLabel(stage)}」执行失败: ${this.state.stages[stage].error || "未知错误"}`,
          options: [
            { label: "重试", action: "retry" },
            { label: "跳过", action: "skip" },
          ],
        };

        // TCHub: 记录失败
        if (this.state.config.workstreamId && this.state.config.syncToTchub !== false) {
          this.syncTCHubNote(`阶段 ${stage} 失败`, this.state.stages[stage].error || "未知错误");
        }
        break;
      }

      // 阶段间文件复制
      if (success && !this.aborted) {
        await this.copyArtifactsToNext(stage);
      }
    }

    if (!this.aborted && this.state.status === "running") {
      this.state.status = "completed";
      this.state.completedAt = new Date().toISOString();
      this.log("system", "success", `流水线完成! 总耗时: ${this.getTotalDuration()}`);

      // TCHub: 同步完成状态
      if (this.state.config.workstreamId && this.state.config.syncToTchub !== false) {
        this.syncTCHub("implementation_active", "implementation", "流水线完成，代码已生成");
      }
    }

    this.notify();
    this.persist();
    this.context?.events.emit("pipeline:finished", this.state);

    // 流水线结束（完成或失败），释放 connector 资源
    this.disposeConnectors();
  }

  /** 暂停 */
  pause(): void {
    if (this.state.status !== "running") return;
    this.paused = true;
    this.state.status = "paused";
    this.log("system", "info", "流水线已暂停");
    this.notify();
  }

  /** 继续 */
  resume(): void {
    if (this.state.status !== "paused") return;
    this.paused = false;
    this.state.status = "running";
    this.state.pendingDecision = undefined;
    this.log("system", "info", "流水线继续");
    this.notify();
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  /** 停止 */
  stop(): void {
    this.aborted = true;
    this.paused = false;
    // 中止当前连接器
    if (this.state.currentStage) {
      this.connectors.get(this.state.currentStage)?.abort();
    }
    this.state.status = "failed";
    this.state.pendingDecision = undefined;
    this.log("system", "warn", "流水线已停止");
    this.notify();
    this.persist();
    // 释放 pause 锁
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  /** 重试当前/最后失败的阶段 */
  async retry(): Promise<void> {
    const failedStage = this.findFailedStage();
    if (!failedStage) return;

    this.aborted = false;
    this.paused = false;
    this.state.status = "running";
    this.state.stages[failedStage] = createInitialStage();
    this.state.pendingDecision = undefined;
    this.log("system", "info", `重试阶段: ${failedStage}`);
    this.notify();

    const success = await this.runStage(failedStage);

    if (success) {
      // 文件复制
      await this.copyArtifactsToNext(failedStage);

      // 继续后续阶段
      const stages: StageId[] = ["pm", "ux", "dev"];
      const idx = stages.indexOf(failedStage);
      for (let i = idx + 1; i < stages.length; i++) {
        if (this.aborted) break;
        await this.waitIfPaused();
        if (this.aborted) break;
        const ok = await this.runStage(stages[i]);
        if (!ok) break;
        if (ok) await this.copyArtifactsToNext(stages[i]);
      }
      if (!this.aborted && this.state.status === "running") {
        this.state.status = "completed";
        this.state.completedAt = new Date().toISOString();
        this.log("system", "success", "流水线完成!");

        if (this.state.config.workstreamId && this.state.config.syncToTchub !== false) {
          this.syncTCHub("implementation_active", "implementation", "流水线完成");
        }
      }
    } else {
      this.state.status = "failed";
      this.state.pendingDecision = {
        stage: failedStage,
        message: `重试后仍然失败: ${this.state.stages[failedStage].error || "未知错误"}`,
        options: [
          { label: "再次重试", action: "retry" },
          { label: "跳过", action: "skip" },
        ],
      };
    }

    this.notify();
    this.persist();
  }

  /** 跳过当前失败/阻塞的阶段 */
  async skip(): Promise<void> {
    const failedStage = this.findFailedStage() || this.state.currentStage;
    if (!failedStage) return;
    this.state.stages[failedStage].status = "skipped";
    this.state.pendingDecision = undefined;
    this.log("system", "warn", `跳过阶段: ${failedStage}`);
    this.notify();

    // 继续执行后续阶段
    this.aborted = false;
    this.paused = false;
    this.state.status = "running";

    const stages: StageId[] = ["pm", "ux", "dev"];
    const idx = stages.indexOf(failedStage);
    for (let i = idx + 1; i < stages.length; i++) {
      if (this.aborted) break;
      await this.waitIfPaused();
      if (this.aborted) break;
      const ok = await this.runStage(stages[i]);
      if (!ok) break;
      if (ok) await this.copyArtifactsToNext(stages[i]);
    }
    if (!this.aborted && this.state.status === "running") {
      this.state.status = "completed";
      this.state.completedAt = new Date().toISOString();
      this.log("system", "success", "流水线完成!");
    }
    this.notify();
    this.persist();
  }

  /** 重置为初始状态 */
  reset(): void {
    this.aborted = true;
    for (const conn of this.connectors.values()) {
      connectorRegistry.unregister(conn.config.id);
      conn.abort();
    }
    this.connectors.clear();
    this.state = createInitialState();
    this.notify();
  }

  /** 用户决断响应 */
  resolveDecision(action: "retry" | "skip" | "continue"): void {
    if (!this.state.pendingDecision) return;
    switch (action) {
      case "retry":
        this.retry();
        break;
      case "skip":
        this.skip();
        break;
      case "continue":
        this.resume();
        break;
    }
  }

  // ─── 阶段间文件复制 ───

  /** PM 完成后复制 PRD-IR 到 UX，UX 完成后复制 handoff 到 Dev */
  private async copyArtifactsToNext(stage: StageId): Promise<void> {
    const { specName, pmCwd, uxCwd, devCwd } = this.state.config;
    if (!specName) return;

    try {
      if (stage === "pm") {
        // PM → UX: 复制 PRD-IR 到 UX 的 product/designs/{specName}/
        const destDir = `${uxCwd}/product/designs/${specName}`;
        // 先在 specName 对应的子目录中精确查找，找不到则全局按时间取最新
        const findCmd = Command.create("sh", [
          "-c",
          `find "${pmCwd}/product-specs/${specName}" -name "*.prd-ir.json" 2>/dev/null | head -1 || find "${pmCwd}/product-specs" -name "*.prd-ir.json" -newer "${pmCwd}/product-specs/${specName}/prd-from-tchub.md" 2>/dev/null | head -1 || find "${pmCwd}/product-specs" -name "*.prd-ir.json" -not -name ".prd-ir.json" | sort | tail -1`,
        ]);
        const findResult = await findCmd.execute();
        const prdIrPath = findResult.stdout?.trim();

        if (prdIrPath) {
          const cpCmd = Command.create("sh", [
            "-c",
            `mkdir -p "${destDir}" && cp "${prdIrPath}" "${destDir}/${specName}.prd-ir.json"`,
          ]);
          await cpCmd.execute();
          this.state.stages.pm.filesCopied = [`${destDir}/${specName}.prd-ir.json`];
          this.log("system", "info", `PRD-IR 已复制到 UX 工程: ${specName}.prd-ir.json`);
        }

        // 异步上传 PRD-IR 到 TCHub
        if (this.state.config.workstreamId && this.state.config.syncToTchub !== false && prdIrPath) {
          this.syncTCHub("product_complete", "product", "PRD-IR 生成完成");
          this.uploadToTCHub(prdIrPath, `${specName}-PRD-IR`, "prd", "product");
        }
      } else if (stage === "ux") {
        // UX → Dev: 复制整个 designs/{specName}/ 产出到 Dev 的 handoff-input/
        const srcDir = `${uxCwd}/product/designs/${specName}`;
        const destDir = `${devCwd}/handoff-input`;
        const cpCmd = Command.create("sh", [
          "-c",
          `mkdir -p "${destDir}" && cp "${srcDir}"/${specName}.* "${destDir}/" 2>/dev/null; cp "${srcDir}"/*.md "${destDir}/" 2>/dev/null; true`,
        ]);
        await cpCmd.execute();

        // 列出复制了哪些文件
        const lsCmd = Command.create("sh", ["-c", `ls "${destDir}/${specName}"* 2>/dev/null`]);
        const lsResult = await lsCmd.execute();
        const copied = lsResult.stdout?.trim().split("\n").filter(Boolean) || [];
        this.state.stages.ux.filesCopied = copied;
        this.log("system", "info", `设计产出已复制到 Dev 工程: ${copied.length} 个文件`);

        // 异步上传 handoff 到 TCHub
        if (this.state.config.workstreamId && this.state.config.syncToTchub !== false) {
          this.syncTCHub("design_complete", "design", "设计完成，handoff 已生成");
          const handoffPath = `${srcDir}/${specName}.handoff.json`;
          this.uploadToTCHub(handoffPath, `${specName}-Handoff`, "ux_spec", "design");
        }
      }
      // dev 阶段完成后不需要复制（终点）
    } catch (err: any) {
      this.log("system", "warn", `文件复制警告: ${err.message}`);
    }
    this.notify();
  }

  // ─── 自动从 TCHub 拉取 auto_program workstream ───

  /** 从 TCHub 自动找到 auto_program workstream，下载 PRD，填充 config */
  private async resolveFromTCHub(config: PipelineConfig): Promise<PipelineConfig | null> {
    this.state = {
      ...createInitialState(),
      id: `run-${Date.now()}`,
      config: { ...DEFAULT_CONFIG, ...config },
      status: "running",
      startedAt: new Date().toISOString(),
      tchubSync: "syncing",
    };
    this.log("system", "info", "从 TCHub 拉取 auto_program workstream...");
    this.notify();

    // 1. 列出所有 auto_program workstream
    const listResult = await tchubClient.listAutoProgramWorkstreams();
    if (!listResult.ok || !listResult.data?.length) {
      this.state.status = "failed";
      this.log("system", "error", `未找到 auto_program workstream: ${listResult.error || "列表为空"}`);
      this.notify();
      return null;
    }

    // 2. 选择目标 workstream（如果指定了 specName 则匹配，否则取第一个）
    const workstreams = listResult.data;
    let target = workstreams[0];
    if (config.specName) {
      const matched = workstreams.find(
        (ws: any) => ws.slug?.includes(config.specName) || ws.name?.includes(config.specName)
      );
      if (matched) target = matched;
    }

    this.log("system", "info", `目标 workstream: ${target.name} (${target.id})`);

    // 3. 下载 PRD 到本地临时文件
    const specName = config.specName || target.slug || target.name.replace(/\s+/g, "-").toLowerCase();
    const prdPath = `${config.pmCwd || DEFAULT_CONFIG.pmCwd}/product-specs/${specName}/prd-from-tchub.md`;

    const downloadResult = await tchubClient.downloadPRD(target.id, prdPath);
    if (!downloadResult.ok) {
      this.state.status = "failed";
      this.log("system", "error", `下载 PRD 失败: ${downloadResult.error}`);
      this.notify();
      return null;
    }

    this.log("system", "success", `PRD 已下载: ${downloadResult.data.title} → ${prdPath}`);
    this.state.tchubSync = "synced";
    this.notify();

    // 4. 返回填充后的 config
    return {
      ...DEFAULT_CONFIG,
      ...config,
      prdPath,
      specName,
      workstreamId: target.id,
      syncToTchub: config.syncToTchub !== false,
    };
  }

  // ─── TCHub 异步同步（不阻塞主流程） ───

  private async syncTCHub(status: WorkstreamStatus, stage: WorkstreamStage, message: string): Promise<void> {
    const { workstreamId } = this.state.config;
    if (!workstreamId) return;

    this.state.tchubSync = "syncing";
    this.notify();

    try {
      const result = await tchubClient.updateWorkstreamStatus(workstreamId, status, stage);
      if (result.ok) {
        this.state.tchubSync = "synced";
        this.state.tchubLastSync = new Date().toISOString();
        this.log("system", "info", `TCHub 同步: ${message}`);
      } else {
        this.state.tchubSync = "error";
        this.log("system", "warn", `TCHub 同步失败: ${result.error}`);
      }
    } catch {
      this.state.tchubSync = "error";
    }
    this.notify();
  }

  private async syncTCHubNote(title: string, content: string): Promise<void> {
    const { workstreamId } = this.state.config;
    if (!workstreamId) return;
    try {
      await tchubClient.recordNote(workstreamId, title, content, "progress", ["pipeline", "error"]);
    } catch {}
  }

  private async uploadToTCHub(filePath: string, title: string, docType: string, stage: WorkstreamStage): Promise<void> {
    const { workstreamId } = this.state.config;
    if (!workstreamId) return;
    try {
      const result = await tchubClient.uploadDocument(workstreamId, filePath, title, docType, stage);
      if (result.ok) {
        this.log("system", "info", `已上传到 TCHub: ${title}`);
      } else {
        this.log("system", "warn", `TCHub 上传失败: ${result.error}`);
      }
    } catch {}
  }

  // ─── 内部逻辑 ───

  private async runStage(stage: StageId): Promise<boolean> {
    const stageState = this.state.stages[stage];
    stageState.status = "running";
    stageState.startedAt = new Date().toISOString();
    this.state.currentStage = stage;
    this.notify();

    const startTime = Date.now();
    const stageLabel = this.getStageLabel(stage);
    this.log(stage, "info", `开始: ${stageLabel}`);

    try {
      const prompt = this.buildPrompt(stage);
      const connector = this.connectors.get(stage)!;

      const result = await connector.send(
        prompt,
        { cwd: this.state.config[`${stage}Cwd` as keyof PipelineConfig] as string },
        (chunk) => {
          // 流式更新进度（简单估算）
          stageState.progress = Math.min(95, stageState.progress + 1);
          stageState.output = chunk;
          this.notify();
        }
      );

      stageState.duration = Date.now() - startTime;
      stageState.output = result.content;
      stageState.progress = 100;

      // 检查输出是否包含错误标记
      const blockers = this.detectBlockers(result.content);
      if (blockers.length > 0) {
        stageState.blockers = blockers;
        this.log(stage, "warn", `发现 ${blockers.length} 个阻塞点`);
      }

      // 判断是否成功（基于输出内容）
      if (result.content.includes("⚠️") && result.content.includes("失败")) {
        stageState.status = "failed";
        stageState.error = "阶段执行出错";
        this.log(stage, "error", `失败: ${stageLabel}`);
        return false;
      }

      stageState.status = "success";
      this.log(stage, "success", `完成: ${stageLabel} (${(stageState.duration / 1000).toFixed(1)}s)`);

      // 提取产出文件路径
      stageState.artifacts = this.extractArtifacts(stage, result.content);

      this.notify();
      return true;
    } catch (err: any) {
      stageState.duration = Date.now() - startTime;
      stageState.status = "failed";
      stageState.error = err.message || "未知错误";
      stageState.progress = 0;
      this.log(stage, "error", `异常: ${err.message}`);
      this.notify();
      return false;
    }
  }

  private buildPrompt(stage: StageId): string {
    const { prdPath, specName, targetDir } = this.state.config;

    switch (stage) {
      case "pm":
        return `生成 PRD-IR：${prdPath}`;
      case "ux":
        return `消费 PRD-IR：product/designs/${specName}/${specName}.prd-ir.json ，执行完整的设计流水线生成所有产出物`;
      case "dev":
        return `消费 handoff：handoff-input/${specName}.handoff.json，代码生成目标目录为 ${targetDir}，生成 Demo 级别代码即可，不需要跑测试`;
    }
  }

  private getStageLabel(stage: StageId): string {
    const labels: Record<StageId, string> = { pm: "PRD-IR 生成", ux: "设计产出", dev: "代码生成" };
    return labels[stage];
  }

  private detectBlockers(output: string): string[] {
    const blockers: string[] = [];
    const patterns = [
      /组件缺口[：:]\s*(.+)/g,
      /blocked[：:]\s*(.+)/gi,
      /阻塞[：:]\s*(.+)/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(output)) !== null) {
        blockers.push(match[1].trim().slice(0, 100));
      }
    }
    return blockers;
  }

  private extractArtifacts(_stage: StageId, output: string): string[] {
    const artifacts: string[] = [];
    const pathPattern = /(?:product\/designs\/|src\/pages\/|handoff-input\/)[^\s)]+\.(json|md|tsx)/g;
    let match;
    while ((match = pathPattern.exec(output)) !== null) {
      artifacts.push(match[0]);
    }
    return artifacts;
  }

  private findFailedStage(): StageId | null {
    const stages: StageId[] = ["pm", "ux", "dev"];
    return stages.find(s => this.state.stages[s].status === "failed" || this.state.stages[s].status === "blocked") || null;
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>(resolve => {
      this.pauseResolve = resolve;
    });
  }

  private getTotalDuration(): string {
    const total = Object.values(this.state.stages).reduce((sum, s) => sum + s.duration, 0);
    const secs = Math.round(total / 1000);
    return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  }

  private log(stage: StageId | "system", level: LogEntry["level"], message: string): void {
    this.state.logs.push({
      timestamp: new Date().toISOString(),
      stage,
      level,
      message,
    });
    if (this.state.logs.length > 200) {
      this.state.logs = this.state.logs.slice(-200);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(this.state); } catch {}
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.context?.storage.set("last_run", this.state);
    } catch {}

    // 运行历史持久化（完成/失败时写入）
    if (this.state.status === "completed" || this.state.status === "failed") {
      await this.persistRunHistory();
    }
  }

  /** 运行历史持久化到 ~/.nova/data/pipeline-runs.json */
  private async persistRunHistory(): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const filePath = `${DEFAULT_CWD.replace("/workspace", "")}/.nova/data/pipeline-runs.json`;

      // 读取现有历史
      let runs: PipelineRunRecord[] = [];
      try {
        const raw = await invoke<string>("tool_file_read", { path: filePath, offset: null, limit: null });
        // tool_file_read adds line numbers, strip them
        const content = raw.replace(/^\s*\d+\| /gm, "");
        runs = JSON.parse(content);
      } catch {}

      // 构造运行记录
      const record: PipelineRunRecord = {
        id: this.state.id,
        status: this.state.status,
        config: {
          specName: this.state.config.specName,
          targetDir: this.state.config.targetDir,
          workstreamId: this.state.config.workstreamId,
        },
        stages: Object.fromEntries(
          Object.entries(this.state.stages).map(([k, v]) => [k, {
            status: v.status,
            duration: v.duration,
            artifactCount: v.artifacts.length,
            error: v.error || undefined,
          }])
        ) as Record<StageId, PipelineRunStageRecord>,
        startedAt: this.state.startedAt!,
        completedAt: this.state.completedAt || new Date().toISOString(),
        totalDuration: Object.values(this.state.stages).reduce((sum, s) => sum + s.duration, 0),
      };

      // 添加到头部，保留最近 20 条
      runs.unshift(record);
      if (runs.length > 20) runs = runs.slice(0, 20);

      await invoke("tool_file_write", { path: filePath, content: JSON.stringify(runs, null, 2) });
      console.log(`[Pipeline] 运行历史已保存: ${record.id}`);
    } catch (err: any) {
      console.warn("[Pipeline] 持久化运行历史失败:", err.message);
    }
  }

  /** 读取运行历史 */
  async getRunHistory(): Promise<PipelineRunRecord[]> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const filePath = `${DEFAULT_CWD.replace("/workspace", "")}/.nova/data/pipeline-runs.json`;
      const raw = await invoke<string>("tool_file_read", { path: filePath, offset: null, limit: null });
      const content = raw.replace(/^\s*\d+\| /gm, "");
      return JSON.parse(content);
    } catch {
      return [];
    }
  }
}

// 单例
export const pipelineEngine = new PipelineEngine();
