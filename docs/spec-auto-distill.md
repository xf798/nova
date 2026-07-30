# Nova 自动化运行 + 会话经验沉淀（Auto Distill）设计方案

> V1 状态：已实现（M1–M6）。命令 `/distill`、聊天「蒸馏」按钮、审阅面板、Skill 语义召回、Settings 配置均已落地并通过 `tsc + vite build`。
>
> 实现要点补充：
> - Skill 语义召回通过在 SKILL.md frontmatter 新增 `keywords` 字段实现。带 `keywords` 的「场景型」skill 不再进入常驻注入（`getAlwaysActive` 已排除），只通过 `skillRegistry.matchByQuery` 在相关场景召回，避免每次注入膨胀上下文。
> - 对 kiro-cli 连接器，蒸馏出的 skill 通过 `~/.kiro/skills` 软链被 Kiro 原生按描述匹配；`matchByQuery` 语义召回主要服务 `needsHistory`（OpenAI 兼容）连接器。
> - 蒸馏结果经 `window` 事件 `nova-open-preview`（type=`distill`）打开右侧审阅面板；toast 经 `nova-notify` 事件。

## 背景

Nova 已经积累了三层记忆（工作记忆 / 会话摘要 / 长期记忆）和技能系统，但存在两个缺口：

1. **经验无法主动沉淀**：会话里出现的"可复用套路"（比如某个部署流程、某个排查思路）只会被抽取成零散的记忆条目，不会凝练成一份可召回、可复用的 Skill / Playbook。
2. **没有定时自动化能力**：pipeline 只能事件触发，无法"每天凌晨自动总结昨天的会话"。

本方案对标 Claude Code 的 `/skillify` + Auto Memory + Session Memory，引入 **会话经验蒸馏（Auto Distill）**，并为其提供 **通用调度引擎** 作为自动化底座。

分期：
- **V1（本次）**：手动蒸馏 —— `/distill` 命令 + 聊天「蒸馏」按钮 + 审阅落盘 + Skill 语义召回。
- **V2**：定时自动蒸馏 —— 调度引擎 + auto-distill job + 可执行 Playbook。

---

## 目标

- 从一段（或多段）会话中，蒸馏出三类可复用资产：**Memory / Skill / Playbook**。
- 蒸馏产物落盘后，能在**后续相同场景自动复用**（记忆自动召回、技能语义召回）。
- 提供**人在环审阅**，保证沉淀质量，避免污染上下文。
- 为 V2 定时自动化预留通用调度底座。

### 非目标（V1）
- 应用关闭时的后台常驻运行（V1 依赖前端常驻，窗口关闭不跑）。
- Playbook 的自动执行/重放（V1 只沉淀为 workflow 型 skill 文档，V2 再做可执行）。
- 全量 cron 表达式（V1 只做 interval / daily / idle）。

---

## 现状盘点（复用清单）

| 能力 | 现有实现 | 本方案中的角色 |
|------|---------|---------------|
| 长期记忆存储 | `core/memory/longterm.ts`（4 类，上限 100） | Memory 产物直接写这里 |
| 记忆抽取 Auto Memory | `core/memory/extractor.ts`（侧查询+增量+去重 `isDuplicate`） | 蒸馏「记忆」环节复用其去重与分类 |
| 智能召回 | `core/memory/recall.ts`（分词+关键词+标签+时效打分） | 记忆自动复用已具备；Skill 召回复用其打分器 |
| 技能系统 | `core/skills/*` + 后端 `save_skill` | Skill 产物用 `saveSkill()` 落盘 |
| 后台侧查询范式 | ChatView `createTemporary("memory-bg")`，静默失败 | 蒸馏子 agent 照抄 |
| 状态机+持久化范式 | pipeline `engine.ts`（subscribe/notify/persist + run history） | 调度引擎（V2）照抄 |

**关键缺口（需新建）：**
1. Skill 只能按 path glob 或常驻匹配，**缺按语义/关键词召回** → 场景型 skill 无法自动浮现（必须补，否则"自动复用"不闭环）。
2. 无 **slash 命令分发器** → `/distill` 需要入口。
3. 无 **通用调度引擎**（V2）。

---

## 总体架构

