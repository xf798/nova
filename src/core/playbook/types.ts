// ===== 可执行 Playbook — 类型定义 =====
//
// Playbook = 有序可复现的多步操作流程。
// 引擎通用化，场景无关：任何 Playbook = 有序步骤；执行 = 逐步把步骤说明交给 agent 跑。

/** 参数类型 */
export type PlaybookParamType = "string" | "enum" | "path" | "boolean";

/** 步骤类型 */
export type PlaybookStepKind = "auto" | "confirm";

/** 运行状态 */
export type PlaybookRunStatus =
  | "idle"        // 尚未开始
  | "running"     // 正在执行某步
  | "paused"      // 执行完一步，等待用户点下一步
  | "confirming"  // confirm 步骤，等待用户确认
  | "completed"   // 全部步骤执行完毕
  | "aborted"     // 用户中止
  | "failed";     // 步骤失败暂停

/** 单步运行状态 */
export type StepRunStatus =
  | "pending"     // 待执行
  | "running"     // 执行中
  | "success"     // 成功
  | "failed"      // 失败
  | "skipped";    // 跳过

/** Playbook 声明参数 */
export interface PlaybookParam {
  /** 参数 key，用于 {{key}} 替换 */
  key: string;
  /** 显示标签 */
  label: string;
  /** 参数类型 */
  type: PlaybookParamType;
  /** 是否必填 */
  required: boolean;
  /** 默认值 */
  default?: string;
  /** enum 类型的选项列表 */
  options?: string[];
  /** 参数说明 */
  description?: string;
}

/** Playbook 步骤定义 */
export interface PlaybookStep {
  /** 步骤 ID */
  id: string;
  /** 步骤标题 */
  title: string;
  /** 注入 agent 的指令原文，可含 {{key}} 占位 */
  detail: string;
  /** 步骤类型：auto=直接执行，confirm=执行前人工确认 */
  kind: PlaybookStepKind;
  /** 可选提示 */
  hint?: {
    /** 期望调用的工具 */
    expectTool?: string;
    /** 成功判据 */
    successCriteria?: string;
  };
}

/** Playbook 定义（持久化到 playbooks.json） */
export interface Playbook {
  /** 唯一 ID */
  id: string;
  /** 关联 SKILL.md 的 name（kebab-case） */
  name: string;
  /** 显示名称 */
  displayName: string;
  /** 描述 */
  description: string;
  /** 声明入参 */
  params: PlaybookParam[];
  /** 有序步骤 */
  steps: PlaybookStep[];
  /** 派生自哪个 skill（name） */
  sourceSkill?: string;
  /** 参数预设组合 */
  presets?: PlaybookPreset[];
  createdAt: string;
  updatedAt: string;
}

/** 参数预设：常用参数组合 */
export interface PlaybookPreset {
  /** 预设名称 */
  name: string;
  /** 参数值映射 */
  values: Record<string, string>;
}

// ─── 运行时类型 ───

/** 单步执行结果 */
export interface StepResult {
  stepId: string;
  status: StepRunStatus;
  /** agent 产出内容 */
  output?: string;
  /** 错误信息 */
  error?: string;
  startedAt: string;
  completedAt?: string;
}

/** 一次 Playbook 运行实例 */
export interface PlaybookRun {
  /** 运行 ID */
  id: string;
  /** 对应 Playbook ID */
  playbookId: string;
  /** 本次运行的参数值 */
  params: Record<string, string>;
  /** 运行状态 */
  status: PlaybookRunStatus;
  /** 当前步骤索引 */
  currentStepIndex: number;
  /** 各步骤执行结果 */
  stepResults: StepResult[];
  /** 专属会话 ID */
  sessionId: string;
  /** 运行开始时间 */
  startedAt: string;
  /** 运行结束时间 */
  completedAt?: string;
}
