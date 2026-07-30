// ===== TCHub Client — Pipeline 插件与 TCHub 的集成层 =====
//
// 封装 TCHub MCP API 调用：状态更新、文档上传/下载。
// Pipeline engine 在阶段切换时异步调用，不阻塞主流程。

import { Command } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";

// ─── 配置 ───

const TCHUB_MCP_URL = "https://tchub.ingageapp.com/mcp";
const LEGACY_CONFIG_PATH = "~/.pipeline-commander/config.json";

// ─── 类型 ───

export interface TCHubSyncResult {
  ok: boolean;
  error?: string;
  data?: any;
}

export type WorkstreamStatus =
  | "draft"
  | "product_active"
  | "product_complete"
  | "design_active"
  | "design_complete"
  | "implementation_active"
  | "qa_active"
  | "qa_complete"
  | "completed";

export type WorkstreamStage = "product" | "design" | "implementation" | "qa" | "done";

// ─── Types for workstream listing ───

export interface WorkstreamInfo {
  id: string;
  name: string;
  slug: string;
  summary: string;
  status: WorkstreamStatus;
  owner_role: string;
  current_stage: WorkstreamStage;
  feature_id: string;
  feature_name: string;
  project_name: string;
  document_count: number;
}

export interface AutoProgramWorkstream extends WorkstreamInfo {
  prdDocumentId?: string;
  prdTitle?: string;
}

// ─── Client ───

export class TCHubClient {
  private token = "";

  /** 获取 token（优先级：invoke get_config → 环境变量 TCH_API_TOKEN → shell cat 兜底） */
  private async getToken(): Promise<string> {
    if (this.token) return this.token;

    // 1. 优先通过 Tauri invoke 读取（最可靠）
    try {
      const config = await invoke<any>("get_config");
      const token = config?.skill_configs?.tchub_token || config?.tchub_token;
      if (token) {
        this.token = token;
        return this.token;
      }
    } catch {}

    // 2. 环境变量
    try {
      const envCmd = Command.create("sh", ["-c", `echo "$TCH_API_TOKEN"`]);
      const envResult = await envCmd.execute();
      if (envResult.code === 0 && envResult.stdout.trim()) {
        this.token = envResult.stdout.trim();
        return this.token;
      }
    } catch {}

    // 3. 兜底：旧路径 ~/.pipeline-commander/config.json
    try {
      const cmd = Command.create("sh", ["-c", `cat "${LEGACY_CONFIG_PATH}"`]);
      const result = await cmd.execute();
      if (result.code === 0 && result.stdout) {
        const config = JSON.parse(result.stdout);
        if (config.tchub_token) {
          this.token = config.tchub_token;
          return this.token;
        }
      }
    } catch {}

    this.token = "";
    return "";
  }

  /** 调用 TCHub MCP 工具 */
  private async callTool(toolName: string, args: Record<string, any>): Promise<TCHubSyncResult> {
    const token = await this.getToken();
    if (!token) return { ok: false, error: "未配置 TCHub token，请在 Settings 页面配置，或设置环境变量 TCH_API_TOKEN" };

    try {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      });

      const cmd = Command.create("sh", [
        "-c",
        `curl -s "${TCHUB_MCP_URL}" -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${payload.replace(/'/g, "'\\''")}'`,
      ]);
      const result = await cmd.execute();

      if (result.code !== 0) {
        return { ok: false, error: `curl 执行失败: ${result.stderr}` };
      }

      // TCHub MCP 返回 SSE 格式：event: message\ndata: {...}
      const stdout = result.stdout;
      const dataLine = stdout.split("\n").find((l: string) => l.startsWith("data: "));
      if (!dataLine) return { ok: false, error: "无有效响应" };