```
┌──────────────────────────────────────────────┐
│  Scheduler Engine (V2)  core/scheduler/         │  ← Part A 自动化运行
│  interval / daily / idle 触发 → 派发 job         │
└───────────────┬────────────────────────────────┘
                │ job:"distill"
                ▼
┌──────────────────────────────────────────────┐
│  Distiller 子 agent (V1)  core/distill/         │  ← Part B 经验沉淀
│  会话 → 分析 → 三类候选产物 → 去重 → 待审         │
└───────┬───────────────┬────────────────┬───────┘
        ▼               ▼                ▼
    Memory          Skill            Playbook
 (复用 longterm)  (复用 saveSkill)  (V1: workflow-skill)
        │               │
        ▼               ▼
   recall 召回     Skill 语义召回 (新)  ← 自动复用回下一次会话
```

三类产物边界：

| 产物 | 定义 | 颗粒度 | 复用方式 |
|------|------|--------|---------|
| **Memory** | 原子事实/偏好/纠正 | 最小 | 每次对话自动召回注入 |
| **Skill** | "遇到 X 场景该怎么做"的知识文档 | 中 | 相关场景语义召回后注入 |
| **Playbook** | 有序可复现的多步工作流 | 大 | V1 当 `trigger=manual`+`tag=playbook` 的 skill；V2 可被调度执行 |

---

## V1 详细设计

### 1. 蒸馏子 agent `core/distill/`

跑在临时 connector 上（`createTemporary("distill-bg")`），照抄 memory-bg 的静默失败策略。长会话用 map-reduce（先分段摘要，再汇总蒸馏），避免爆上下文。

#### 1.1 类型定义

```ts
// core/distill/types.ts
export type ArtifactConfidence = "high" | "medium" | "low";

export interface MemoryCandidate {
  category: MemoryCategory;        // 复用 longterm 的 4 类
  content: string;
  tags: string[];
  confidence: ArtifactConfidence;
  isUpdate?: { id: string };       // 命中已有记忆 → 更新而非新建
}

export interface SkillCandidate {
  name: string;                    // kebab-case，用作目录名
  displayName: string;
  description: string;
  trigger: "auto" | "manual";
  paths?: string[];                // 可选，文件型场景
  keywords: string[];              // 语义召回用
  tags: string[];
  body: string;                    // SKILL.md 正文（markdown）
  confidence: ArtifactConfidence;
  isUpdate?: { name: string };     // 命中已有 skill → 更新
}

export interface PlaybookCandidate {
  name: string;
  displayName: string;
  description: string;
  keywords: string[];
  steps: { title: string; detail: string }[];
  confidence: ArtifactConfidence;
}

export interface DistillResult {
  memories: MemoryCandidate[];
  skills: SkillCandidate[];
  playbooks: PlaybookCandidate[];
  sourceSessions: string[];
  summary: string;                 // 本次蒸馏做了什么，给用户看
  createdAt: string;
}
```

#### 1.2 主流程

```ts
// core/distill/distiller.ts
async function distillSessions(
  sessionIds: string[],
  connector: Connector,
  opts?: { minTurns?: number },
): Promise<DistillResult>
```

步骤：
1. **收集来源**：从 sessionStore 取 messages（多会话则拼接，超长走 map-reduce 分段摘要）；取现有 `longTermMemory.getAll()` 与 `skillRegistry.getAll()` 用于去重。
2. **分析 + 分类**（一次或多次侧查询）：让模型识别偏好、纠正、反复出现的操作序列、可复用套路、项目事实，产出三类候选并各带 `confidence`。
3. **去重**：
   - Memory → 复用 `isDuplicate()`（extractor 里已实现），命中则标 `isUpdate`。
   - Skill/Playbook → 按 name + description 相似度比对现有 skill，命中标 `isUpdate`。
4. **返回 `DistillResult`（不落盘）**，交审阅面板。

#### 1.3 蒸馏 prompt 要点（对标 Claude Code /skillify）
- 明确"什么值得沉淀 / 什么不该沉淀"（一次性调试信息、可从代码/git 推导的内容不沉淀）。
- 要求结构化 JSON 输出（复用 extractor 的 JSON 解析容错：去 markdown 包裹、截取首尾括号）。
- 附上"已有记忆/技能清单"避免重复。
- Skill 候选必须给出 `keywords`（供语义召回）。

