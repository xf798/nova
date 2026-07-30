// ===== 统一消息发送层 =====
//
// 所有调用 connector.send() 的入口（ChatView、企微消息处理、未来更多）
// 都应通过 sendMessage()，而不是直接调 connector.send() 自己拼上下文。
//
// sendMessage 自动处理：
// 1. Nova 身份上下文注入（始终）
// 2. 基于 connector capabilities 的记忆/技能/历史上下文构建
// 3. Tool loop（function calling）执行与结果回注
// 4. Legacy inline [ACTION:...] fallback（kiro-cli 兼容）

import type { Connector, HistoryMessage, TimelineEvent, TimelineToolEvent } from "../connectors/base";
import type { Message, RecallInfo } from "./types";
import type { SessionMemory } from "./memory";
import type { RecallContext } from "./memory/recall";
import { memoryManager } from "./memory";
import { longTermMemory } from "./memory/longterm";
import { getStableSkillContext, getVariableSkillContext, getQuerySkillContext } from "./skills";
import { skillRegistry } from "./skills/skillRegistry";
import { ensureSkillsLoaded } from "./skills/skillLoader";
import { toolRegistry } from "./tools";
import { toolOrchestrator } from "./tools";
import {
  generateNovaIdentityPrompt,
  executeInlineToolCalls,
  stripInlineToolCalls,
  type ToolExecResult,
} from "./toolExecutor";

export interface SendMessageParams {
  input: string;
  connector: Connector;
  sessionId?: string;
  attachments?: string[];
  cwd?: string;
  /** 当前会话消息列表（needsHistory 模式下用于构建上下文） */
  sessionMessages?: Message[];
  /** 当前会话记忆状态（摘要等） */
  sessionMemory?: SessionMemory;
  /** 工作区路径（用于记忆回忆） */
  workspace?: string;
  /** session 创建或恢复后立即回调，用于上层持久化 connectorSessionId */
  onSessionCreated?: (sessionId: string) => void;
}

export interface SendMessageResult {
  /** 清理后的内容（action/task 指令已移除） */
  content: string;
  /** LLM 原始回复 */
  rawContent: string;
  /** 新创建或复用的 session ID */
  sessionId?: string;
  /** tool 执行结果 */
  toolResults: ToolExecResult[];
  /** 记忆回忆数量 */
  recalledCount: number;
  /** 召回明细（可观测：本次注入的记忆/技能，含来源与蒸馏标记） */
  recall?: RecallInfo;
  /** 是否使用了 needsHistory 模式 */
  needsHistory: boolean;
  /** 结构化 metadata（toolcall/thought） */
  meta?: import("../connectors/base").StreamMeta;
  /** action 产生的附件（如截图路径），将附加到 assistant 消息 */
  attachments?: string[];
}

/**
 * 统一消息发送 — 自动构建上下文、执行 action、清理回复内容。
 *
 * 调用方只需提供消息和会话信息，不需要自己拼上下文。
 */
