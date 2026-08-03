// ===== 可执行 Playbook — 执行引擎 =====
//
// PlaybookRunner：半自动逐步执行引擎。
// 1. start() → 开专属会话，注入开场参数上下文
// 2. runNextStep() → 执行下一步（构造指令 → sendMessage → 拿产出）
// 3. confirmAndRun() → confirm 步骤确认后执行
// 4. retry() → 重试失败步骤
// 5. skip() → 跳过当前步骤
// 6. abort() → 中止运行
//
// 每步执行完暂停（status=paused），UI 展示产出，用户点「下一步」继续。

import { sendMessage } from "../sendMessage";
import { useSessionStore } from "../sessionStore";
import type { Connector } from "../../connectors/base";
import { playbookStore } from "./store";
import { replaceParams, buildParamContext } from "./parser";
import type {
  Playbook,
  PlaybookRun,
  PlaybookRunStatus,
  StepResult,
  StepRunStatus,
} from "./types";

/** 生成运行 ID */
function genRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Runner 事件 */
export type RunnerEvent =
  | { type: "status_change"; run: PlaybookRun }
  | { type: "step_start"; stepIndex: number; stepId: string }
  | { type: "step_output"; stepIndex: number; chunk: string }
  | { type: "step_complete"; stepIndex: number; result: StepResult }
  | { type: "run_complete"; run: PlaybookRun }
  | { type: "confirm_required"; stepIndex: number; stepTitle: string };

export type RunnerEventListener = (event: RunnerEvent) => void;

class PlaybookRunner {
  /** 当前活跃的运行实例 */
  private activeRun: PlaybookRun | null = null;
  /** 当前 playbook 定义 */
  private playbook: Playbook | null = null;
  /** 使用的连接器 */
  private connector: Connector | null = null;
  /** 事件监听器 */
  private listeners = new Set<RunnerEventListener>();
  /** 中止标记 */
  private aborted = false;

  // ─── 公开接口 ───

  /**
   * 启动 Playbook 重放。
   *
   * 1. 创建专属会话
   * 2. 注入 Level 1 开场参数上下文
   * 3. 返回 PlaybookRun（status=paused，等待用户点第一步）
   */
  async start(
    playbookId: string,
    params: Record<string, string>,
    connector: Connector,
  ): Promise<PlaybookRun> {
    const playbook = await playbookStore.getById(playbookId);
    if (!playbook) throw new Error(`Playbook not found: ${playbookId}`);

    this.playbook = playbook;
    this.connector = connector;
    this.aborted = false;

    // 创建专属会话
    const sessionStore = useSessionStore.getState();
    const sessionId = sessionStore.createSession({
      id: `playbook_${Date.now().toString(36)}`,
      title: `▶ ${playbook.displayName}`,
      connectorId: connector.config.id,
      connectorSessionId: null,
    });

    // 注入 Level 1 开场参数上下文
    const paramContext = buildParamContext(playbook, params);
    const openingMessage = [
      `你正在执行 Playbook「${playbook.displayName}」。`,
      `${playbook.description}`,
      ``,
      paramContext,
      ``,
      `请按照我接下来发送的每个步骤指令依次执行。每步执行完后回复执行结果。`,
    ].join("\n");

    // 将开场上下文作为 system 消息注入会话
    sessionStore.updateMessages(sessionId, (msgs) => [
      ...msgs,
      {
        id: `sys_${Date.now()}`,
        role: "system" as const,
        content: openingMessage,
        timestamp: new Date().toISOString(),
      },
    ]);

    // 创建运行实例
    const run: PlaybookRun = {
      id: genRunId(),
      playbookId,
      params,
      status: "paused",
      currentStepIndex: 0,
      stepResults: [],
      sessionId,
      startedAt: new Date().toISOString(),
    };

    this.activeRun = run;
    await playbookStore.saveRun(run);
    this.emit({ type: "status_change", run });

    return run;
  }

  /**
   * 执行下一步。
   *
   * 如果当前步骤是 confirm 类型，会先发出 confirm_required 事件，
   * 等待调用 confirmAndRun() 确认后才执行。
   */
  async runNextStep(): Promise<StepResult | null> {
    if (!this.activeRun || !this.playbook || !this.connector) {
      throw new Error("No active playbook run");
    }

    const { currentStepIndex } = this.activeRun;
    const step = this.playbook.steps[currentStepIndex];
    if (!step) {
      // 所有步骤执行完毕
      await this.markComplete();
      return null;
    }

    // confirm 步骤：先发事件，等确认
    if (step.kind === "confirm") {
      this.updateStatus("confirming");
      this.emit({ type: "confirm_required", stepIndex: currentStepIndex, stepTitle: step.title });
      return null;
    }

    return this.executeStep(currentStepIndex);
  }

  /**
   * confirm 步骤确认后执行
   */
  async confirmAndRun(): Promise<StepResult | null> {
    if (!this.activeRun || this.activeRun.status !== "confirming") {
      throw new Error("No step awaiting confirmation");
    }
    return this.executeStep(this.activeRun.currentStepIndex);
  }

  /**
   * 重试失败步骤
   */
  async retry(): Promise<StepResult | null> {
    if (!this.activeRun || this.activeRun.status !== "failed") {
      throw new Error("No failed step to retry");
    }
    return this.executeStep(this.activeRun.currentStepIndex);
  }

