import { invoke } from "@tauri-apps/api/core";
import { toolRegistry } from "../registry";
import type { ToolDefinition } from "../types";

export const fileEditDef: ToolDefinition = {
  name: "file_edit",
  description: "Make a targeted edit to an existing file using search and replace. The old_str must match exactly one location in the file (unless replace_all is true). Always read the file first to get the exact text to match.",
  category: "coding",
  pluginId: "__nova_coding__",
  scope: "local",
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultChars: 10000,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file to edit" },
      old_str: { type: "string", description: "The exact text to find in the file (must be unique)" },
      new_str: { type: "string", description: "The replacement text" },
      replace_all: { type: "boolean", description: "If true, replace all occurrences (default: false)" },
    },
    required: ["path", "old_str", "new_str"],
  },
};

export function registerFileEdit() {
  toolRegistry.register("file_edit", async (params) => {
    const { path, old_str, new_str, replace_all } = params || {};
    if (!path) return { ok: false, error: "Missing required parameter: path" };
    if (!old_str) return { ok: false, error: "Missing required parameter: old_str" };
    if (new_str === undefined) return { ok: false, error: "Missing required parameter: new_str" };
    try {
      const result = await invoke<string>("tool_file_edit", { path, oldStr: old_str, newStr: new_str, replaceAll: replace_all });
      return { ok: true, data: result };
    } catch (err: any) {
      return { ok: false, error: String(err) };
    }
  }, fileEditDef);
}