#### 1.4 落盘（用户确认后）
```ts
// core/distill/apply.ts
async function applyDistillResult(selected: Partial<DistillResult>): Promise<void>
```
- Memory → `longTermMemory.save()` 或 `.update()`（isUpdate 时）。
- Skill → `buildSkillMd(candidate)` 生成带 frontmatter 的 SKILL.md → `saveSkill(name, md)`（后端写 `~/.nova/skills/{name}/SKILL.md` 并软链到 kiro）→ `reloadSkills()`。
- Playbook → V1 生成 `trigger:manual` + `tags:[playbook,...]` 的 workflow skill（body 用有序步骤 markdown），走同一 `saveSkill`。

`buildSkillMd` 生成示例：
```markdown
---
name: deploy-frontend-to-dev
description: 前端项目打包发布到 dev 环境的标准流程
trigger: auto
tags: [deploy, jenkins, workflow]
---

## 适用场景
当需要将前端项目发布到 dev 环境时...

## 步骤
1. ...
```

### 2. Skill 语义召回（补齐自动复用）

现状 `skillRegistry` 只有 `matchByPaths` + `getAlwaysActive`。新增：

```ts
// core/skills/skillRegistry.ts
matchByQuery(query: string): Skill[]   // 用 recall.ts 的打分器对 description/keywords/tags 打分，取 top-N
buildQueryContext(query: string): string | null  // 注入 variable 层
```

- 复用 `core/memory/recall.ts` 已有的分词 + 打分逻辑（抽成公共 scorer）。
- 在 `buildContext` 的 variable 层，除 path-matched 外，追加 query-matched skills（去重、限流 top-N，避免膨胀）。
- 这样"下次遇到相同场景 → 蒸馏出的 skill 自动浮现"闭环。

### 3. 命令分发器 `core/commands/`（可复用基建）

极简 registry，ChatInput 发送前拦截 `/` 开头输入。

```ts
// core/commands/registry.ts
interface SlashCommand {
  name: string;                         // "distill"
  description: string;
  parse(argsRaw: string): any;          // 解析 --recent 3d 等
  run(ctx: CommandContext, args: any): Promise<void>;
}
registerCommand(cmd); dispatch(input): boolean;  // 命中返回 true，阻止普通发送
```

V1 注册：
- `/distill` —— 蒸馏当前会话
- `/distill --recent 3d` —— 蒸馏最近 3 天会话
- （预留 `/skillify` 为 `/distill --only skill` 别名）

ChatInput 集成：`onSend` 前先 `dispatch(input)`，命中则走命令流程、清空输入、不进普通对话。

### 4. 聊天「蒸馏」按钮

聊天工具栏加按钮，点击等价于 `dispatch("/distill")`。触发后：
- 顶部/侧栏显示"蒸馏中…"轻提示。
- 完成后打开审阅面板。

### 5. 审阅面板（人在环）

复用右侧 `PreviewPanel`（或独立 Modal）。展示 `DistillResult`：
- 三类候选分组列出，每条：勾选框 + 内容 + 置信度标识（high/medium/low）+ 可编辑。
- `isUpdate` 的条目标注"更新已有"。
- 底部「应用选中」→ `applyDistillResult`；「全部忽略」关闭。
- 默认只勾选 `high` 置信度项。

### 6. Settings「经验沉淀」区块
- 开关：启用手动蒸馏（默认开）。
- `minTurns`：会话少于 N 轮不允许蒸馏（默认 3）。
- 是否强制审阅（默认开；关闭后仅 high 置信度自动落盘）。
- Skill 数量上限（默认 50，超出提示清理）。

---

## V2 详细设计（自动化）

### 7. 调度引擎 `core/scheduler/`

前端单例（同 taskManager/pipelineEngine）。局限：应用关闭不跑，文档写明；后续如需常驻再上 Rust + tokio。

```ts
type TriggerKind = "interval" | "daily" | "idle" | "manual";
interface ScheduledJob {
  id: string; name: string; type: string;   // type = 处理器 key
  trigger:
    | { kind: "interval"; everyMinutes: number }
    | { kind: "daily"; at: string }          // "23:30"
    | { kind: "idle"; afterMinutes: number }
    | { kind: "manual" };
  payload?: any; enabled: boolean;
  lastRun?: string; nextRun?: string;
  lastStatus?: "success" | "failed" | "running";
}
```

- 持久化：`~/.nova/data/schedules.json`；运行历史：`~/.nova/data/scheduler-runs.json`。
- tick：`setInterval` 每 30s 扫一遍，到期派发；并发锁防重入；fire-and-forget，失败只记日志。
- 处理器注册表：`registerJobHandler("distill", handler)` 解耦引擎与业务。

