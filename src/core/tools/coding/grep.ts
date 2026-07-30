import { invoke } from "@tauri-apps/api/core";
import { toolRegistry } from "../registry";
import type { ToolDefinition } from "../types";

export const grepDef: ToolDefinition = {
  name: "grep",
  description: "Search file contents using a regex pattern. Returns matching lines with file paths and line numbers. Automatically skips binary files and .git/node_modules directories.",
  category: "coding",
  pluginId: "__nova_coding__",
  scope: "local",
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 50000,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Directory or file to search in (optional, defaults to home)" },
      include: { type: "string", description: "Glob pattern to filter file names (e.g. '*.ts', '*.{js,jsx}')" },
      limit: { type: "number", description: "Maximum number of matching lines (optional, default 100, max 500)" },
    },
    required: ["pattern"],
  },
};

export function registerGrep() {
  toolRegistry.register("grep", async (params) => {
    const { pattern, path, include, limit } = params || {};
    if (!pattern) return { ok: false, error: "Missing required parameter: pattern" };
    try {
      const result = await invoke<string>("tool_grep", { pattern, path, include, limit });
      return { ok: true, data: result };
    } catch (err: any) {
      return { ok: false, error: String(err) };
    }
  }, grepDef);
}
