// ===== AutoProgram 插件 — PRD→设计→代码 自动化开发流水线 =====

import type { Plugin } from "../../types";
import { pipelineEngine } from "./engine";
import PipelinePanel from "./PipelinePanel";
import { Sparkles } from "lucide-react";

export const pipelinePlugin: Plugin = {
  id: "autoprogram",
  name: "AutoProgram",
  version: "3.0.0",
  description: "自动化开发流水线：从 TCHub 拉取 PRD，自动驱动 PM→UX→Dev 生成代码",

  sidebarItems: [{
    id: "autoprogram",
    label: "AutoProgram",
    icon: <Sparkles size={16} />,
    order: 15,
    component: () => <PipelinePanel />,
  }],

  activate(context) {
    pipelineEngine.init(context);

    // ─── 注册 AutoProgram tools ───

    context.tools.register("autoprogram.start", async (params) => {
      // prdPath 和 specName 不再必须 —— 不传时自动从 TCHub 拉取 auto_program workstream
      const config = {
        prdPath: params?.prdPath || "",
        specName: params?.specName || "",
        targetDir: params?.targetDir || "src/pages/demo/",
        pmCwd: params?.pmCwd || "/Users/wangxf/workspace/ai-pm-team",
        uxCwd: params?.uxCwd || "/Users/wangxf/workspace/ai-ux-team",
        devCwd: params?.devCwd || "/Users/wangxf/workspace/ai-develop-team",
        workstreamId: params?.workstreamId || undefined,
        syncToTchub: params?.syncToTchub !== false,
      };
      pipelineEngine.start(config);
      return { ok: true, data: { id: pipelineEngine.getState().id } };
    }, {
      description: "启动 E2E 流水线（PRD→设计→代码）。不传 prdPath 时自动从 TCHub 拉取 owner_role=auto_program 的 workstream 和 PRD",
      category: "autoprogram",
      params: [
        { name: "prdPath", type: "string", description: "PRD 文件路径（可选，不传则从 TCHub 自动拉取）" },
        { name: "specName", type: "string", description: "规格名称（可选，不传则从 workstream slug 推断）" },
        { name: "targetDir", type: "string", description: "代码生成目标目录" },
        { name: "pmCwd", type: "string", description: "PM 工程目录" },
        { name: "uxCwd", type: "string", description: "UX 工程目录" },
        { name: "devCwd", type: "string", description: "Dev 工程目录" },
        { name: "workstreamId", type: "string", description: "TCHub workstream ID（可选，不传则自动查找 auto_program）" },
        { name: "syncToTchub", type: "boolean", description: "是否同步到 TCHub（默认 true）" },
      ],
    });

    context.tools.register("autoprogram.pause", async () => {
      pipelineEngine.pause();
      return { ok: true };
    }, { description: "暂停流水线", category: "autoprogram" });

    context.tools.register("autoprogram.resume", async () => {
      pipelineEngine.resume();
      return { ok: true };
    }, { description: "继续流水线", category: "autoprogram" });

    context.tools.register("autoprogram.stop", async () => {
      pipelineEngine.stop();
      return { ok: true };
    }, { description: "停止流水线", category: "autoprogram" });

    context.tools.register("autoprogram.retry", async () => {
      pipelineEngine.retry();
      return { ok: true };
    }, { description: "重试失败的阶段", category: "autoprogram" });

    context.tools.register("autoprogram.skip", async () => {
      pipelineEngine.skip();
      return { ok: true };
    }, { description: "跳过当前阶段", category: "autoprogram" });

    context.tools.register("autoprogram.getState", async () => {
      const state = pipelineEngine.getState();
      return { ok: true, data: {
        status: state.status,
        currentStage: state.currentStage,
        tchubSync: state.tchubSync,
        pendingDecision: state.pendingDecision ? {
          stage: state.pendingDecision.stage,
          message: state.pendingDecision.message,
          options: state.pendingDecision.options.map(o => o.label),
        } : null,
        stages: Object.fromEntries(
          Object.entries(state.stages).map(([k, v]) => [k, {
            status: v.status,
            progress: v.progress,
            duration: v.duration,
            filesCopied: v.filesCopied?.length || 0,
          }])
        ),
        logsCount: state.logs.length,
        lastLog: state.logs[state.logs.length - 1]?.message || null,
      }};
    }, { description: "获取流水线当前状态", category: "autoprogram" });

    context.tools.register("autoprogram.getLogs", async (params) => {
      const state = pipelineEngine.getState();
      const limit = params?.limit || 20;
      return { ok: true, data: state.logs.slice(-limit) };
    }, {
      description: "获取流水线最近日志",
      category: "autoprogram",
      params: [{ name: "limit", type: "number", description: "返回条数（默认 20）" }],
    });
  },

  deactivate() {
    pipelineEngine.destroy();
  },
};