### 8. auto-distill job
- 注册 `distill` 处理器：按 `daily` / `idle` 触发，蒸馏最近会话。
- 高置信度 **Memory 自动落盘**；**Skill/Playbook 始终入待审队列**（不自动写，防污染）。
- 待审队列在 UI 有红点提醒，用户空闲时批量审阅。

### 9. 可执行 Playbook（M11 · 详细设计）

> 现状：Playbook 已能**生成**（蒸馏产出 `PlaybookCandidate` → 审阅落盘为 `trigger:manual`+`tag:playbook` 的 SKILL.md）、也能作为**知识**被 `matchByQuery` 召回注入给 agent 阅读；但**不能作为流程被执行/重放**。M11 补齐"一键重放"这一层。

#### 9.0 设计原则
1. **引擎通用化，场景无关**：任何 Playbook = 有序步骤；执行 = 逐步把步骤说明交给 agent 跑。**不写死任何具体场景**（部署/SQL 只是首批验证样本，不是引擎能力边界）。
2. **复用现有基建**：执行走 `core/sendMessage` 的 tool-loop（agent 已有读写文件/跑命令/调 MCP 全套能力）；定时走 `scheduler`；入口走 `commands` 分发器。
3. **人在环上**：默认半自动逐步执行，危险步骤强制确认，不做无人值守全自动。
4. **不推翻现有落盘**：Playbook 仍以 SKILL.md 为人类可读源，另存一份结构化可执行定义。

#### 9.1 数据模型（`~/.nova/data/playbooks.json`）
```ts
interface Playbook {
  id: string;
  name: string;              // 关联 SKILL.md 的 name
  displayName: string;
  description: string;
  params?: PlaybookParam[];  // 声明本流程的可变入参（模板化）
  steps: PlaybookStep[];
  sourceSkill?: string;      // 派生自哪个 skill
  createdAt: string;
  updatedAt: string;
}

interface PlaybookParam {
  key: string;               // "env" / "branch" / "project"
  label: string;             // "目标环境"
  type: "string" | "enum" | "path" | "boolean";
  required: boolean;
  default?: string;
  options?: string[];        // enum: ["dev","test","crm-ci"]
  description?: string;
}

interface PlaybookStep {
  id: string;
  title: string;
  detail: string;            // 注入 agent 的指令原文，可含 {{key}} 占位
  kind: "auto" | "confirm";  // confirm=执行前必须人工确认（危险/需判断）
  hint?: {
    expectTool?: string;     // 期望调用的工具（如 shell / code-deploy 脚本）
    successCriteria?: string;// 这步"算成功"的判据，供 agent 自检
  };
}
```
设计要点：`detail` 是自然语言指令，`kind`/`hint`/`params` 是**可选加固**。蒸馏产出时默认全 `auto`、无 hint、参数由 LLM 反推；人审时可精调。引擎对"是什么场景"无感。

#### 9.2 Playbook 来源（三条路，保证新场景可覆盖）
1. **蒸馏自动产出（已有，通用）**：`distiller` 识别"反复出现的操作序列/可复用套路"这一抽象特征 → `PlaybookCandidate`，并把上次会话里的具体值**反推成参数**（如"发到 test" → `env`(default=test) + 步骤留 `{{env}}`）。新场景走同一通道，无需加代码。
2. **从现有 SKILL.md 解析**：一次性 migration，把已有 `tag:playbook` 的 SKILL.md（如元模型 6 步）解析成 `Playbook` 结构入 store。
3. **手动补录**：自动没抓到时，`/distill` 补蒸 或 直接建 playbook skill。

> 局限（诚实）：自动识别是 LLM 尽力而为，非 100%。需要足够信号（流程重复出现/步骤清晰）才会被蒸出；靠**人审 + 手动补录**兜底。

#### 9.3 参数注入：双层机制
因步骤是交给 agent 的自然语言，采用双层，兼顾强健与精确：
- **Level 1（必做，强健）**：重放前收集"本次运行参数"，作为**会话开场上下文块**注入（如 `本次运行参数：工程=copilot-fe，分支=feature/x，环境=test`），agent 每步自然套用。对松散步骤最稳。
- **Level 2（加固，可选）**：`detail` 里写 `{{env}}`、`{{table}}`，执行前**机械替换**成实际值。用于**不容错的关键参数**（部署环境、刷缓存表名 `p_api_route` 等），不靠 agent 理解。
- **参数预设**：可存常用组合（如"copilot-fe→test"）一键带入，免每次重填。
- **中途参数**：前面步骤才产出的值（如生成的 CR 号），不在开场填，后续步骤从会话上文自然获取，或该步标 `confirm` 让用户确认/补填。

