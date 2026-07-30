// ===== 通用调度引擎 — 类型定义 =====
//
// 为自动化运行提供底座：定时/闲置触发后台 job。
// V2 首个消费者是 auto-distill。后续可复用于其他定时任务。

/** 触发类型 */
export type TriggerKind = "interval" | "daily" | "idle" | "manual";

/** 触发配置 */
export type JobTrigger =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; at: string; everyDays?: number; weekday?: number } // at="23:30"; everyDays≥1(每N天); weekday=0..6(每周某天，设置后忽略 everyDays)
  | { kind: "idle"; afterMinutes: number }   // 会话闲置多久后触发
  | { kind: "manual" };

/** 上次运行状态 */
export type JobRunStatus = "success" | "failed" | "running" | "skipped";

/** 一个可调度 job */
export interface ScheduledJob {
  id: string;
  /** 显示名 */
  name: string;
  /** 处理器 key（对应已注册的 handler） */
  type: string;
  trigger: JobTrigger;
  /** 传给 handler 的参数 */
  payload?: any;
  enabled: boolean;
  createdAt: string;
  /** 上次运行时间 ISO */
  lastRun?: string;
  /** 下次预计运行时间 ISO（interval/daily 有效） */
  nextRun?: string;
  lastStatus?: JobRunStatus;
  /** 上次运行的简短结果/错误 */
  lastMessage?: string;
}

/** 运行历史记录 */
export interface JobRun {
  id: string;
  jobId: string;
  jobName: string;
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  message: string;
}

/** handler 返回结果 */
export interface JobHandlerResult {
  /** 是否成功 */
  ok: boolean;
  /** 简短说明（写入运行历史与 lastMessage） */
  message: string;
}

/** job 处理器 */
export type JobHandler = (job: ScheduledJob) => Promise<JobHandlerResult>;
