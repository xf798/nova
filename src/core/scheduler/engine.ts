// ===== 通用调度引擎 =====
//
// 前端单例（照抄 taskManager/pipelineEngine 范式）。
// 局限：应用关闭时不运行（V2 接受；后续如需常驻再上 Rust）。
//
// 触发类型：
// - interval：每 N 分钟
// - daily：每天固定 HH:MM
// - idle：会话闲置 N 分钟后（需 markActivity 喂活跃时间）
// - manual：仅手动 runNow
//
// 持久化：StorageService ns="scheduler"，key "jobs" / "runs"。

import { StorageService } from "../storage";
import type {
  JobHandler,
  JobRun,
  JobRunStatus,
  ScheduledJob,
} from "./types";

const NS = "scheduler";
const KEY_JOBS = "jobs";
const KEY_RUNS = "runs";

/** tick 间隔：每 30s 扫一遍到期 job */
const TICK_INTERVAL_MS = 30 * 1000;
/** 运行历史保留条数 */
const MAX_RUNS = 50;

type StateListener = (jobs: ScheduledJob[]) => void;

class SchedulerEngine {
  private storage = StorageService.getInstance();
  private jobs: ScheduledJob[] = [];
  private runs: JobRun[] = [];
  private handlers = new Map<string, JobHandler>();
  private running = new Set<string>(); // 并发锁：jobId
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<StateListener>();
  private loaded = false;
  /** 最近一次用户活跃时间（供 idle 触发判断） */
  private lastActivityAt = Date.now();
  /** 记录 idle job 上次因哪个活跃周期触发过，避免同一闲置期重复触发 */
  private idleFiredForActivity = new Map<string, number>();

  // ─── 生命周期 ───

