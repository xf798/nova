import { invoke } from "@tauri-apps/api/core";
import { toolRegistry } from "../registry";
import type { ToolDefinition } from "../types";

interface BashOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  truncated: boolean;
  duration_ms: number;
}

export const bashDef: ToolDefinition = {
  name: "bash",
  description: "Execute a shell command. Use this for running builds, tests, git commands, installing packages, or any CLI operation. Commands run in a shell (sh -c). Default timeout is 30 seconds.",
  category: "coding",
  pluginId: "__nova_coding__",
  scope: "local",
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultChars: 50000,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      cwd: { type: "string", description: "Working directory for the command (optional, defaults to the current working directory)" },
      timeout: { type: "number", description: "Timeout in milliseconds (optional, default 30000, max 300000)" },
    },
    required: ["command"],
  },
};

export function registerBash() {
  toolRegistry.register("bash", async (params, ctx) => {
    const { command, cwd, timeout } = params || {};
    if (!command) return { ok: false, error: "Missing required parameter: command" };
    try {
      const output = await invoke<BashOutput>("tool_bash", {
        command,
        // 缺省用会话工作目录：命令在家目录跑既不符合预期，
        // 也容易让 ls/find 之类撞上 TCC 保护目录触发弹框
        cwd: cwd || ctx?.cwd || undefined,
        timeoutMs: timeout || undefined,
      });

      // 格式化输出为可读文本
      let result = "";
      if (output.stdout) {
        result += output.stdout;
      }
      if (output.stderr) {
        result += (result ? "\n\n" : "") + `[stderr]\n${output.stderr}`;
      }
      if (output.exit_code !== 0) {
        result += (result ? "\n\n" : "") + `[exit code: ${output.exit_code}]`;
      }
      if (output.truncated) {
        result += "\n[output was truncated]";
      }

      return { ok: output.exit_code === 0, data: result || "(no output)", error: output.exit_code !== 0 ? `Command exited with code ${output.exit_code}` : undefined };
    } catch (err: any) {
      return { ok: false, error: String(err) };
    }
  }, bashDef);
}
