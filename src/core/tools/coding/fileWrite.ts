import { invoke } from "@tauri-apps/api/core";
import { toolRegistry } from "../registry";
import type { ToolDefinition } from "../types";

export const fileWriteDef: ToolDefinition = {
  name: "file_write",
  description: "Create a new file or overwrite an existing file with the given content. Parent directories are created automatically.",
  category: "coding",
  pluginId: "__nova_coding__",
  scope: "local",
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultChars: 5000,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file to write" },
      content: { type: "string", description: "The full content to write to the file" },
    },
    required: ["path", "content"],
  },
};

export function registerFileWrite() {
  toolRegistry.register("file_write", async (params) => {
    const { path, content } = params || {};
    if (!path) return { ok: false, error: "Missing required parameter: path" };
    if (content === undefined) return { ok: false, error: "Missing required parameter: content" };
    try {
      const result = await invoke<string>("tool_file_write", { path, content });
      return { ok: true, data: result };
    } catch (err: any) {
      return { ok: false, error: String(err) };
    }
  }, fileWriteDef);
}
