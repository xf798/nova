// ===== Workspace 插件 — 工作目录管理 + 文件浏览 + 终端 =====

import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import { open } from "@tauri-apps/plugin-dialog";
import type { Plugin } from "../../types";
import { eventBus } from "../../../core/events";

// ─── 工作目录全局状态 ───

export interface WorkspaceDir {
  path: string;
  name: string; // 显示名（取目录名）
}

let _workspaceDirs: WorkspaceDir[] = [];
let _activeWorkspace: string | null = null;
let _listeners: (() => void)[] = [];

/** 获取所有工作目录 */
export function getWorkspaceDirs(): WorkspaceDir[] {
  return _workspaceDirs;
}

/** 获取当前活跃工作目录 */
export function getActiveWorkspace(): string | null {
  return _activeWorkspace;
}

/** 设置活跃工作目录 */
export function setActiveWorkspace(path: string | null): void {
  _activeWorkspace = path;
  eventBus.emit("workspace:changed", path);
  _listeners.forEach(fn => fn());
  persistWorkspaces();
}

/** 添加工作目录 */
export function addWorkspaceDir(path: string): void {
  if (_workspaceDirs.some(d => d.path === path)) return;
  const name = path.split("/").pop() || path;
  _workspaceDirs.push({ path, name });
  if (!_activeWorkspace) _activeWorkspace = path;
  eventBus.emit("workspace:added", path);
  _listeners.forEach(fn => fn());
  persistWorkspaces();
}

/** 移除工作目录 */
export function removeWorkspaceDir(path: string): void {
  _workspaceDirs = _workspaceDirs.filter(d => d.path !== path);
  if (_activeWorkspace === path) {
    _activeWorkspace = _workspaceDirs[0]?.path || null;
  }
  eventBus.emit("workspace:removed", path);
  _listeners.forEach(fn => fn());
  persistWorkspaces();
}

/** 订阅变更 */
export function onWorkspaceChange(fn: () => void): () => void {
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(l => l !== fn); };
}

/** 加载持久化的工作目录 */
export async function loadWorkspaces(): Promise<void> {
  try {
    const data = await invoke<string>("get_plugin_data", { pluginId: "workspace" });
    const parsed = JSON.parse(data || "{}");
    if (parsed.dirs && Array.isArray(parsed.dirs)) {
      _workspaceDirs = parsed.dirs;
    }
    if (parsed.active) {
      _activeWorkspace = parsed.active;
    }
  } catch {}
}

async function persistWorkspaces(): Promise<void> {
  try {
    await invoke("save_plugin_data", {
      pluginId: "workspace",
      data: JSON.stringify({ dirs: _workspaceDirs, active: _activeWorkspace }),
    });
  } catch {}
}

// ─── Hook ───

function useWorkspace() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const unsub = onWorkspaceChange(() => setTick(t => t + 1));
    return unsub;
  }, []);
  return { dirs: getWorkspaceDirs(), active: getActiveWorkspace() };
}

// ─── 文件浏览器 ───

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