  /**
   * 跳过当前步骤
   */
  async skip(): Promise<void> {
    if (!this.activeRun || !this.playbook) return;

    const { currentStepIndex } = this.activeRun;
    const step = this.playbook.steps[currentStepIndex];
    if (!step) return;

    const result: StepResult = {
      stepId: step.id,
      status: "skipped",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    this.activeRun.stepResults[currentStepIndex] = result;
    this.activeRun.currentStepIndex++;
    this.emit({ type: "step_complete", stepIndex: currentStepIndex, result });

    // 检查是否全部完成
    if (this.activeRun.currentStepIndex >= this.playbook.steps.length) {
      await this.markComplete();
    } else {
      this.updateStatus("paused");
    }
  }

  /**
   * 中止运行
   */
  async abort(): Promise<void> {
    if (!this.activeRun) return;
    this.aborted = true;
    this.updateStatus("aborted");
    this.activeRun.completedAt = new Date().toISOString();
    await playbookStore.saveRun(this.activeRun);
    this.emit({ type: "run_complete", run: this.activeRun });
  }

  /** 获取当前运行 */
  getActiveRun(): PlaybookRun | null {
    return this.activeRun;
  }

  /** 获取当前 playbook */
  getPlaybook(): Playbook | null {
    return this.playbook;
  }

  /** 是否有活跃运行 */
  isRunning(): boolean {
    return this.activeRun !== null &&
      !["completed", "aborted"].includes(this.activeRun.status);
  }

  // ─── 事件 ───

  subscribe(listener: RunnerEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: RunnerEvent): void {
    for (const fn of this.listeners) {
      try { fn(event); } catch {}
    }
  }

  // ─── 内部 ───

  /**
   * 执行指定步骤
   */
  private async executeStep(stepIndex: number): Promise<StepResult> {
    if (!this.activeRun || !this.playbook || !this.connector) {
      throw new Error("No active run");
    }

    const step = this.playbook.steps[stepIndex];
    const startedAt = new Date().toISOString();

    this.updateStatus("running");
    this.emit({ type: "step_start", stepIndex, stepId: step.id });

    // Level 2: 参数替换
    const detail = replaceParams(step.detail, this.activeRun.params);

    // 构造步骤指令
    const instruction = this.buildStepInstruction(step.title, detail, step.hint);

    let output = "";
    let status: StepRunStatus = "success";
    let error: string | undefined;

    try {
      // 发送给 agent 执行
      const sessionStore = useSessionStore.getState();
      const session = sessionStore.sessions.find(s => s.id === this.activeRun!.sessionId);
      const sessionMessages = session?.messages || [];

      const result = await sendMessage(
        {
          input: instruction,
          connector: this.connector,
          sessionId: this.activeRun.sessionId,
          sessionMessages,
          sessionMemory: session?.memory,
        },
        // onChunk — 流式输出
        (chunk) => {
          output += chunk;
          this.emit({ type: "step_output", stepIndex, chunk });
        },
      );

      // 更新 output 为完整内容
      output = result.content;

      // 检查是否被中止
      if (this.aborted) {
        status = "failed";
        error = "Aborted by user";
      }

      // 将 assistant 回复更新到会话
      sessionStore.updateMessages(this.activeRun.sessionId, (msgs) => [
        ...msgs,
        {
          id: `user_step_${stepIndex}_${Date.now()}`,
          role: "user" as const,
          content: instruction,
          timestamp: startedAt,
        },
        {
          id: `asst_step_${stepIndex}_${Date.now()}`,
          role: "assistant" as const,
          content: output,
          timestamp: new Date().toISOString(),
          meta: result.meta,
        },
      ]);
    } catch (e: any) {
      status = "failed";
      error = e?.message || String(e);
      console.error(`[PlaybookRunner] step ${stepIndex} failed:`, e);
    }

    const stepResult: StepResult = {
      stepId: step.id,
      status,
      output,
      error,
      startedAt,
      completedAt: new Date().toISOString(),
    };

    // 更新运行状态
    this.activeRun.stepResults[stepIndex] = stepResult;
    this.emit({ type: "step_complete", stepIndex, result: stepResult });

    if (status === "failed") {
      this.updateStatus("failed");
    } else {
      // 推进到下一步
      this.activeRun.currentStepIndex = stepIndex + 1;
      if (this.activeRun.currentStepIndex >= this.playbook.steps.length) {
        await this.markComplete();
      } else {
        this.updateStatus("paused");
      }
    }

    await playbookStore.saveRun(this.activeRun);
    return stepResult;
  }

  /** 构建步骤指令 */
  private buildStepInstruction(title: string, detail: string, hint?: { expectTool?: string; successCriteria?: string }): string {
    const parts: string[] = [
      `## 步骤：${title}`,
      "",
      detail,
    ];

    if (hint?.expectTool) {
      parts.push("", `提示：本步骤期望使用工具 \`${hint.expectTool}\``);
    }
    if (hint?.successCriteria) {
      parts.push("", `成功判据：${hint.successCriteria}`);
    }

    parts.push("", "执行完成后，请简要汇报执行结果。");
    return parts.join("\n");
  }

  /** 标记运行完成 */
  private async markComplete(): Promise<void> {
    if (!this.activeRun) return;
    this.updateStatus("completed");
    this.activeRun.completedAt = new Date().toISOString();
    await playbookStore.saveRun(this.activeRun);
    this.emit({ type: "run_complete", run: this.activeRun });
  }

  /** 更新状态 */
  private updateStatus(status: PlaybookRunStatus): void {
    if (!this.activeRun) return;
    this.activeRun.status = status;
    this.emit({ type: "status_change", run: this.activeRun });
  }
}

/** 全局单例 */
export const playbookRunner = new PlaybookRunner();