  /** 初始化：加载持久化数据并启动 tick */
  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      this.jobs = (await this.storage.get<ScheduledJob[]>(NS, KEY_JOBS, [])) || [];
      this.runs = (await this.storage.get<JobRun[]>(NS, KEY_RUNS, [])) || [];
    } catch {
      this.jobs = [];
      this.runs = [];
    }
    this.loaded = true;
    this.startTick();
    console.log(`[Scheduler] init: jobs=${this.jobs.length}, runs=${this.runs.length}`);
  }

  /** 启动 tick 循环 */
  startTick(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    // 立即跑一次，避免等 30s
    setTimeout(() => this.tick(), 1000);
  }

  /** 停止 tick */
  stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // ─── 处理器注册 ───

  registerHandler(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
    console.log(`[Scheduler] handler 注册: ${type}`);
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  // ─── 活跃度（供 idle 触发） ───

  /** 标记用户活跃（每次发消息时调用）。会重置闲置计时 */
  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  // ─── job CRUD ───

  getJobs(): ScheduledJob[] {
    return [...this.jobs];
  }

  getRuns(jobId?: string): JobRun[] {
    return jobId ? this.runs.filter(r => r.jobId === jobId) : [...this.runs];
  }

  getJob(id: string): ScheduledJob | undefined {
    return this.jobs.find(j => j.id === id);
  }

  /** 新增/更新 job（按 id 覆盖） */
  async upsertJob(job: ScheduledJob): Promise<void> {
    const idx = this.jobs.findIndex(j => j.id === job.id);
    const withNext = { ...job, nextRun: this.computeNextRun(job) };
    if (idx >= 0) this.jobs[idx] = withNext;
    else this.jobs.push(withNext);
    await this.persistJobs();
    this.notify();
  }

  /** 便捷创建 */
  async createJob(input: Omit<ScheduledJob, "id" | "createdAt" | "nextRun">): Promise<ScheduledJob> {
    const job: ScheduledJob = {
      ...input,
      id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
    };
    job.nextRun = this.computeNextRun(job);
    this.jobs.push(job);
    await this.persistJobs();
    this.notify();
    return job;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return;
    job.enabled = enabled;
    job.nextRun = enabled ? this.computeNextRun(job) : undefined;
    await this.persistJobs();
    this.notify();
  }

  async removeJob(id: string): Promise<void> {
    this.jobs = this.jobs.filter(j => j.id !== id);
    await this.persistJobs();
    this.notify();
  }

  // ─── 手动运行 ───

  /** 立即运行指定 job（忽略触发条件） */
  async runNow(id: string): Promise<void> {
    const job = this.jobs.find(j => j.id === id);
    if (job) await this.runJob(job);
  }

  // ─── 订阅 ───

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ─── 内部：tick + 触发判定 ───

  private tick(): void {
    if (!this.loaded) return;
    const now = Date.now();
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (this.running.has(job.id)) continue;
      if (!this.handlers.has(job.type)) continue;
      if (this.isDue(job, now)) {
        this.runJob(job);
      }
    }
  }

  /** 判断 job 是否到期 */
  private isDue(job: ScheduledJob, now: number): boolean {
    switch (job.trigger.kind) {
      case "manual":
        return false;
      case "interval":
      case "daily": {
        if (!job.nextRun) return false;
        return now >= new Date(job.nextRun).getTime();
      }
      case "idle": {
        const idleMs = now - this.lastActivityAt;
        const thresholdMs = job.trigger.afterMinutes * 60 * 1000;
        if (idleMs < thresholdMs) return false;
        // 同一闲置周期只触发一次：以 lastActivityAt 为周期标识
        const firedAt = this.idleFiredForActivity.get(job.id);
        if (firedAt === this.lastActivityAt) return false;
        return true;
      }
    }
  }

  /** 计算下次运行时间 */
  private computeNextRun(job: ScheduledJob): string | undefined {
    const now = Date.now();
    switch (job.trigger.kind) {
      case "interval": {
        const base = job.lastRun ? new Date(job.lastRun).getTime() : now;
        return new Date(base + job.trigger.everyMinutes * 60 * 1000).toISOString();
      }
      case "daily": {
        const t = job.trigger;
        const [hh, mm] = t.at.split(":").map(n => parseInt(n, 10));
        const H = hh || 0, M = mm || 0;

        // 每周某天
        if (typeof t.weekday === "number") {
          const next = new Date();
          next.setHours(H, M, 0, 0);
          let add = (t.weekday - next.getDay() + 7) % 7;
          if (add === 0 && next.getTime() <= now) add = 7;
          next.setDate(next.getDate() + add);
          return next.toISOString();
        }

        // 每 N 天
        const everyDays = Math.max(1, t.everyDays || 1);
        if (job.lastRun) {
          const next = new Date(job.lastRun);
          next.setHours(H, M, 0, 0);
          next.setDate(next.getDate() + everyDays);
          while (next.getTime() <= now) next.setDate(next.getDate() + everyDays);
          return next.toISOString();
        }
        const next = new Date();
        next.setHours(H, M, 0, 0);
        if (next.getTime() <= now) next.setDate(next.getDate() + 1);
        return next.toISOString();
      }
      case "idle":
      case "manual":
        return undefined;
    }
  }

  /** 执行一个 job */
  private async runJob(job: ScheduledJob): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) return;
    if (this.running.has(job.id)) return;

    this.running.add(job.id);
    if (job.trigger.kind === "idle") {
      this.idleFiredForActivity.set(job.id, this.lastActivityAt);
    }
    const startedAt = Date.now();
    job.lastStatus = "running";
    this.notify();

    let status: JobRunStatus = "success";
    let message = "";
    try {
      const result = await handler(job);
      status = result.ok ? "success" : "failed";
      message = result.message;
    } catch (e: any) {
      status = "failed";
      message = e?.message || String(e);
      console.warn(`[Scheduler] job ${job.name} 执行异常:`, message);
    } finally {
      this.running.delete(job.id);
    }

    const finishedAt = Date.now();
    job.lastRun = new Date(finishedAt).toISOString();
    job.lastStatus = status;
    job.lastMessage = message;
    job.nextRun = this.computeNextRun(job);

    // 记录运行历史
    const run: JobRun = {
      id: `run-${finishedAt}-${Math.random().toString(36).slice(2, 5)}`,
      jobId: job.id,
      jobName: job.name,
      status,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
      message,
    };
    this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(0, MAX_RUNS);

    await this.persistJobs();
    await this.persistRuns();
    this.notify();
    console.log(`[Scheduler] job 完成: ${job.name} → ${status} (${run.durationMs}ms)`);
  }

  // ─── 持久化 ───

  private async persistJobs(): Promise<void> {
    try {
      await this.storage.set(NS, KEY_JOBS, this.jobs);
    } catch (e) {
      console.warn("[Scheduler] persist jobs 失败:", e);
    }
  }

  private async persistRuns(): Promise<void> {
    try {
      await this.storage.set(NS, KEY_RUNS, this.runs);
    } catch (e) {
      console.warn("[Scheduler] persist runs 失败:", e);
    }
  }

  private notify(): void {
    const snapshot = this.getJobs();
    for (const l of this.listeners) {
      try { l(snapshot); } catch {}
    }
  }
}

/** 全局单例 */
export const scheduler = new SchedulerEngine();

// HMR：热更新时停掉旧 timer
if (import.meta.hot) {
  import.meta.hot.dispose(() => scheduler.stopTick());
}