export async function sendMessage(
  params: SendMessageParams,
  onChunk?: (content: string) => void,
  onMeta?: (meta: import("../connectors/base").StreamMeta) => void,
): Promise<SendMessageResult> {
  const t0 = Date.now();
  const {
    input,
    connector,
    sessionId,
    attachments,
    cwd,
    sessionMessages,
    sessionMemory,
    workspace,
    onSessionCreated,
  } = params;

  console.log('[SendMessage] ─── 开始 ───');
  console.log(`[Nova:Send] ─── sendMessage() 开始 ───`);
  console.log(`[Nova:Send]   input: "${input.slice(0, 80).replace(/\n/g, "↵")}${input.length > 80 ? "..." : ""}"`);
  console.log(`[Nova:Send]   connector: ${connector.config.id} | sessionId: ${sessionId || "(新会话)"}`);
  console.log(`[Nova:Send]   sessionMessages: ${sessionMessages?.length || 0}条 | memory.summarized: ${sessionMemory?.summarizedCount || 0} | summaryChain: ${sessionMemory?.summaryChain?.length || 0}段`);
  console.log(`[Nova:Send]   attachments: ${attachments?.length || 0} | workspace: ${workspace || "(无)"}`);

  // 1. Nova 身份上下文
  // 所有模式都使用相同的精简身份声明（tools 通过 MCP Server 暴露，无需文本列表）
  const novaCtx = generateNovaIdentityPrompt();

  // 2. 确定上下文模式
  const needsHistory =
    connector.capabilities.needsHistory ||
    (!sessionId && !connector.capabilities.nativeSession);
  const needsMemSupplement =
    connector.capabilities.needsMemorySupplement && !needsHistory;

  console.log('[SendMessage]   input:', input.slice(0, 60), '...');
  console.log('[SendMessage]   connector:', connector.config.id, '| needsHistory:', needsHistory, '| needsMemSupplement:', needsMemSupplement);
  const mode = needsHistory ? "needsHistory(完整构建)" : needsMemSupplement ? "memorySupplement(混合)" : "passthrough(透传)";
  console.log(`[Nova:Send]   上下文模式: ${mode}`);

  // 3. 构建回忆上下文
  const recallCtx: RecallContext | undefined = workspace
    ? { workspace, attachments: attachments || [] }
    : undefined;

  // 4. 根据 mode 构建上下文
  let history: HistoryMessage[] | undefined;
  let memorySupplement: string | undefined;

  if (needsHistory) {
    // 完整模式：stable（记忆 + skills + Nova 身份）+ variable（回忆 + path-matched skills）
    const skillPaths = [...(attachments || [])];
    if (workspace) skillPaths.push(workspace);

    const ltStable = await longTermMemory.buildStableContext();
    const skillStable = await getStableSkillContext();
    const codingPrompt = getCodingSystemPrompt(cwd);
    const stableParts = [ltStable, skillStable, codingPrompt, novaCtx].filter(Boolean);
    const stableCtx = stableParts.length > 0 ? stableParts.join("\n\n") : null;

    const ltVariable = await longTermMemory.buildVariableContext(input, recallCtx);
    const skillVariable = await getVariableSkillContext(skillPaths);
    const skillQuery = input.trim() ? await getQuerySkillContext(input) : null;
    const variableParts = [ltVariable, skillVariable, skillQuery].filter(Boolean);
    const variableCtx = variableParts.length > 0 ? variableParts.join("\n\n") : null;

    history = memoryManager.buildContext(
      sessionMessages || [],
      sessionMemory,
      stableCtx,
      variableCtx,
    );
    console.log(`[Nova:Send]   ✅ context built: history=${history.length}条 | stable=${stableCtx?.length || 0}chars | variable=${variableCtx?.length || 0}chars (+${Date.now() - t0}ms)`);
  } else if (needsMemSupplement) {
    // 混合模式：只注入长期记忆（connector 自己管 session/skills/compression）
    const ltStable = await longTermMemory.buildStableContext();
    const ltVariable = input.trim()
      ? await longTermMemory.buildVariableContext(input, recallCtx)
      : null;
    const parts = [novaCtx, ltStable, ltVariable].filter(Boolean);
    if (parts.length > 0) memorySupplement = parts.join("\n\n");
    console.log(`[Nova:Send]   ✅ memorySupplement built: ${memorySupplement?.length || 0}chars | ltStable=${ltStable?.length || 0} | ltVariable=${ltVariable?.length || 0} (+${Date.now() - t0}ms)`);
  } else {
    // 纯透传：仍然注入 Nova 身份
    memorySupplement = novaCtx;
    console.log(`[Nova:Send]   passthrough: novaCtx=${novaCtx?.length || 0}chars`);
  }

  // 5. 记忆回忆数量 + 召回明细（供 UI 可观测）
  let recalledCount = 0;
  let recall: RecallInfo | undefined;
  if (input.trim()) {
    const recalled = await longTermMemory.getRecalledMemories(input, recallCtx);
    recalledCount = recalled.length;
    await ensureSkillsLoaded();
    const skillPathsForRecall = [...(attachments || [])];
    if (workspace) skillPathsForRecall.push(workspace);
    const recalledSkills = skillRegistry.getActiveWithSource(skillPathsForRecall, input);
    recall = {
      memories: recalled.map(r => ({
        content: r.memory.content,
        category: r.memory.category,
        distilled: (r.memory.tags || []).includes("distilled"),
        score: r.score,
      })),
      skills: recalledSkills,
      // kiro-cli 等原生加载连接器：skill 由其自身注入，Nova 展示为预估
      estimated: !needsHistory,
    };
    if (recalledCount > 0) {
      console.log(`[Nova:Send]   🧠 记忆回忆: ${recalledCount}条被召回`);
    }
  }

  // 6. 调用 connector.send()（支持 tool loop）
  // 对于 needsHistory 模式的连接器，传入 tools 定义启用 function calling
  const tools = needsHistory ? toolRegistry.generateOpenAITools() : undefined;

  // 对于 nativeSession 连接器：传入最近 10 轮历史作为 fallback
  const fallbackHistory: HistoryMessage[] | undefined = !history && sessionMessages
    ? sessionMessages
        .filter(m => m.role === "user" || m.role === "assistant")
        .filter(m => m.content !== "$$LOADING$$")
        .slice(-20)
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content }))
    : undefined;

  console.log(`[Nova:Send]   ⏳ → connector.send() | history=${(history || fallbackHistory)?.length || 0}条 | memorySupplement=${memorySupplement?.length || 0}chars | tools=${tools?.length || 0} (+${Date.now() - t0}ms)`);

  const tSend = Date.now();
  let result = await connector.send(
    input,
    { sessionId, attachments, history: history || fallbackHistory, memorySupplement, cwd, onSessionCreated, tools },
    onChunk || (() => {}),
    onMeta,
  );

  console.log(`[Nova:Send]   ✅ ← connector.send() 返回 (${Date.now() - tSend}ms) | sessionId: ${result.sessionId || "(无)"} | content: ${result.content.length}chars | toolCalls: ${result.toolCalls?.length || 0}`);

  // 7. Tool Loop：如果 AI 返回了 tool_calls，执行并回注结果
  const allToolResults: ToolExecResult[] = [];
  const MAX_TOOL_LOOPS = 25;
  let toolLoopCount = 0;
  const accumulatedToolMessages: any[] = [];  // 累积所有轮次的 tool 交互

  // ─── 跨轮过程时间线 ───
  // tool loop 会多次调用 connector.send()，每轮各自产出 timeline；
  // 工具事件由本层记录。三者需按真实顺序拼成一条完整时间线，
  // 否则每轮 onMeta 整体替换会把前面的过程冲掉。
  const mergedTimeline: TimelineEvent[] = [];
  const seenTimelineKeys = new Set<string>();

  /** 事件去重键：工具用 id，文本/思考用 kind+at（同一段重复 emit 时不重复插入） */
  const timelineKey = (e: TimelineEvent): string =>
    e.kind === "tool" ? `tool:${e.toolCallId}` : `${e.kind}:${e.at}`;

  /** 并入连接器某一轮产出的过程事件（同段内容更新则就地覆盖） */
  const appendConnectorTimeline = (events?: TimelineEvent[]) => {
    if (!events || events.length === 0) return;
    for (const ev of events) {
      const key = timelineKey(ev);
      if (seenTimelineKeys.has(key)) {
        const idx = mergedTimeline.findIndex(e => timelineKey(e) === key);
        if (idx >= 0) mergedTimeline[idx] = { ...ev };
        continue;
      }
      seenTimelineKeys.add(key);
      mergedTimeline.push({ ...ev });
    }
  };

  const snapshotMerged = (): TimelineEvent[] => mergedTimeline.map(e => ({ ...e }));

  while (result.toolCalls && result.toolCalls.length > 0 && toolLoopCount < MAX_TOOL_LOOPS) {
    toolLoopCount++;
    console.log(`[Nova:Send]   🔧 Tool Loop #${toolLoopCount}: ${result.toolCalls.map(t => t.name).join(", ")}`);

    // 把本轮连接器产出的过程事件并入累积 timeline
    appendConnectorTimeline(result.meta?.timeline);

    const loopToolCalls = result.toolCalls.map(tc => ({
      toolCallId: tc.id,
      title: tc.name,
      kind: "execute",
      status: "in_progress" as const,
      startedAt: Date.now(),
    }));

    // 记录工具事件到 timeline（进行中）
    for (const tc of loopToolCalls) {
      const key = `tool:${tc.toolCallId}`;
      if (seenTimelineKeys.has(key)) continue;
      seenTimelineKeys.add(key);
      mergedTimeline.push({
        kind: "tool",
        toolCallId: tc.toolCallId,
        title: tc.title,
        toolKind: tc.kind,
        status: "in_progress",
        at: tc.startedAt,
      });
    }

    // 通知 UI：tool 执行中
    if (onMeta) {
      onMeta({
        toolCalls: loopToolCalls,
        activeTool: result.toolCalls[0].name,
        timeline: snapshotMerged(),
      });
    }

    // 追加 assistant 消息（包含 tool_calls）到累积列表
    accumulatedToolMessages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    // 执行每个 tool_call（通过 orchestrator）
    for (const tc of result.toolCalls) {
      const toolResult = await toolOrchestrator.execute(tc.name, tc.arguments);
      allToolResults.push({ tool: tc.name, result: toolResult });

      accumulatedToolMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(toolResult.ok ? (toolResult.data ?? { ok: true }) : { error: toolResult.error }),
      });

      console.log(`[Nova:Send]     → ${tc.name}: ${toolResult.ok ? "✓" : "✗ " + toolResult.error}`);
    }

    // 通知 UI：tool 执行完成
    const completedAt = Date.now();
    for (const tc of result.toolCalls) {
      const ev = mergedTimeline.find(
        (e): e is TimelineToolEvent => e.kind === "tool" && e.toolCallId === tc.id,
      );
      if (ev) {
        const r = allToolResults.find(x => x.tool === tc.name);
        ev.status = r && !r.result.ok ? "failed" : "completed";
        ev.completedAt = completedAt;
      }
    }
    if (onMeta) {
      onMeta({
        toolCalls: result.toolCalls.map(tc => ({
          toolCallId: tc.id,
          title: tc.name,
          kind: "execute",
          status: "completed" as const,
          startedAt: completedAt - 100,
          completedAt,
        })),
        activeTool: "",
        timeline: snapshotMerged(),
      });
    }

    // 二次请求 LLM（携带所有累积的 tool 交互历史）
    console.log(`[Nova:Send]   ⏳ → tool loop #${toolLoopCount} 二次调用 LLM (累积 ${accumulatedToolMessages.length} 条 tool messages)...`);
    result = await connector.send(
      "",  // 无新输入
      {
        sessionId: result.sessionId || sessionId,
        history: history || fallbackHistory,
        tools,
        toolMessages: accumulatedToolMessages,
        cwd,
      },
      onChunk || (() => {}),
      onMeta,
    );
    console.log(`[Nova:Send]   ✅ ← tool loop #${toolLoopCount} 返回 | content: ${result.content.length}chars | toolCalls: ${result.toolCalls?.length || 0}`);
  }

  if (toolLoopCount > 0) {
    // 并入最后一轮（不再触发工具的那次）连接器产出的过程事件
    appendConnectorTimeline(result.meta?.timeline);
    console.log(`[Nova:Send]   🔧 Tool Loop 结束，共 ${toolLoopCount} 轮，执行了 ${allToolResults.length} 个 tools`);
  }

  // 8. 后处理：对于非 tool loop 模式（kiro-cli 等），仍执行旧的正则 action 解析
  let content = result.content;
  let toolResults = [...allToolResults];
  const toolAttachments: string[] = [];

  if (toolLoopCount === 0) {
    // 旧模式 fallback：从文本中解析 [ACTION:...] 指令
    const inlineActions = await executeInlineToolCalls(result.content);
    if (inlineActions.length > 0) {
      toolResults = inlineActions;
      content = stripInlineToolCalls(content);
      console.log(`[Nova:Send]   🎬 inline tool fallback: ${inlineActions.length}条`);

      // 通知 UI：tool 已执行
      if (onMeta) {
        const inlineNow = Date.now();
        const inlineToolCalls = inlineActions.map((r, i) => ({
          toolCallId: `nova-tool-${i}`,
          title: r.tool,
          kind: "execute" as const,
          status: (r.result.ok ? "completed" : "failed") as "completed" | "failed",
          startedAt: inlineNow - 50,
          completedAt: inlineNow,
        }));
        // inline 模式下连接器不产 tool 事件，这里补齐；正文段沿用连接器 timeline
        appendConnectorTimeline(result.meta?.timeline);
        for (const tc of inlineToolCalls) {
          const key = `tool:${tc.toolCallId}`;
          if (seenTimelineKeys.has(key)) continue;
          seenTimelineKeys.add(key);
          mergedTimeline.push({
            kind: "tool",
            toolCallId: tc.toolCallId,
            title: tc.title,
            toolKind: tc.kind,
            status: tc.status,
            at: tc.startedAt,
            completedAt: tc.completedAt,
          });
        }
        onMeta({
          toolCalls: inlineToolCalls,
          activeTool: "",
          timeline: snapshotMerged(),
        });
      }

      // 将有数据返回的 tool 结果格式化追加到内容中
      const dataResults = inlineActions.filter(r => r.result.ok && r.result.data != null);
      if (dataResults.length > 0) {
        const formatted = dataResults.map(r => formatToolResult(r)).filter(Boolean);
        if (formatted.length > 0) {
          content = content ? `${content}\n\n${formatted.join("\n\n")}` : formatted.join("\n\n");
        }
      }
    }
  }

  // 收集 tool 产生的附件（如截图图片路径）
  for (const r of toolResults) {
    if (r.tool === "ui.screenshot" && r.result.ok && r.result.data) {
      const screenshotPath = (r.result.data as { path?: string }).path;
      if (screenshotPath) toolAttachments.push(screenshotPath);
    }
  }

  console.log(`[Nova:Send] ─── sendMessage() 完成 ─── 总耗时: ${Date.now() - t0}ms | content: ${content.length}chars | recalled: ${recalledCount} | tools: ${toolResults.length} | toolLoops: ${toolLoopCount} | attachments: ${toolAttachments.length}`);

  return {
    content,
    rawContent: result.content,
    sessionId: result.sessionId,
    toolResults,
    recalledCount,
    recall,
    needsHistory,
    // 有跨轮/工具事件时用合并后的完整时间线，否则沿用连接器自身的
    meta: mergedTimeline.length > 0
      ? { ...(result.meta || {}), timeline: snapshotMerged() }
      : result.meta,
    attachments: toolAttachments.length > 0 ? toolAttachments : undefined,
  };
}