#### 9.4 执行引擎 `core/playbook/runner.ts`
```ts
class PlaybookRunner {
  start(playbookId, params): PlaybookRun     // 开专属会话，注入开场参数上下文
  runNextStep(runId): Promise<StepResult>    // 执行下一步
  confirmAndRun(runId): Promise<StepResult>  // confirm 步骤：用户确认后执行
  abort(runId): void                         // 中止
}
```
执行模型：
- **开一个专属会话**承载整个重放，前一步产出天然累积在会话历史，后续步骤有上下文。
- **每步**：`step.detail`（Level 2 占位替换后）+ hint → 组织成指令 → 调 `sendMessage` → agent 用工具实际执行 → 拿产出。
- **半自动**：每步执行完**暂停**，UI 展示产出，用户点「下一步」继续。
- **confirm 步骤**：执行前应用内两步确认（Tauri 不能用 native confirm）。
- **失败处理**：agent 报错 / 未达 `successCriteria` → 标红暂停，可「重试 / 跳过 / 中止」。不抛异常终止（走正常拦截 return，保持日志干净）。
- **可观测**：每步状态（待执行/执行中/成功/失败/跳过）+ 产出摘要全程可见。

#### 9.5 触发入口
- **MVP：手动重放** —— 技能列表 playbook 项、召回徽标 playbook 加「▶ 重放」按钮 → 起 Runner。
- **二期：调度重放** —— 注册 `playbook-replay` 到 `scheduler`，支持 daily/manual 定时重放。

#### 9.6 UI
- **入口**：Plugins/技能列表 playbook 类目 + Settings 经验沉淀模块 playbook 项，加「▶ 重放」。
- **执行浮层**（居中弹窗+遮罩，遵循偏好）：重放前参数表单（默认值/枚举下拉/预设）→ 步骤清单 + 每步状态/产出 + 「下一步/重试/跳过/中止」控制条 + confirm 确认交互。

#### 9.7 里程碑拆分
| # | 交付 | 说明 |
|---|------|------|
| M11.1 | `core/playbook/` store + 类型（含 params）+ 从 SKILL.md 解析器 | 数据层 |
| M11.2 | `PlaybookRunner` 半自动执行引擎 + 参数替换/开场注入 | 复用 sendMessage |
| M11.3 | 执行浮层 UI + 重放前参数表单 + 重放入口 | 遵循偏好 #9 |
| M11.4 | confirm 步骤拦截 + 失败重试/跳过 | 安全 |
| M11.5 | **验证**：元模型排错 Playbook 跑通 → 再验部署/SQL | 首批样本 |
| M11.6 | 调度重放（`playbook-replay` job） | **二期，后置** |

验收：对元模型/部署/SQL 三条 Playbook 点「重放」→ 填本次参数 → 逐步执行、每步可见产出、危险步骤停下确认、失败可重试 → 全程无场景专属代码。

#### 9.8 风险与边界
- **执行副作用**：重放真的改文件/跑命令/发部署 → 半自动 + confirm 兜底；首批只在盯着时手动跑。
- **步骤漂移**：环境变了老步骤可能失效 → agent 按 `successCriteria` 自检 + 失败暂停，不硬闯。
- **蒸馏识别非 100%**：靠人审 + 手动补录兜底。
- **应用关闭不跑**：沿用 scheduler 现有局限，仅二期调度重放涉及。

### 10. 调度管理 UI
- 复用 Plugins 页新增「自动化」入口或新页面：job 列表、开关、下次运行时间、运行历史、待审队列。

---

## 数据与文件一览

| 文件 | 用途 | 阶段 |
|------|------|------|
| `~/.nova/skills/{name}/SKILL.md` | 蒸馏出的 Skill / Playbook | V1 |
| StorageService ns=`memory` | 蒸馏出的 Memory（复用现有） | V1 |
| `~/.nova/data/distill-review.json` | 待审队列（可选，V2 自动蒸馏用） | V2 |
| `~/.nova/data/schedules.json` | 调度 job 定义 | V2 |
| `~/.nova/data/scheduler-runs.json` | 调度运行历史 | V2 |
| `~/.nova/data/playbooks.json` | 可执行 Playbook 结构化定义（含 params/steps） | V2 (M11) |

