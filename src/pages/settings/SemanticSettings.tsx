// ===== 语义召回设置 =====
//
// 模型不打进应用包（那会让分发包从 9.8MB 涨到 60MB+），
// 改为在这里按需下载：约 47MB，走加速代理实测 11 秒。

import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getEmbeddingStatus,
  downloadModel,
  removeModel,
  indexMemories,
} from "../../core/memory/semantic";
import type { EmbeddingStatus } from "../../core/memory/semantic";
import { longTermMemory } from "../../core/memory/longterm";

interface Progress {
  file: string;
  downloaded: number;
  total: number;
  source: string;
}

const MB = 1048576;

function SemanticSettings() {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [busy, setBusy] = useState<"download" | "index" | "remove" | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexed, setIndexed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await getEmbeddingStatus());
  }, []);

  useEffect(() => {
    refresh();
    const un = listen<Progress>("nova-model-download", e => setProgress(e.payload));
    return () => { un.then(f => f()); };
  }, [refresh]);

  const handleDownload = async () => {
    setBusy("download");
    setError(null);
    setProgress(null);
    try {
      await downloadModel();
      await refresh();
      // 下载完直接建索引，省得用户再点一次
      await handleIndex(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const handleIndex = async (silent = false) => {
    if (!silent) setBusy("index");
    setError(null);
    try {
      const all = await longTermMemory.getAll();
      const r = await indexMemories(
        all.filter(m => m.content).map(m => ({ id: m.id, content: m.content })),
      );
      setIndexed(`已索引 ${r.indexed} 条${r.newlyEncoded > 0 ? `（新编码 ${r.newlyEncoded} 条）` : ""}`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      if (!silent) setBusy(null);
    }
  };

  const handleRemove = async () => {
    setBusy("remove");
    setError(null);
    try {
      await removeModel();
      setIndexed(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const totalSize = status?.files.reduce((s, f) => s + f.size, 0) ?? 0;
  const pct = progress && progress.total > 0
    ? Math.round((progress.downloaded / progress.total) * 100)
    : undefined;

  const statusText = (() => {
    if (busy === "download") {
      if (!progress) return "准备下载…";
      return `正在下载 ${progress.file}${pct !== undefined ? ` ${pct}%` : ""}`;
    }
    if (busy === "index") return "正在建立索引…";
    if (busy === "remove") return "正在移除…";
    if (status?.ready) {
      return `语义召回已启用 · 已索引 ${status.indexedCount} 条记忆`;
    }
    return "语义召回未启用";
  })();

  const hint = (() => {
    if (error) return error;
    if (busy === "download" && progress) {
      return `${(progress.downloaded / MB).toFixed(1)} / ${(progress.total / MB).toFixed(1)} MB · 来源 ${progress.source}`;
    }
    if (indexed) return indexed;
    if (status?.ready) return `模型占用 ${(totalSize / MB).toFixed(0)} MB`;
    return "下载约 47 MB 的本地模型，让记忆召回理解语义而非只匹配字面。模型不含在应用包内。";
  })();

  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-app-text">{statusText}</p>
        <p className={`text-[12px] mt-0.5 leading-relaxed ${error ? "text-red-400" : "text-app-text-muted"}`}>
          {hint}
        </p>
        {busy === "download" && pct !== undefined && (
          <div className="mt-1.5 h-1 rounded-full bg-app-surface-hover overflow-hidden">
            <div className="h-full bg-[#10a37f] transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {status?.ready ? (
          <>
            <button
              onClick={() => handleIndex()}
              disabled={busy !== null}
              className="px-2.5 py-1 rounded-md text-[12px] text-app-text-muted hover:text-app-text disabled:opacity-40 transition-colors"
            >
              重建索引
            </button>
            <button
              onClick={handleRemove}
              disabled={busy !== null}
              className="px-2.5 py-1 rounded-md text-[12px] text-app-text-muted hover:text-red-400 disabled:opacity-40 transition-colors"
            >
              移除
            </button>
          </>
        ) : (
          <button
            onClick={handleDownload}
            disabled={busy !== null}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-[#10a37f] text-white hover:bg-[#0d8c6d] disabled:opacity-40 transition-colors"
          >
            {busy === "download" ? "下载中…" : "下载并启用"}
          </button>
        )}
      </div>
    </div>
  );
}

export default SemanticSettings;
