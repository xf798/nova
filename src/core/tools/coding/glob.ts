import { invoke } from "@tauri-apps/api/core";
import { toolRegistry } from "../registry";
import type { ToolDefinition } from "../types";

export const globDef: ToolDefinition = {
  name: "glob",
  description: "Find files by name pattern. Searches recursively from the given path. Automatically excludes .git, node_modules, target, dist, build directories.",
  category: "coding",
  pluginId: "__nova_coding__",
  scope: "local",
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 30000,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match file names (e.g. '*.ts', '*.{ts,tsx}', 'test_*')" },
      path: { type: "string", description: "Root directory to search from (optional, defaults to home)" },
      limit: { type: "number", description: "Maximum number of results (optional, default 200, max 1000)" },
    },
    required: ["pattern"],
  },
};

export function registerGlob() {
  toolRegistry.register("glob", async (params) => {
    const { pattern, path, limit } = params || {};
    if (!pattern) return { ok: false, error: "Missing required parameter: pattern" };
    try {
      const files = await invoke<string[]>("tool_glob", { pattern, path, limit });
      if (files.length === 0) {
        return { ok: true, data: `No files found matching pattern: ${pattern}` };
      }
      return { ok: true, data: files.join("\n") + `\n\n[${files.length} files found]` };
    } catch (err: any) {
      return { ok: false, error: String(err) };
    }
  }, globDef);
}