---

## 里程碑（V1）

| # | 里程碑 | 交付 | 依赖 |
|---|--------|------|------|
| M1 | 蒸馏子 agent | `core/distill/` types + distiller + apply + prompt + 去重 | 复用 longterm/extractor |
| M2 | Skill 语义召回 | `skillRegistry.matchByQuery` + variable 层注入 + recall scorer 抽公共 | - |
| M3 | 命令分发器 | `core/commands/` + `/distill` + ChatInput 拦截 | - |
| M4 | 聊天按钮 | 工具栏「蒸馏」按钮 → dispatch | M3 |
| M5 | 审阅面板 | PreviewPanel 内候选展示 + 勾选落盘 | M1 |
| M6 | Settings 区块 | 经验沉淀配置项 | M1 |

验收：在一段真实会话里点「蒸馏」/输入 `/distill` → 弹出候选 → 勾选应用 → 新 skill 出现在技能列表 → 新开会话触发相同场景关键词 → 该 skill 被召回注入。

---

## 风险与取舍

- **蒸馏质量**：低质 skill 污染上下文 → V1 强制人审 + 置信度阈值 + skill 数量上限。
- **上下文成本**：长会话 map-reduce 分段；V2 调度错峰（daily/idle）而非高频 interval。
- **自动落盘信任**：V2 只自动写高置信度 Memory，Skill/Playbook 始终待审。
- **应用关闭不跑**：V1 局限，文档写明；V2 视需要上 Rust 常驻。
- **命令分发器**：新基建，后续 `/compact`、`/summary` 等可复用，值得先做。


---

## 附录：召回可观测（Recall Observability）

> 目的：让"蒸馏产物在后续场景被自动复用"这件事**看得见**。当前记忆召回只有数量、技能语义召回完全不可见，无法验证闭环价值。

### 缺口
- `SendMessageResult.recalledCount` 仅记忆召回**数量**，且 ChatView 未用于展示。
- `activeSkills` 弹窗按附件/工作区路径算，不含**语义召回(query-matched)技能**，不区分蒸馏产物。
- 无逐条消息归因；不区分蒸馏 vs 内置。

### 数据模型
```ts
interface RecallInfo {
  memories: { content: string; category: MemoryCategory; distilled: boolean; score: number }[];
  skills:   { name: string; displayName: string; source: "always" | "path" | "query"; distilled: boolean; score?: number }[];
}
// SendMessageResult 增加 recall?: RecallInfo
// Message 增加 recall?: RecallInfo（随会话持久化，历史可回看）
```

### 采集（core/sendMessage，复用现成能力）
- 记忆：`longTermMemory.getRecalledMemories(input, ctx)` 返回 `ScoredMemory[]`，按 tag 含 `distilled` 标记来源。
- 技能：新增 `skillRegistry.getActiveWithSource(filePaths, query)`，合并 常驻(always) / 路径匹配(path) / `matchByQuery`(query) 三路，各带 `source` 与 `score`，按 frontmatter.tags 含 `distilled` 标记。

### UI（MessageItem）
- 每条 assistant 消息下方低调 chip：`🧠 召回 N 记忆 · M 技能`（无召回不显示）。
- 点击展开 popover，分组列出：记忆（分类徽标+片段+蒸馏标记）、技能（显示名+来源徽标+蒸馏标记+分数）。
- 蒸馏产物高亮，凸显"蒸出来的东西真的被复用"。

### kiro-cli 边界（诚实标注）
- OpenAI 兼容连接器：Nova 亲自注入，展示的召回 = 实际注入，准确。
- kiro-cli：实际注入由 Kiro 读 `~/.kiro/skills` 原生完成，Nova 看不到其内部命中。展示的是 Nova 用同一套 `matchByQuery` 算出的"**预计召回**"，作为代理指标（标注"预计"），不保证与 Kiro 内部一致。

### 分期
- **A 期（核心）**：sendMessage 采集 `RecallInfo` → 挂到 assistant 消息并持久化 → 消息下 chip + popover。
- **B 期（可选）**：输入框草稿实时预览将召回什么；kiro-cli "预计" 标注细化。
