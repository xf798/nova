import { invoke } from "@tauri-apps/api/core";
import { toolRegistry } from "../registry";
import type { ToolDefinition } from "../types";

export const fileReadDef: ToolDefinition = {
  name: "file_read",
  description: "Read the contents of a file. Returns text with line numbers. Use offset and limit to read specific line ranges.",
  category: "coding",
  pluginId: "__nova_coding__",
  scope: "local",
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 100000,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file to read" },
      offset: { type: "number", description: "Start line number (0-indexed, optional)" },
      limit: { type: "number", description: "Maximum number of lines to read (optional)" },
    },
    required: ["path"],
  },
};

export function registerFileRead() {
  toolRegistry.register("file_read", async (params) => {
    const { path, offset, limit } = params || {};
    if (!path) return { ok: false, error: "Missing required parameter: path" };
    try {
      const content = await invoke<string>("tool_file_read", { path, offset, limit });
      return { ok: true, data: content };
    } catch (err: any) {
      return { ok: false, error: String(err) };
    }
  }, fileReadDef);
}
