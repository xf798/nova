import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../App";
import { pluginRegistry } from "../plugins";
import { memoryManager } from "../core/memory";
import type { MemoryConfig } from "../core/memory";
import { longTermMemory, CATEGORY_LABELS } from "../core/memory/longterm";
import type { LongTermMemory, MemoryCategory } from "../core/memory/longterm";
import { skillRegistry } from "../core/skills";
import type { Skill } from "../core/skills";
import { taskManager } from "../core/task";
import { getDistillConfig, saveDistillConfig, DISTILLED_TAG } from "../core/distill";
import { setAutoDistillEnabled, getReviewQueue, removeReviewItem } from "../core/distill";
import type { ReviewItem } from "../core/distill";
import { scheduler } from "../core/scheduler";
import type { ScheduledJob } from "../core/scheduler";
import {
  useUpdateStore,
  checkForUpdate,
  downloadAndInstall,
  restartApp,
  primeCurrentVersion,
  getAutoCheckEnabled,
  setAutoCheckEnabled,
} from "../core/updater";
import type { DistillConfig } from "../core/distill";
import { DEFAULT_DISTILL_CONFIG } from "../core/distill";
import SemanticSettings from "./settings/SemanticSettings";

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

interface SkillSettingItem {
  key: string;
  label: string;
  type: "text" | "password" | "toggle";
  placeholder?: string;
  description?: string;
  env?: string;
}