/**
 * 格式化 tool 执行结果为用户可读文本
 */
function formatToolResult(execResult: ToolExecResult): string | null {
  const { tool, result } = execResult;
  if (!result.ok || result.data == null) return null;

  // 不需要展示结果的 action（纯操作类，如导航、通知、暂停等）
  const silentActions = [
    "nav.goto", "chat.newSession", "connector.switch",
    "ui.notify", "ui.screenshot",
    "autoprogram.start", "autoprogram.pause", "autoprogram.resume",
    "autoprogram.stop", "autoprogram.retry", "autoprogram.skip",
  ];
  if (silentActions.includes(tool)) return null;

  // 特殊格式化
  switch (tool) {
    case "connector.list": {
      const connectors = result.data as Array<{ id: string; name: string; type: string; enabled: boolean }>;
      return `连接器列表：\n${connectors.map(c => `- ${c.name} (${c.type}) ${c.enabled ? "✓" : "✗"}`).join("\n")}`;
    }

    case "tools.list":
    case "actions.list": {
      const metas = result.data as Array<{ name: string; description: string }>;
      return `可用 Tools (${metas.length})：\n${metas.map(m => `- \`${m.name}\`: ${m.description}`).join("\n")}`;
    }
  }

  // 通用格式化：将所有有 data 返回的 tool 结果格式化为 JSON 展示
  const data = result.data;
  const label = tool.replace(/\./g, " ").replace(/^(\w)/, (_, c) => c.toUpperCase());

  if (Array.isArray(data)) {
    // 日志类数据
    const items = data.map((item: any) =>
      typeof item === "string" ? item : (item.message || JSON.stringify(item))
    );
    return `${label}：\n\`\`\`\n${items.join("\n")}\n\`\`\``;
  }

  if (typeof data === "object") {
    return `${label}：\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }

  return `${label}：${String(data)}`;
}

/**
 * 生成 Coding 模式的 system prompt（当有 coding tools 注册时注入）
 */
function getCodingSystemPrompt(cwd?: string): string | null {
  // 检查是否有 coding tools 注册
  const codingTools = toolRegistry.listByCategory("coding");
  if (codingTools.length === 0) return null;

  const workDir = cwd || "~";
  return `You are an AI coding assistant with direct access to the filesystem and shell.

Working directory: ${workDir}

Available coding tools:
- file_read: Read file contents (supports line ranges with offset/limit)
- file_write: Create new files or overwrite existing ones
- file_edit: Make targeted edits using exact string matching (search/replace)
- bash: Execute shell commands (build, test, git, etc.)
- glob: Find files by name pattern
- grep: Search file contents with regex

Guidelines:
- Always read a file before editing it (to get the exact current content for search/replace)
- Use file_edit for targeted changes; use file_write only for new files or complete rewrites
- After making changes, run the relevant build/test command to verify
- If a test or build fails, read the error output and fix the issue
- Use glob/grep to discover relevant files before making changes
- Prefer small, focused edits over large rewrites`;
}
