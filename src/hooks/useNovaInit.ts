import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { initBuiltinConnectors, connectorRegistry, KiroCliConnector } from "../connectors";
import { loadPlugins } from "../plugins";
import { loadSkills } from "../core/skills";
import { registerCodingTools } from "../core/tools/coding";
import { scheduler } from "../core/scheduler";
import { registerDistillJob, ensureDefaultDistillJobs } from "../core/distill";
import { checkOnly, getAutoCheckEnabled } from "../core/updater";
import { useSessionStore } from "../core/sessionStore";
import type { ChatSession } from "../core/types";

interface UseNovaInitParams {
  activeConnectorId: string;
  setHasFullDiskAccess: (v: boolean) => void;
}

export function useNovaInit({ activeConnectorId, setHasFullDiskAccess }: UseNovaInitParams) {
  useEffect(() => {
    const load = async () => {
      const loadStart = Date.now();
      console.log('[Nova Init] 🚀 开始初始化加载...');
      const dbg = (msg: string) => invoke("debug_log", { msg }).catch(() => {});
      const t0 = performance.now();
      dbg("[Init] ═══ Nova 前端初始化开始 ═══");

      // 初始化内置连接器
      console.log('[Nova Init] 📦 初始化内置连接器...');
      const t1 = performance.now();
      await initBuiltinConnectors();
      dbg(`[Init] initBuiltinConnectors 完成 (${(performance.now() - t1).toFixed(0)}ms)`);

      // 注册 Coding Tools（file_read, file_write, file_edit, bash, glob, grep）
      registerCodingTools();

      // 启动 Nova MCP Server
      try {
        const mcpPort = await invoke<number>("start_mcp_server_cmd");
        console.log(`[Nova:Init] ✅ MCP Server 启动成功: http://127.0.0.1:${mcpPort}/mcp`);
        const mcpServerConfig = {
          type: "http" as const,
          name: "nova-tools",
          url: `http://127.0.0.1:${mcpPort}/mcp`,
        };
        const cliConnectors = connectorRegistry.getByType("cli") as KiroCliConnector[];
        for (const conn of cliConnectors) {
          conn.registerMcpServer(mcpServerConfig);
        }
        (window as any).__novaMcpPort = mcpPort;
      } catch (e) {
        console.warn("[Nova:Init] ⚠️ MCP Server 启动失败:", e);
      }

      // 加载插件
      console.log('[Nova Init] 🔌 加载插件...');
      const t2 = performance.now();
      await loadPlugins();
      dbg(`[Init] loadPlugins 完成 (${(performance.now() - t2).toFixed(0)}ms)`);

      // 同步 kiro skills
      console.log('[Nova Init] 📚 同步并加载 Skills...');
      try {
        const t3 = performance.now();
        await invoke("sync_kiro_skills_to_app");
        await loadSkills();
        dbg(`[Init] skills 同步+加载完成 (${(performance.now() - t3).toFixed(0)}ms)`);
      } catch (e) {
        console.warn("[Init] skills 同步失败:", e);
      }

      // 初始化 sessionStore（迁移 + 加载索引 + 预加载活跃会话）
      try {
        const t4 = performance.now();
        await useSessionStore.getState().init((sessions) => {
          // 修正企微会话 title
          const botConnectors = connectorRegistry.getBotConnectors();
          if (botConnectors.length === 0) return sessions;
          const bot = botConnectors[0];
          const botLabel = bot.config.botName
            ? `企微-${bot.config.botName}`
            : bot.config.botId
            ? `企微-${bot.config.botId.slice(0, 8)}`
            : "企微";
          return sessions.map((s: ChatSession) => {
            if (!s.id.startsWith("wecom-")) return s;
            let chatLabel = s.title.replace(/^\[[^\]]*\]\s*/, "");
            if (!chatLabel || /^[a-zA-Z0-9_-]{16,}$/.test(chatLabel) || chatLabel.startsWith("用户")) {
              chatLabel = "历史会话";
            }
            const newTitle = `[${botLabel}] ${chatLabel || "会话"}`;
            return s.title !== newTitle ? { ...s, title: newTitle } : s;
          });
        });
        dbg(`[Init] 聊天历史加载成功: ${useSessionStore.getState().sessions.length} 个会话 (${(performance.now() - t4).toFixed(0)}ms)`);
      } catch (e) {
        dbg(`[Init] ❌ 聊天历史加载失败: ${e}`);
        console.error("[Init] ❌ 聊天历史加载失败:", e);
        const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        useSessionStore.getState().createSession({
          id: newSessionId,
          title: "新会话",
          connectorId: activeConnectorId,
          connectorSessionId: null,
        });
        useSessionStore.getState().setActiveSessionId(newSessionId);
      }

      // 自动连接企微机器人
      try {
        const t5 = performance.now();
        const botConnectors = connectorRegistry.getBotConnectors();
        dbg(`[Init] 企微 bot 连接器数: ${botConnectors.length}`);
        for (const bot of botConnectors) {
          dbg(`[Init] bot: id=${bot.config.id}, botId=${bot.config.botId ? "(set)" : "(empty)"}, autoConnect=${bot.config.autoConnect}`);
          if (bot.config.botId && bot.config.botSecret && bot.config.autoConnect !== false) {
            dbg("[Init] 企微 bot 开始自动连接...");
            console.log(`[Nova:Init] 🔗 企微自动连接...`);
            await bot.connect();
            dbg(`[Init] 企微 bot 自动连接完成 (${(performance.now() - t5).toFixed(0)}ms)`);
          }
        }
      } catch (e) {
        dbg(`[Init] ❌ 企微 bot 自动连接失败: ${e}`);
        console.error("[Init] ❌ 企微 bot 自动连接失败:", e);
      }

      console.log(`[Nova:Init] 🎉 初始化全部完成，总耗时 ${Date.now()-loadStart}ms`);

      // 初始化调度引擎 + 注册自动蒸馏 job（默认关闭，用户在 Settings 开启）
      try {
        registerDistillJob();
        await scheduler.init();
        await ensureDefaultDistillJobs();
        dbg(`[Init] 调度引擎就绪: ${scheduler.getJobs().length} 个 job`);
      } catch (e) {
        console.warn("[Init] 调度引擎初始化失败:", e);
      }

      // 检查完全磁盘访问权限
      try {
        const hasFDA = await invoke<boolean>("check_full_disk_access");
        setHasFullDiskAccess(hasFDA);
        if (!hasFDA) {
          console.log("[Nova:Init] ⚠️ 未获得完全磁盘访问权限");
        }
      } catch {}

      // 启动时静默检查更新（仅提示，不自动安装）
      // 延迟执行避免与初始化争抢网络/CPU；dev 模式下 updater 不可用会静默失败
      setTimeout(async () => {
        try {
          if (!(await getAutoCheckEnabled())) return;
          const st = await checkOnly();
          if (st.stage === "available") {
            window.dispatchEvent(new CustomEvent("nova-notify", {
              detail: { msg: `发现新版本 v${st.newVersion}，可在 设置 → 关于与更新 中安装`, type: "info" },
            }));
            dbg(`[Init] 发现新版本: ${st.newVersion}`);
          } else {
            dbg(`[Init] 更新检查: ${st.stage}`);
          }
        } catch (e) {
          console.warn("[Init] 更新检查失败:", e);
        }
      }, 5000);

      dbg(`[Init] ═══ Nova 前端初始化完成 ═══ 总耗时: ${(performance.now() - t0).toFixed(0)}ms`);
    };
    load();
  }, []);
}
