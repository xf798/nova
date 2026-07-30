import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toolRegistry } from "../core/tools";
import { useSessionStore } from "../core/sessionStore";

export function useMcpBridge() {
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    (async () => {
      unlisten = await listen<{ request_id: string; method: string; params?: any }>("mcp-request", async (event) => {
        const { request_id, method, params } = event.payload;

        try {
          if (method === "tools/list") {
            // 过滤掉 scope="local" 的 tools（coding tools 不暴露给 kiro-cli）
            const metas = toolRegistry.list().filter(m => (m as any).scope !== "local");
            const tools = metas.map(m => ({
              name: m.name,
              description: m.description,
              inputSchema: {
                type: "object",
                properties: Object.fromEntries(
                  (m.params || []).map(p => [p.name, {
                    type: p.type,
                    description: p.description,
                    ...(p.enum ? { enum: p.enum } : {}),
                  }])
                ),
                required: (m.params || []).filter(p => p.required).map(p => p.name),
              },
            }));
            await invoke("mcp_respond", { payload: { request_id, result: { tools } } });
          } else if (method === "tools/call") {
            const toolName = params?.name;
            const toolArgs = params?.arguments;

            if (!toolName) {
              await invoke("mcp_respond", { payload: { request_id, error: "Missing tool name" } });
              return;
            }

            const result = await toolRegistry.call(toolName, toolArgs);

            if (result.ok) {
              // 当 ui.screenshot 成功时，将图片附加到当前 assistant 消息
              if (toolName === "ui.screenshot" && result.data) {
                const screenshotPath = (result.data as { path?: string }).path;
                if (screenshotPath) {
                  const { activeSessionId, sessions, updateMessages } = useSessionStore.getState();
                  if (activeSessionId) {
                    const session = sessions.find(s => s.id === activeSessionId);
                    if (session && session.messages.length > 0) {
                      const lastMsg = session.messages[session.messages.length - 1];
                      if (lastMsg.role === "assistant") {
                        updateMessages(activeSessionId, (msgs) =>
                          msgs.map((m, i) => i === msgs.length - 1
                            ? { ...m, attachments: [...(m.attachments || []), screenshotPath] }
                            : m
                          )
                        );
                      }
                    }
                  }
                }
              }

              const textContent = result.data != null
                ? JSON.stringify(result.data, null, 2)
                : "OK";
              await invoke("mcp_respond", {
                payload: {
                  request_id,
                  result: {
                    content: [{ type: "text", text: textContent }],
                    isError: false,
                  },
                },
              });
            } else {
              await invoke("mcp_respond", {
                payload: {
                  request_id,
                  result: {
                    content: [{ type: "text", text: result.error || "Tool execution failed" }],
                    isError: true,
                  },
                },
              });
            }
          } else {
            await invoke("mcp_respond", { payload: { request_id, error: `Unknown method: ${method}` } });
          }
        } catch (err: any) {
          await invoke("mcp_respond", { payload: { request_id, error: err.message || "Bridge error" } });
        }
      });
    })();

    return () => { if (unlisten) unlisten(); };
  }, []);
}