      const json = JSON.parse(dataLine.slice(6));
      if (json.result?.content?.[0]?.text) {
        const inner = JSON.parse(json.result.content[0].text);
        return { ok: inner.ok !== false, data: inner.data || inner };
      }
      if (json.error) {
        return { ok: false, error: json.error.message };
      }
      return { ok: true, data: json.result };
    } catch (err: any) {
      return { ok: false, error: err.message || "TCHub 调用异常" };
    }
  }

  // ─── 公开方法 ───

  /** 列出所有 owner_role=auto_program 的 workstream（用于自动流水线消费） */
  async listAutoProgramWorkstreams(): Promise<TCHubSyncResult> {
    // 调用 list_workstreams，然后客户端过滤 owner_role === "auto_program"
    const result = await this.callTool("list_workstreams", { ownerRole: "auto_program" });
    if (!result.ok) return result;

    // 服务端可能不支持 ownerRole 过滤，客户端兜底过滤
    const allWorkstreams: WorkstreamInfo[] = Array.isArray(result.data) ? result.data : (result.data?.workstreams || []);
    const autoPrograms = allWorkstreams.filter(
      (ws: any) => ws.owner_role === "auto_program"
    );

    return { ok: true, data: autoPrograms };
  }

  /** 获取 workstream 的完整上下文（含文档列表） */
  async getWorkstreamContext(workstreamId: string): Promise<TCHubSyncResult> {
    return this.callTool("get_workstream_context", { workstreamId, compact: true });
  }

  /** 下载 PRD 文档内容到本地文件 */
  async downloadPRD(workstreamId: string, saveTo: string): Promise<TCHubSyncResult> {
    // 1. 获取 workstream 上下文找到 PRD 文档
    const ctx = await this.getWorkstreamContext(workstreamId);
    if (!ctx.ok) return ctx;

    const docs = ctx.data?.documents || [];
    const prdDoc = docs.find((d: any) => d.doc_type === "prd");
    if (!prdDoc) return { ok: false, error: "Workstream 中无 PRD 文档" };

    // 2. 获取文档完整内容
    const docResult = await this.callTool("get_document", { documentId: prdDoc.id });
    if (!docResult.ok) return docResult;

    // 提取文档内容文本
    const content = docResult.data?.content_text || docResult.data?.content || "";
    if (!content) return { ok: false, error: "PRD 文档内容为空" };

    // 3. 写入本地文件
    try {
      const writeCmd = Command.create("sh", [
        "-c",
        `mkdir -p "$(dirname "${saveTo}")" && cat > "${saveTo}" << 'TCHUB_PRD_EOF'\n${content}\nTCHUB_PRD_EOF`,
      ]);
      const writeResult = await writeCmd.execute();
      if (writeResult.code !== 0) {
        return { ok: false, error: `写入文件失败: ${writeResult.stderr}` };
      }

      return {
        ok: true,
        data: {
          documentId: prdDoc.id,
          title: prdDoc.title,
          savedTo: saveTo,
          contentLength: content.length,
        },
      };
    } catch (err: any) {
      return { ok: false, error: `保存 PRD 失败: ${err.message}` };
    }
  }

  /** 更新 workstream 状态 */
  async updateWorkstreamStatus(
    workstreamId: string,
    status: WorkstreamStatus,
    currentStage: WorkstreamStage
  ): Promise<TCHubSyncResult> {
    return this.callTool("update_workstream", {
      workstream_id: workstreamId,
      status,
      currentStage,
    });
  }

  /** 记录笔记（用于记录阶段完成/失败信息） */
  async recordNote(
    workstreamId: string,
    title: string,
    content: string,
    noteType: string = "decision",
    tags: string[] = ["pipeline"]
  ): Promise<TCHubSyncResult> {
    return this.callTool("remember_context", {
      workstreamId,
      title,
      contentText: content,
      noteType,
      tags,
    });
  }

  /** 获取 workstream 中的 PRD 文档内容 */
  async getWorkstreamPRD(workstreamId: string): Promise<TCHubSyncResult> {
    const ctx = await this.callTool("get_workstream_context", { workstreamId });
    if (!ctx.ok) return ctx;

    // 找 prd 类型的文档
    const docs = ctx.data?.documents || [];
    const prdDoc = docs.find((d: any) => d.doc_type === "prd");
    if (!prdDoc) return { ok: false, error: "Workstream 中无 PRD 文档" };

    return { ok: true, data: { documentId: prdDoc.id, title: prdDoc.title, content: prdDoc.content_text } };
  }

  /** 上传文档到 workstream */
  async uploadDocument(
    workstreamId: string,
    filePath: string,
    title: string,
    docType: string,
    currentStage: WorkstreamStage
  ): Promise<TCHubSyncResult> {
    const token = await this.getToken();
    if (!token) return { ok: false, error: "未配置 TCHub token，请在 Settings 页面配置，或设置环境变量 TCH_API_TOKEN" };

    try {
      // 使用 curl 上传文件
      const cmd = Command.create("sh", [
        "-c",
        `curl -s -X POST "https://tchub.ingageapp.com/api/documents/upload" \
          -H "Authorization: Bearer ${token}" \
          -F "file=@${filePath}" \
          -F "workstream_id=${workstreamId}" \
          -F "title=${title}" \
          -F "doc_type=${docType}" \
          -F "author_name=pipeline-engine" \
          -F "created_role=product" \
          -F "current_stage=${currentStage}"`,
      ]);
      const result = await cmd.execute();

      if (result.code !== 0) {
        return { ok: false, error: `上传失败: ${result.stderr}` };
      }

      const json = JSON.parse(result.stdout);
      return { ok: !!json.document?.id, data: json };
    } catch (err: any) {
      return { ok: false, error: err.message || "文档上传异常" };
    }
  }

  /** 检查 token 是否可用 */
  async isAvailable(): Promise<boolean> {
    const token = await this.getToken();
    return !!token;
  }
}

// 单例
export const tchubClient = new TCHubClient();