function Settings() {
  const { theme, setTheme, navigateTo } = useAppStore();
  const [memoryConfig, setMemoryConfig] = useState<MemoryConfig>(memoryManager.getConfig());
  const [ltStats, setLtStats] = useState<{ total: number; byCategory: Record<string, number> }>({ total: 0, byCategory: {} });
  const [skillStats, setSkillStats] = useState<{ total: number; loaded: number; withPaths: number }>({ total: 0, loaded: 0, withPaths: 0 });
  const [taskStats, setTaskStats] = useState<{ total: number; pending: number; inProgress: number; completed: number }>({ total: 0, pending: 0, inProgress: 0, completed: 0 });
  const [showMemories, setShowMemories] = useState(false);
  const [memories, setMemories] = useState<LongTermMemory[]>([]);
  const [memoryFilter, setMemoryFilter] = useState<MemoryCategory | "all">("all");
  const [skillSettings, setSkillSettings] = useState<{ skillName: string; items: SkillSettingItem[] }[]>([]);
  const [skillConfigs, setSkillConfigs] = useState<Record<string, string>>({});
  const [distillConfig, setDistillConfig] = useState<DistillConfig>(DEFAULT_DISTILL_CONFIG);
  // 蒸馏产物查看
  const [showDistilled, setShowDistilled] = useState(false);
  const [distilledMemories, setDistilledMemories] = useState<LongTermMemory[]>([]);
  const [distilledSkills, setDistilledSkills] = useState<Skill[]>([]);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  // 自动化：调度 job + 待审队列
  const [schedulerJobs, setSchedulerJobs] = useState<ScheduledJob[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([]);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      // 加载统计
      setLtStats(await longTermMemory.getStats());
      setSkillStats(skillRegistry.getStats());
      setTaskStats(await taskManager.getStats());
      setDistillConfig(await getDistillConfig());

      // 加载 skill config settings
      try {
        const skills = await invoke<any[]>("get_skills");
        const withSettings: { skillName: string; items: SkillSettingItem[] }[] = [];
        for (const skillInfo of skills || []) {
          if (skillInfo.config?.settings && skillInfo.config.settings.length > 0) {
            withSettings.push({
              skillName: skillInfo.config.name || skillInfo.name,
              items: skillInfo.config.settings,
            });
          }
        }
        setSkillSettings(withSettings);
      } catch {}

      // 加载已保存的 skill configs（兼容顶层 tchub_token）
      try {
        const config = await invoke<any>("get_config");
        const configs: Record<string, string> = { ...(config?.skill_configs || {}) };
        // 兜底：如果 skill_configs 中没有 tchub_token，从顶层读取
        if (!configs.tchub_token && config?.tchub_token) {
          configs.tchub_token = config.tchub_token;
        }
        setSkillConfigs(configs);
      } catch {}
    };
    load();
  }, []);

  // 订阅调度 job 变化 + 加载待审队列
  useEffect(() => {
    setSchedulerJobs(scheduler.getJobs());
    const unsub = scheduler.subscribe(setSchedulerJobs);
    const loadQueue = () => { getReviewQueue().then(setReviewQueue); };
    loadQueue();
    window.addEventListener("nova-distill-queue-changed", loadQueue);
    // 自愈：窗口重新聚焦 / 页面可见时，重新校准队列（防止事件漏接导致计数陈旧）
    window.addEventListener("focus", loadQueue);
    const onVis = () => { if (!document.hidden) loadQueue(); };
    document.addEventListener("visibilitychange", onVis);
    // 技能被删除/编辑时（如 Plugins 页），刷新蒸馏产物列表
    const onSkillsChanged = () => { loadDistilled(); };
    window.addEventListener("nova-skills-changed", onSkillsChanged);
    return () => {
      unsub();
      window.removeEventListener("nova-distill-queue-changed", loadQueue);
      window.removeEventListener("focus", loadQueue);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("nova-skills-changed", onSkillsChanged);
    };
  }, []);

  const updateMemory = (patch: Partial<MemoryConfig>) => {
    const newConfig = { ...memoryConfig, ...patch };
    setMemoryConfig(newConfig);
    memoryManager.updateConfig(newConfig);
  };

  const updateDistill = (patch: Partial<DistillConfig>) => {
    const next = { ...distillConfig, ...patch };
    setDistillConfig(next);
    saveDistillConfig(patch).catch(() => {});
  };

  const loadDistilled = async () => {
    const allMem = await longTermMemory.getAll();
    setDistilledMemories(allMem.filter(m => (m.tags || []).includes(DISTILLED_TAG)));
    const allSkills = skillRegistry.getAll();
    setDistilledSkills(
      allSkills.filter(s => {
        const tags = s.frontmatter.tags || [];
        return tags.includes(DISTILLED_TAG) || tags.includes("playbook");
      })
    );
  };

  const isPlaybook = (s: Skill) => (s.frontmatter.tags || []).includes("playbook");

  // 切换自动蒸馏总开关（同步 config + 所有 distill job）
  const toggleAutoDistill = async (enabled: boolean) => {
    updateDistill({ autoDistillEnabled: enabled });
    await setAutoDistillEnabled(enabled);
    setSchedulerJobs(scheduler.getJobs());
  };

  // 总开关显示状态：只要有一个 distill job 启用就算"开"（与独立开关保持一致）
  const distillJobs = schedulerJobs.filter(j => j.type === "distill");
  const autoDistillOn = distillJobs.length > 0 && distillJobs.some(j => j.enabled);

  // 打开待审条目审阅（复用蒸馏审阅面板，携带 queueId）
  const openReviewItem = (item: ReviewItem) => {
    window.dispatchEvent(new CustomEvent("nova-open-preview", {
      detail: { type: "distill", data: { ...item.result, __queueId: item.id } },
    }));
  };

  const dismissReviewItem = async (id: string) => {
    // 乐观更新：先从本地 state 移除，再持久化，避免竞态导致计数陈旧
    setReviewQueue(prev => prev.filter(i => i.id !== id));
    await removeReviewItem(id);
    window.dispatchEvent(new CustomEvent("nova-distill-queue-changed"));
  };

  const fmtTime = (iso?: string) =>
    iso ? new Date(iso).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

  const triggerLabel = (job: ScheduledJob): string => {
    switch (job.trigger.kind) {
      case "interval": return `每 ${job.trigger.everyMinutes} 分钟`;
      case "daily": {
        const t = job.trigger;
        if (typeof t.weekday === "number") return `每${WEEKDAY_NAMES[t.weekday]} ${t.at}`;
        const d = t.everyDays || 1;
        return d === 1 ? `每天 ${t.at}` : `每 ${d} 天 ${t.at}`;
      }
      case "idle": return `闲置 ${job.trigger.afterMinutes} 分钟后`;
      case "manual": return "仅手动";
    }
  };

  // 更新 job 触发配置（重算 nextRun + 持久化）
  const updateJobTrigger = async (job: ScheduledJob, trigger: ScheduledJob["trigger"]) => {
    await scheduler.upsertJob({ ...job, trigger });
    setSchedulerJobs(scheduler.getJobs());
  };

  // 每日 job 周期下拉：序列化/反序列化
  const dailyPeriodValue = (t: Extract<ScheduledJob["trigger"], { kind: "daily" }>): string =>
    typeof t.weekday === "number" ? `w${t.weekday}` : `d${t.everyDays || 1}`;

  const applyDailyPeriod = (job: ScheduledJob, at: string, periodVal: string) => {
    if (periodVal.startsWith("w")) {
      updateJobTrigger(job, { kind: "daily", at, weekday: parseInt(periodVal.slice(1), 10) });
    } else {
      updateJobTrigger(job, { kind: "daily", at, everyDays: parseInt(periodVal.slice(1), 10) });
    }
  };

  return (
    <div className="max-w-2xl mx-auto w-full">
      <h2 className="text-xl font-semibold mb-8">Settings</h2>

      <div className="space-y-8">
        <Section title="外观">
          <div className="flex gap-2">
            <PillBtn active={theme === "dark"} onClick={() => setTheme("dark")} label="深色" />
            <PillBtn active={theme === "light"} onClick={() => setTheme("light")} label="浅色" />
          </div>
        </Section>

        {/* 记忆 — 核心能力 */}
        <Section title="记忆">
          <div className="grid grid-cols-2 gap-2 mb-4">
            <StatusBadge label="会话摘要" status={memoryConfig.autoSummarize ? "active" : "standby"} detail={memoryConfig.autoSummarize ? "已启用" : "待命"} />
            <StatusBadge label="长期记忆" status={ltStats.total > 0 ? "active" : "standby"} detail={ltStats.total > 0 ? `已存 ${ltStats.total} 条` : "空"} />
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-app-text">工作记忆窗口</p>
                <p className="text-[11px] text-app-text-muted">保留最近多少条对话作为上下文</p>
              </div>
              <input
                type="number"
                value={memoryConfig.workingMemorySize}
                onChange={(e) => updateMemory({ workingMemorySize: parseInt(e.target.value) || 16 })}
                min={4} max={50}
                className="w-16 px-2 py-1.5 rounded-lg border border-app-border bg-transparent text-[13px] text-center text-app-text"
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-app-text">自动摘要</p>
                <p className="text-[11px] text-app-text-muted">超出窗口时自动调用模型压缩历史</p>
              </div>
              <button
                onClick={() => updateMemory({ autoSummarize: !memoryConfig.autoSummarize })}
                className={`relative w-9 h-5 rounded-full transition-colors ${memoryConfig.autoSummarize ? 'bg-[#10a37f]' : 'bg-app-border'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${memoryConfig.autoSummarize ? 'left-[18px]' : 'left-0.5'}`}></span>
              </button>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-app-text">消息截断阈值</p>
                <p className="text-[11px] text-app-text-muted">单条消息超过此长度将被截断</p>
              </div>
              <input
                type="number"
                value={memoryConfig.maxMessageChars}
                onChange={(e) => updateMemory({ maxMessageChars: parseInt(e.target.value) || 4000 })}
                min={500} max={20000} step={500}
                className="w-20 px-2 py-1.5 rounded-lg border border-app-border bg-transparent text-[13px] text-center text-app-text"
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-app-text">长期记忆提取</p>
                <p className="text-[11px] text-app-text-muted">每 N 轮对话后自动提取值得记住的信息</p>
              </div>
              <button
                onClick={() => updateMemory({ autoExtractMemories: !memoryConfig.autoExtractMemories })}
                className={`relative w-9 h-5 rounded-full transition-colors ${memoryConfig.autoExtractMemories ? 'bg-[#10a37f]' : 'bg-app-border'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${memoryConfig.autoExtractMemories ? 'left-[18px]' : 'left-0.5'}`}></span>
              </button>
            </div>

            {memoryConfig.autoExtractMemories && (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[13px] text-app-text">提取间隔（轮）</p>
                  <p className="text-[11px] text-app-text-muted">每多少轮对话触发一次提取</p>
                </div>
                <input
                  type="number"
                  value={memoryConfig.extractInterval}
                  onChange={(e) => updateMemory({ extractInterval: Math.max(1, parseInt(e.target.value) || 3) })}
                  min={1} max={20}
                  className="w-16 px-2 py-1.5 rounded-lg border border-app-border bg-transparent text-[13px] text-center text-app-text"
                />
              </div>
            )}

            {/* 查看已记忆的内容 */}
            <div className="pt-2">
              <button
                onClick={async () => {
                  if (!showMemories) {
                    const all = await longTermMemory.getAll();
                    setMemories(all);
                  }
                  setShowMemories(!showMemories);
                }}
                className="text-[12px] text-app-text-muted hover:text-app-text transition-colors"
              >
                {showMemories ? "▾ 收起记忆内容" : "▸ 查看已记忆的内容"}
              </button>

              {showMemories && (
                <div className="mt-3 space-y-2">
                  {/* 分类筛选 */}
                  <div className="flex gap-1.5 flex-wrap">
                    <button
                      onClick={() => setMemoryFilter("all")}
                      className={`px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${
                        memoryFilter === "all" ? "bg-app-surface-hover text-app-text" : "text-app-text-muted hover:text-app-text-secondary"
                      }`}
                    >
                      全部 ({memories.length})
                    </button>
                    {(Object.keys(CATEGORY_LABELS) as MemoryCategory[]).map(cat => {
                      const count = memories.filter(m => m.category === cat).length;
                      if (count === 0) return null;
                      return (
                        <button
                          key={cat}
                          onClick={() => setMemoryFilter(cat)}
                          className={`px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${
                            memoryFilter === cat ? "bg-app-surface-hover text-app-text" : "text-app-text-muted hover:text-app-text-secondary"
                          }`}
                        >
                          {CATEGORY_LABELS[cat]} ({count})
                        </button>
                      );
                    })}
                  </div>

                  {/* 记忆列表 */}
                  <div className="max-h-[360px] overflow-y-auto space-y-1.5">
                    {memories.length === 0 ? (
                      <p className="text-[11px] text-app-text-muted py-4 text-center">暂无记忆</p>
                    ) : (
                      memories
                        .filter(m => memoryFilter === "all" || m.category === memoryFilter)
                        .map(mem => (
                          <div key={mem.id} className="group flex items-start gap-2 px-2.5 py-2 rounded-lg bg-app-bg border border-app-border">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 mb-0.5">
                                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-app-surface-hover text-app-text-muted font-medium">
                                  {CATEGORY_LABELS[mem.category]}
                                </span>
                                {mem.tags.length > 0 && (
                                  <span className="text-[9px] text-app-text-muted">
                                    {mem.tags.slice(0, 3).join(" · ")}
                                  </span>
                                )}
                              </div>
                              <p className="text-[12px] text-app-text leading-relaxed">{mem.content}</p>
                              <span className="text-[9px] text-app-text-muted">
                                {new Date(mem.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                              </span>
                            </div>
                            <button
                              onClick={async () => {
                                await longTermMemory.remove(mem.id);
                                setMemories(prev => prev.filter(m => m.id !== mem.id));
                                setLtStats(await longTermMemory.getStats());
                              }}
                              className="opacity-0 group-hover:opacity-100 shrink-0 p-1 text-app-text-muted hover:text-red-400 transition-all"
                              title="删除此条记忆"
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M18 6L6 18M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

            {/* 语义召回：模型按需下载，不打进应用包 */}
            <div className="mt-4 pt-4 border-t border-app-border">
              <SemanticSettings />
            </div>
        </Section>

        {/* Skill 系统 */}
        <Section title="Skill">
          <div className="grid grid-cols-3 gap-2 mb-4">
            <StatusBadge label="已加载" status={skillStats.loaded > 0 ? "active" : "standby"} detail={`${skillStats.loaded} 个`} />
            <StatusBadge label="条件激活" status={skillStats.withPaths > 0 ? "active" : "standby"} detail={`${skillStats.withPaths} 个`} />
            <StatusBadge label="总数量" status="active" detail={`${skillStats.total} 个`} />
          </div>
          <p className="text-[11px] text-app-text-muted mb-4">
            Skill 目录：~/.nova/skills/
          </p>

          {/* Skill 配置项（从 skill.config.json 动态渲染） */}
          {skillSettings.map(({ skillName, items }) => (
            <div key={skillName} className="pt-3 border-t border-app-border">
              {items.map((item) => (
                <div key={item.key} className="space-y-1">
                  <div className="flex items-baseline gap-2">
                    <label className="text-[13px] text-app-text">{item.label}</label>
                    {item.env && <span className="text-[10px] text-app-text-muted">env: {item.env}</span>}
                  </div>
                  {item.type === "toggle" ? (
                    <button
                      onClick={() => {
                        const newConfigs = { ...skillConfigs, [item.key]: skillConfigs[item.key] === "true" ? "false" : "true" };
                        setSkillConfigs(newConfigs);
                        invoke("save_config", { config: { skill_configs: newConfigs } }).catch(() => {});
                      }}
                      className={`relative w-9 h-5 rounded-full transition-colors ${skillConfigs[item.key] === "true" ? 'bg-[#10a37f]' : 'bg-app-border'}`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${skillConfigs[item.key] === "true" ? 'left-[18px]' : 'left-0.5'}`}></span>
                    </button>
                  ) : (
                    <input
                      type={item.type === "password" ? "password" : "text"}
                      value={skillConfigs[item.key] || ""}
                      onChange={(e) => {
                        const newConfigs = { ...skillConfigs, [item.key]: e.target.value };
                        setSkillConfigs(newConfigs);
                      }}
                      onBlur={() => {
                        invoke("save_config", { config: { skill_configs: skillConfigs } }).catch(() => {});
                      }}
                      placeholder={item.placeholder || ""}
                      className="w-full px-3 py-1.5 rounded-lg border border-app-border bg-transparent text-[13px] text-app-text placeholder:text-app-text-muted focus:outline-none focus:border-[#10a37f]"
                    />
                  )}
                  {item.description && <p className="text-[10px] text-app-text-muted">{item.description}</p>}
                </div>
              ))}
            </div>
          ))}
        </Section>

        {/* 经验沉淀（Auto Distill） */}
        <Section title="经验沉淀">
          <p className="text-[11px] text-app-text-muted mb-4">
            从会话中蒸馏 记忆/技能/工作流。聊天工具栏「蒸馏」按钮或输入 <code className="px-1 rounded bg-app-surface-hover">/distill</code> 触发。
          </p>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-app-text">启用蒸馏</p>
                <p className="text-[11px] text-app-text-muted">关闭后蒸馏按钮/命令不产出结果</p>
              </div>
              <button
                onClick={() => updateDistill({ enabled: !distillConfig.enabled })}
                className={`relative w-9 h-5 rounded-full transition-colors ${distillConfig.enabled ? 'bg-[#10a37f]' : 'bg-app-border'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${distillConfig.enabled ? 'left-[18px]' : 'left-0.5'}`}></span>
              </button>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-app-text">最少对话轮数</p>
                <p className="text-[11px] text-app-text-muted">会话少于此轮数不触发蒸馏</p>
              </div>
              <NumberField
                value={distillConfig.minTurns} min={1} max={50}
                onCommit={(n) => updateDistill({ minTurns: n })}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-app-text">强制审阅</p>
                <p className="text-[11px] text-app-text-muted">开启后需人工勾选才落盘（关闭则仅高置信度自动写入，供 V2 定时蒸馏用）</p>
              </div>
              <button
                onClick={() => updateDistill({ requireReview: !distillConfig.requireReview })}
                className={`relative w-9 h-5 rounded-full transition-colors ${distillConfig.requireReview ? 'bg-[#10a37f]' : 'bg-app-border'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${distillConfig.requireReview ? 'left-[18px]' : 'left-0.5'}`}></span>
              </button>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-app-text">技能数量上限</p>
                <p className="text-[11px] text-app-text-muted">超出上限时提示清理，避免上下文膨胀</p>
              </div>
              <NumberField
                value={distillConfig.maxSkills} min={1} max={500} widthClass="w-20"
                onCommit={(n) => updateDistill({ maxSkills: n })}
              />
            </div>

            {/* 查看蒸馏产物 */}
            <div className="pt-2">
              <button
                onClick={async () => {
                  if (!showDistilled) await loadDistilled();
                  setShowDistilled(!showDistilled);
                }}
                className="text-[12px] text-app-text-muted hover:text-app-text transition-colors"
              >
                {showDistilled ? "▾ 收起蒸馏产物" : "▸ 查看蒸馏产物"}
              </button>

              {showDistilled && (
                <div className="mt-3 space-y-4">
                  {distilledMemories.length === 0 && distilledSkills.length === 0 ? (
                    <p className="text-[11px] text-app-text-muted py-4 text-center">
                      暂无蒸馏产物。用聊天工具栏「蒸馏」按钮或 <code className="px-1 rounded bg-app-surface-hover">/distill</code> 生成。
                    </p>
                  ) : (
                    <>
                      {/* 蒸馏出的记忆 */}
                      {distilledMemories.length > 0 && (
                        <div className="space-y-1.5">
                          <h4 className="text-[11px] font-medium text-app-text-muted">记忆 ({distilledMemories.length})</h4>
                          {distilledMemories.map(mem => (
                            <div key={mem.id} className="group flex items-start gap-2 px-2.5 py-2 rounded-lg bg-app-bg border border-app-border">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 mb-0.5">
                                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-app-surface-hover text-app-text-muted font-medium">
                                    {CATEGORY_LABELS[mem.category]}
                                  </span>
                                  {mem.tags.filter(t => t !== DISTILLED_TAG).length > 0 && (
                                    <span className="text-[9px] text-app-text-muted">
                                      {mem.tags.filter(t => t !== DISTILLED_TAG).slice(0, 3).join(" · ")}
                                    </span>
                                  )}
                                </div>
                                <p className="text-[12px] text-app-text leading-relaxed">{mem.content}</p>
                                <span className="text-[9px] text-app-text-muted">
                                  {new Date(mem.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                </span>
                              </div>
                              <button
                                onClick={async () => {
                                  await longTermMemory.remove(mem.id);
                                  setDistilledMemories(prev => prev.filter(m => m.id !== mem.id));
                                  setLtStats(await longTermMemory.getStats());
                                }}
                                className="opacity-0 group-hover:opacity-100 shrink-0 p-1 text-app-text-muted hover:text-red-400 transition-all"
                                title="删除此条记忆"
                              >
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 蒸馏出的技能 / 工作流 */}
                      {distilledSkills.length > 0 && (
                        <div className="space-y-1.5">
                          <h4 className="text-[11px] font-medium text-app-text-muted">技能 / 工作流 ({distilledSkills.length})</h4>
                          {distilledSkills.map(skill => {
                            const expanded = expandedSkill === skill.name;
                            const title = skill.frontmatter.name || skill.name;
                            return (
                              <div key={skill.name} className="rounded-lg bg-app-bg border border-app-border overflow-hidden">
                                <button
                                  onClick={() => setExpandedSkill(expanded ? null : skill.name)}
                                  className="w-full text-left px-2.5 py-2 hover:bg-app-surface-hover transition-colors"
                                >
                                  <div className="flex items-center gap-1.5 mb-0.5">
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${isPlaybook(skill) ? "bg-indigo-500/15 text-indigo-400" : "bg-blue-500/15 text-blue-400"}`}>
                                      {isPlaybook(skill) ? "工作流" : "技能"}
                                    </span>
                                    <span className="text-[12px] font-medium text-app-text truncate">{title}</span>
                                    <span className="ml-auto text-[10px] text-app-text-muted">{expanded ? "▾" : "▸"}</span>
                                  </div>
                                  {skill.frontmatter.description && (
                                    <p className="text-[11px] text-app-text-secondary leading-relaxed">{skill.frontmatter.description}</p>
                                  )}
                                </button>
                                {expanded && (
                                  <div className="px-2.5 pb-2.5 pt-1 border-t border-app-border">
                                    {(skill.frontmatter.keywords || []).length > 0 && (
                                      <p className="text-[9px] text-app-text-muted mb-1.5">
                                        关键词：{(skill.frontmatter.keywords || []).slice(0, 8).join(" · ")}
                                      </p>
                                    )}
                                    <pre className="text-[11px] font-mono text-app-text leading-relaxed whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
                                      {skill.content || "（无正文）"}
                                    </pre>
                                    <div className="flex justify-end mt-1.5">
                                      <button
                                        onClick={() => navigateTo("plugins")}
                                        className="text-[10px] text-app-text-muted hover:text-app-text transition-colors"
                                      >
                                        在 Plugins 中编辑 →
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </Section>

        {/* 自动化（调度 + 自动蒸馏） */}
        <Section title="自动化">
          <div className="grid grid-cols-2 gap-2 mb-4">
            <StatusBadge label="自动蒸馏" status={autoDistillOn ? "active" : "standby"} detail={autoDistillOn ? "已开启" : "关闭"} />
            <StatusBadge label="待审队列" status={reviewQueue.length > 0 ? "active" : "standby"} detail={`${reviewQueue.length} 项`} />
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-app-text">启用自动蒸馏</p>
                <p className="text-[11px] text-app-text-muted">一键开关下方全部定时任务（也可在列表里单独启停）</p>
              </div>
              <button
                onClick={() => toggleAutoDistill(!autoDistillOn)}
                className={`relative w-9 h-5 rounded-full transition-colors ${autoDistillOn ? 'bg-[#10a37f]' : 'bg-app-border'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoDistillOn ? 'left-[18px]' : 'left-0.5'}`}></span>
              </button>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] text-app-text">高可信记忆自动落盘</p>
                <p className="text-[11px] text-app-text-muted">自动蒸馏时高置信度记忆直接写入；技能/工作流始终入待审</p>
              </div>
              <button
                onClick={() => updateDistill({ autoApplyHighConfidenceMemory: !distillConfig.autoApplyHighConfidenceMemory })}
                className={`relative w-9 h-5 rounded-full transition-colors ${distillConfig.autoApplyHighConfidenceMemory ? 'bg-[#10a37f]' : 'bg-app-border'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${distillConfig.autoApplyHighConfidenceMemory ? 'left-[18px]' : 'left-0.5'}`}></span>
              </button>
            </div>

            {/* 调度 job 列表 */}
            {schedulerJobs.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <h4 className="text-[11px] font-medium text-app-text-muted">定时任务</h4>
                {schedulerJobs.map(job => (
                  <div key={job.id} className="rounded-lg bg-app-bg border border-app-border overflow-hidden">
                  <div className="flex items-center gap-2 px-2.5 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] text-app-text truncate">{job.name}</span>
                        {job.lastStatus && (
                          <span className={`w-1.5 h-1.5 rounded-full ${job.lastStatus === "success" ? "bg-green-500" : job.lastStatus === "failed" ? "bg-red-500" : job.lastStatus === "running" ? "bg-yellow-500" : "bg-gray-400"}`}></span>
                        )}
                      </div>
                      <p className="text-[10px] text-app-text-muted">
                        {triggerLabel(job)}
                        {job.trigger.kind !== "idle" && job.trigger.kind !== "manual" && job.enabled && ` · 下次 ${fmtTime(job.nextRun)}`}
                        {job.lastRun && ` · 上次 ${fmtTime(job.lastRun)}`}
                      </p>
                      {job.lastMessage && <p className="text-[10px] text-app-text-muted truncate">上次运行：{job.lastMessage}</p>}
                    </div>
                    {(job.trigger.kind === "idle" || job.trigger.kind === "daily") && (
                      <button
                        onClick={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}
                        className="shrink-0 p-1 text-app-text-muted hover:text-app-text transition-colors"
                        title="设置触发时间"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                      </button>
                    )}
                    <button
                      onClick={() => scheduler.runNow(job.id)}
                      className="shrink-0 text-[10px] px-2 py-1 rounded-lg text-app-text-muted hover:text-app-text hover:bg-app-surface-hover transition-colors"
                      title="立即运行一次"
                    >
                      运行
                    </button>
                    <button
                      onClick={() => scheduler.setEnabled(job.id, !job.enabled)}
                      className={`shrink-0 relative w-9 h-5 rounded-full transition-colors ${job.enabled ? 'bg-[#10a37f]' : 'bg-app-border'}`}
                      title={job.enabled ? "已启用" : "已停用"}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${job.enabled ? 'left-[18px]' : 'left-0.5'}`}></span>
                    </button>
                  </div>
                  {expandedJobId === job.id && job.trigger.kind === "idle" && (
                    <div className="px-2.5 pb-2.5 pt-1 border-t border-app-border flex items-center gap-2">
                      <span className="text-[11px] text-app-text-secondary">闲置</span>
                      <JobMinutesInput
                        value={job.trigger.afterMinutes}
                        onCommit={(n) => updateJobTrigger(job, { kind: "idle", afterMinutes: n })}
                      />
                      <span className="text-[11px] text-app-text-secondary">分钟后触发</span>
                    </div>
                  )}
                  {expandedJobId === job.id && job.trigger.kind === "daily" && (
                    <div className="px-2.5 pb-2.5 pt-1 border-t border-app-border flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-app-text-secondary">时间</span>
                      <TimeField
                        value={job.trigger.at}
                        onCommit={(v) => updateJobTrigger(job, { ...(job.trigger as any), at: v } as ScheduledJob["trigger"])}
                      />
                      <span className="text-[11px] text-app-text-secondary">周期</span>
                      <select
                        value={dailyPeriodValue(job.trigger)}
                        onChange={(e) => applyDailyPeriod(job, (job.trigger as any).at, e.target.value)}
                        className="px-2 py-1 rounded-lg border border-app-border bg-app-bg text-[12px] text-app-text"
                      >
                        <option value="d1">每天</option>
                        <option value="d2">每 2 天</option>
                        <option value="d3">每 3 天</option>
                        <option value="w1">每周一</option>
                        <option value="w2">每周二</option>
                        <option value="w3">每周三</option>
                        <option value="w4">每周四</option>
                        <option value="w5">每周五</option>
                        <option value="w6">每周六</option>
                        <option value="w0">每周日</option>
                      </select>
                    </div>
                  )}
                  </div>
                ))}
              </div>
            )}

            {/* 待审队列 */}
            {reviewQueue.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <h4 className="text-[11px] font-medium text-app-text-muted flex items-center gap-1.5">
                  待审队列
                  <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-medium">{reviewQueue.length}</span>
                </h4>
                {reviewQueue.map(item => {
                  const r = item.result;
                  const total = r.memories.length + r.skills.length + r.playbooks.length;
                  return (
                    <div key={item.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-app-bg border border-app-border">
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] text-app-text">
                          {r.memories.length} 记忆 · {r.skills.length} 技能 · {r.playbooks.length} 工作流
                        </p>
                        <p className="text-[10px] text-app-text-muted">{fmtTime(item.queuedAt)} · 共 {total} 项</p>
                      </div>
                      <button
                        onClick={() => openReviewItem(item)}
                        className="shrink-0 text-[10px] px-2 py-1 rounded-lg bg-app-text text-app-bg hover:opacity-80 transition-opacity"
                      >
                        审阅
                      </button>
                      <button
                        onClick={() => dismissReviewItem(item.id)}
                        className="shrink-0 p-1 text-app-text-muted hover:text-red-400 transition-colors"
                        title="忽略此批"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Section>

        {/* Task 跟踪 */}
        <Section title="Task">
          <div className="grid grid-cols-4 gap-2">
            <StatusBadge label="总数" status="active" detail={`${taskStats.total}`} />
            <StatusBadge label="待办" status={taskStats.pending > 0 ? "active" : "standby"} detail={`${taskStats.pending}`} />
            <StatusBadge label="进行中" status={taskStats.inProgress > 0 ? "active" : "standby"} detail={`${taskStats.inProgress}`} />
            <StatusBadge label="已完成" status={taskStats.completed > 0 ? "active" : "standby"} detail={`${taskStats.completed}`} />
          </div>
        </Section>

        <Section title="关于与更新">
          <UpdateSettings />
        </Section>

        {/* 插件扩展的设置区块 */}
        {pluginRegistry.getSettingsSections().map(section => (
          <Section key={section.id} title={section.title}>
            {section.component()}
          </Section>
        ))}
      </div>

    </div>
  );
}

function StatusBadge({ label, status, detail }: {
  label: string; status: "active" | "standby" | "planned"; detail: string;
}) {
  const dotColor = status === "active" ? "bg-green-500" : status === "standby" ? "bg-yellow-500" : "bg-gray-400";
  return (
    <div className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg bg-app-surface-hover">
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`}></span>
        <span className="text-[11px] font-medium text-app-text">{label}</span>
      </div>
      <span className="text-[10px] text-app-text-muted">{detail}</span>
    </div>
  );
}

/** 可自由清空/编辑、失焦或回车时提交并钳制的数字输入（避免清空即回填的受控坑） */
function NumberField({ value, min = 1, max = 999999, widthClass = "w-16", onCommit }: {
  value: number; min?: number; max?: number; widthClass?: string; onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const n = parseInt(text, 10);
    if (Number.isFinite(n) && n >= min) onCommit(Math.min(max, n));
    else setText(String(value)); // 非法输入回退
  };
  return (
    <input
      type="number" min={min} max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className={`${widthClass} px-2 py-1.5 rounded-lg border border-app-border bg-transparent text-[13px] text-center text-app-text`}
    />
  );
}

/** 闲置分钟输入（复用 NumberField，1-240 分钟） */
function JobMinutesInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  return <NumberField value={value} min={1} max={240} onCommit={onCommit} />;
}

/** 时间输入（HH:MM）：本地状态编辑，失焦时校验并提交，避免分段编辑被打断 */
function TimeField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const commit = () => {
    if (/^\d{1,2}:\d{2}$/.test(text)) onCommit(text);
    else setText(value); // 非法回退
  };
  return (
    <input
      type="time"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      className="px-2 py-1 rounded-lg border border-app-border bg-transparent text-[12px] text-app-text"
    />
  );
}

/** 关于与更新：版本、自动检查开关、检查/下载/重启 */
function UpdateSettings() {
  const [autoCheck, setAutoCheck] = useState(true);
  // 状态取自模块级 store，离开设置页不中断下载
  const stage = useUpdateStore(s => s.stage);
  const currentVersion = useUpdateStore(s => s.currentVersion);
  const newVersion = useUpdateStore(s => s.newVersion);
  const notes = useUpdateStore(s => s.notes);
  const progress = useUpdateStore(s => s.progress);
  const error = useUpdateStore(s => s.error);

  useEffect(() => {
    primeCurrentVersion();
    getAutoCheckEnabled().then(setAutoCheck);
    // 进入设置页即自动检查（TTL 内已检查过则沿用结果，不重复请求）
    checkForUpdate(false);
  }, []);

  const busy = stage === "checking" || stage === "downloading";
  const pct = progress !== undefined ? Math.round(progress * 100) : undefined;

  const toggleAuto = async (v: boolean) => {
    setAutoCheck(v);
    await setAutoCheckEnabled(v);
  };

  // 检查行左侧文案：版本号并入其中，不再独占一行
  const ver = currentVersion || "—";
  const statusText = (() => {
    switch (stage) {
      case "checking": return "正在检查更新…";
      case "upToDate": return `已是最新版本 · v${ver}`;
      case "available": return `发现新版本 v${newVersion}`;
      case "downloading": return `正在下载 v${newVersion}`;
      case "readyToRestart": return `v${newVersion} 已就绪`;
      case "error": return "检查更新失败";
      default: return `当前版本 v${ver}`;
    }
  })();

  const statusHint = (() => {
    if (stage === "available") return `当前 v${ver}${notes ? " · " + notes : ""}`;
    if (stage === "downloading") return notes;
    if (stage === "readyToRestart") return "重启后生效";
    if (stage === "error") return error;
    return undefined;
  })();

  // 检查行右侧按钮
  const action = (() => {
    if (stage === "available" || (stage === "error" && newVersion)) {
      return { label: "下载并安装", onClick: downloadAndInstall, primary: true };
    }
    if (stage === "downloading") {
      return { label: `下载中 ${pct ?? 0}%`, onClick: undefined, primary: true };
    }
    if (stage === "readyToRestart") {
      return { label: "重启以完成", onClick: restartApp, primary: true };
    }
    return {
      label: stage === "checking" ? "检查中…" : "检查更新",
      onClick: () => checkForUpdate(true),
      primary: false,
    };
  })();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] text-app-text">启动时自动检查更新</p>
          <p className="text-[11px] text-app-text-muted">仅在发现新版本时提示，不会自动安装</p>
        </div>
        <button
          onClick={() => toggleAuto(!autoCheck)}
          className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${autoCheck ? "bg-[#10a37f]" : "bg-app-border"}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoCheck ? "left-[18px]" : "left-0.5"}`}></span>
        </button>
      </div>

      {/* 检查/下载行：操作按钮就在本行，进度条紧随其下，无需滚动寻找 */}
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className={`text-[13px] ${stage === "available" || stage === "readyToRestart" ? "text-[#10a37f]" : "text-app-text"}`}>
              {statusText}
            </p>
            {statusHint && (
              <p className={`text-[11px] mt-0.5 whitespace-pre-wrap ${stage === "error" ? "text-red-500" : "text-app-text-muted"}`}>
                {statusHint}
              </p>
            )}
          </div>
          <button
            onClick={action.onClick}
            disabled={busy || !action.onClick}
            className={`shrink-0 px-4 py-1.5 rounded-full text-[12px] font-medium transition-colors disabled:opacity-60 ${
              action.primary
                ? "border border-[#10a37f] bg-[#10a37f]/10 text-[#10a37f] hover:bg-[#10a37f]/20"
                : "border border-app-border text-app-text-secondary hover:border-app-text-muted hover:text-app-text"
            }`}
          >
            {action.label}
          </button>
        </div>

        {stage === "downloading" && (
          <div className="mt-2 space-y-1">
            <div className="h-1 rounded-full bg-app-border overflow-hidden">
              <div
                className="h-full bg-[#10a37f] transition-all"
                style={{ width: pct !== undefined ? `${pct}%` : "40%" }}
              ></div>
            </div>
            <p className="text-[11px] text-app-text-muted">
              {pct !== undefined ? `已下载 ${pct}%` : "下载中…"}
            </p>
          </div>
        )}

        {stage === "error" && !newVersion && (
          <p className="mt-1 text-[11px] text-app-text-muted">
            开发模式下 updater 不可用，需在打包后的应用中测试。
          </p>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pb-6 border-b border-app-border last:border-b-0">
      <h3 className="text-[13px] font-medium text-app-text-secondary mb-4">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function PillBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-full text-[13px] font-medium transition-all border ${
        active
          ? "border-[#10a37f] bg-[#10a37f]/10 text-[#10a37f]"
          : "border-app-border text-app-text-secondary hover:border-app-text-muted hover:text-app-text"
      }`}
    >
      {label}
    </button>
  );
}

export default Settings;