function FileBrowser({ rootPath }: { rootPath: string }) {
  const [cwd, setCwd] = useState(rootPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [fileContent, setFileContent] = useState<{ name: string; content: string } | null>(null);

  const loadDir = async (path: string) => {
    setLoading(true);
    setFileContent(null);
    try {
      const result = await invoke<FileEntry[]>("list_directory", { path });
      setEntries(result);
      setCwd(path);
    } catch (e) {
      setEntries([]);
    }
    setLoading(false);
  };

  const openFile = async (path: string, name: string) => {
    try {
      const content = await invoke<string>("read_file_content", { path, maxBytes: 50000 });
      setFileContent({ name, content });
    } catch (e) {
      setFileContent({ name, content: `❌ 无法读取: ${e}` });
    }
  };

  useEffect(() => { loadDir(rootPath); }, [rootPath]);

  const parentDir = cwd.split("/").slice(0, -1).join("/") || "/";
  const canGoUp = cwd !== rootPath;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border">
        {canGoUp && (
          <button onClick={() => loadDir(parentDir)} className="text-app-text-muted hover:text-app-text text-sm">⬆</button>
        )}
        <span className="text-[12px] font-mono text-app-text-secondary truncate flex-1">{cwd}</span>
      </div>

      {fileContent ? (
        <div className="flex-1 overflow-auto">
          <div className="flex items-center justify-between px-3 py-2 border-b border-app-border">
            <span className="text-[12px] font-medium text-app-text">{fileContent.name}</span>
            <button onClick={() => setFileContent(null)} className="text-[11px] text-app-text-muted hover:text-app-text">✕ 关闭</button>
          </div>
          <pre className="p-3 text-[12px] font-mono text-app-text-secondary whitespace-pre-wrap leading-relaxed">
            {fileContent.content}
          </pre>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="p-4 text-[12px] text-app-text-muted">加载中...</div>
          ) : (
            <div className="divide-y divide-app-border">
              {entries.map(entry => (
                <button
                  key={entry.path}
                  onClick={() => entry.is_dir ? loadDir(entry.path) : openFile(entry.path, entry.name)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-app-surface-hover transition-colors"
                >
                  <span className="flex items-center justify-center w-4 h-4 shrink-0">{entry.is_dir
                    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  }</span>
                  <span className="text-[12px] text-app-text truncate flex-1">{entry.name}</span>
                  {!entry.is_dir && (
                    <span className="text-[10px] text-app-text-muted">{formatSize(entry.size)}</span>
                  )}
                </button>
              ))}
              {entries.length === 0 && <div className="p-4 text-[12px] text-app-text-muted">空目录</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 终端 ───

interface TermLine {
  type: "input" | "output" | "error";
  content: string;
}

function Terminal({ cwd }: { cwd: string }) {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<TermLine[]>([
    { type: "output", content: `工作目录: ${cwd}` },
  ]);
  const [running, setRunning] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [lines]);
  useEffect(() => {
    setLines([{ type: "output", content: `工作目录: ${cwd}` }]);
  }, [cwd]);

  const runCommand = async () => {
    const cmd = input.trim();
    if (!cmd || running) return;
    setInput("");
    setLines(prev => [...prev, { type: "input", content: `$ ${cmd}` }]);
    setRunning(true);

    try {
      // 使用 shell -c 来支持管道、重定向等
      const command = Command.create("sh", ["-c", cmd], {
        cwd,
        encoding: "utf-8",
      });

      let stdout = "";
      let stderr = "";
      command.stdout.on("data", (d) => { stdout += d; });
      command.stderr.on("data", (d) => { stderr += d; });

      await command.spawn();
      await new Promise<void>((resolve) => {
        command.on("close", () => resolve());
        setTimeout(() => resolve(), 30000);
      });

      if (stdout.trim()) setLines(prev => [...prev, { type: "output", content: stdout.trim() }]);
      if (stderr.trim()) setLines(prev => [...prev, { type: "error", content: stderr.trim() }]);
      if (!stdout.trim() && !stderr.trim()) setLines(prev => [...prev, { type: "output", content: "(无输出)" }]);
    } catch (e: any) {
      setLines(prev => [...prev, { type: "error", content: `❌ ${e.message || e}` }]);
    }
    setRunning(false);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto p-3 font-mono text-[12px] leading-relaxed">
        {lines.map((line, i) => (
          <div key={i} className={
            line.type === "input" ? "text-[#10a37f] font-medium" :
            line.type === "error" ? "text-red-400" :
            "text-app-text-secondary"
          }>
            {line.content}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex items-center gap-2 px-3 py-2 border-t border-app-border">
        <span className="text-[#10a37f] text-[12px] font-mono font-bold">$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") runCommand(); }}
          placeholder="输入命令..."
          disabled={running}
          className="flex-1 bg-transparent text-[12px] font-mono text-app-text focus:outline-none disabled:opacity-50 placeholder:text-app-text-muted"
        />
        {running && <span className="text-[10px] text-app-text-muted animate-pulse">运行中</span>}
      </div>
    </div>
  );
}

// ─── Workspace 主页面 ───

export function WorkspacePage() {
  const { dirs, active } = useWorkspace();
  const [tab, setTab] = useState<"files" | "terminal">("files");

  const handlePickFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择工作目录",
    });
    if (selected && typeof selected === "string") {
      addWorkspaceDir(selected);
    }
  };

  // 空状态
  if (dirs.length === 0) {
    return (
      <div className="max-w-3xl mx-auto w-full">
        <h2 className="text-xl font-semibold mb-2">Workspace</h2>
        <p className="text-[13px] text-app-text-muted mb-8">添加工作目录，在 Chat 中可选择目标工程。</p>

        <div className="flex flex-col items-center justify-center py-20">
          <div className="text-4xl mb-4">📂</div>
          <p className="text-base text-app-text-muted mb-2">暂无工作目录</p>
          <p className="text-sm text-app-text-muted mb-6">添加项目目录后，可在聊天时切换上下文</p>

          <button
            onClick={handlePickFolder}
            className="px-5 py-2.5 bg-[#10a37f] hover:bg-[#0d8c6d] rounded-xl text-[13px] font-medium text-white transition-colors"
          >
            选择文件夹
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto w-full h-full flex flex-col">
      {/* 顶栏 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">Workspace</h2>
          <div className="flex items-center gap-0.5 rounded-full p-0.5" style={{ backgroundColor: "var(--app-surface-hover)" }}>
            <TabBtn active={tab === "files"} onClick={() => setTab("files")} label="Files" />
            <TabBtn active={tab === "terminal"} onClick={() => setTab("terminal")} label="Terminal" />
          </div>
        </div>
        <button
          onClick={handlePickFolder}
          className="px-3 py-1.5 text-[12px] rounded-lg border border-app-border text-app-text-muted hover:text-app-text hover:border-app-text-muted transition-colors"
        >
          + 添加目录
        </button>
      </div>

      {/* 工作目录切换条 */}
      <div className="flex items-center gap-1 mb-3 overflow-x-auto pb-1">
        {dirs.map(d => (
          <div key={d.path} className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => setActiveWorkspace(d.path)}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${
                active === d.path
                  ? "bg-[#10a37f]/10 text-[#10a37f] border border-[#10a37f]/30"
                  : "text-app-text-muted hover:text-app-text hover:bg-app-surface-hover border border-transparent"
              }`}
              title={d.path}
            >
              {d.name}
            </button>
            <button
              onClick={() => removeWorkspaceDir(d.path)}
              className="w-4 h-4 flex items-center justify-center text-[10px] text-app-text-muted hover:text-red-400 opacity-0 hover:opacity-100 transition-opacity"
              title="移除"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* 内容区 */}
      {active && (
        <div className="flex-1 overflow-hidden rounded-xl border border-app-border">
          {tab === "files" ? <FileBrowser rootPath={active} /> : <Terminal cwd={active} />}
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-all ${
        active ? "bg-app-bg text-app-text shadow-sm" : "text-app-text-muted hover:text-app-text-secondary"
      }`}>
      {label}
    </button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ─── 侧边栏图标 ───

function IconCode() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
    </svg>
  );
}

// ─── 插件导出 ───

export const workspacePlugin: Plugin = {
  id: "workspace",
  name: "Workspace",
  version: "1.0.0",
  description: "工作目录管理 + 文件浏览 + 终端",

  sidebarItems: [
    {
      id: "workspace",
      label: "Projects",
      icon: <IconCode />,
      order: 35,
      component: () => <WorkspacePage />,
    },
  ],

  activate() {
    // 启动时加载持久化的工作目录
    loadWorkspaces();
  },
};
