// ===== 召回明细 =====
//
// 展示本次请求「注入了哪些记忆与技能」，属于请求发出前的上下文构建结果，
// 与「回复过程中做了什么」（ProcessTimeline）是两回事，因此独立成块，
// 位置在过程时间线之前。

import { useState } from "react";
import type { RecallInfo } from "../../core/types";

function RecallBlock({ recall }: { recall: RecallInfo }) {
  const [expanded, setExpanded] = useState(false);

  if (recall.memories.length === 0 && recall.skills.length === 0) return null;

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-[12px] text-app-text-muted hover:text-app-text-secondary transition-colors"
      >
        <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="text-blue-500 dark:text-blue-400" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.5.4.8 1 .9 1.6M12 2a7 7 0 0 1 4 12.7c-.5.4-.8 1-.9 1.6"/></svg>
        </div>
        <span>
          召回 {recall.memories.length > 0 && `${recall.memories.length} 记忆`}
          {recall.memories.length > 0 && recall.skills.length > 0 && " · "}
          {recall.skills.length > 0 && `${recall.skills.length} 技能`}
          {recall.estimated && " · 预计"}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>

      {expanded && (
        <div className="mt-1.5 ml-7 flex flex-col gap-2 max-w-[680px]">
          {recall.skills.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wide">技能</span>
              {recall.skills.map((s) => (
                <div key={s.name} className="flex items-start gap-1.5 text-[11px]">
                  <span className={`shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium ${
                    s.source === "query" ? "bg-blue-500/15 text-blue-500" : s.source === "path" ? "bg-purple-500/15 text-purple-500" : "bg-app-surface-hover text-app-text-muted"
                  }`}>
                    {s.source === "query" ? "场景召回" : s.source === "path" ? "路径" : "常驻"}
                  </span>
                  <span className="text-app-text-secondary min-w-0">
                    {s.displayName}
                    {s.distilled && <span className="ml-1 text-[9px] text-green-500">✦蒸馏</span>}
                    {typeof s.score === "number" && <span className="ml-1 text-app-text-muted">{s.score.toFixed(2)}</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          {recall.memories.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wide">记忆</span>
              {recall.memories.map((m, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px]">
                  <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-app-surface-hover text-app-text-muted">{m.category}</span>
                  <span className="text-app-text-secondary min-w-0 leading-relaxed">
                    {m.content.length > 120 ? m.content.slice(0, 120) + "…" : m.content}
                    {m.distilled && <span className="ml-1 text-[9px] text-green-500">✦蒸馏</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          {recall.estimated && (
            <p className="text-[9px] text-app-text-muted">※ 当前连接器由其自身加载技能，此处为 Nova 按同一算法的预计召回，可能与实际注入不完全一致。</p>
          )}
        </div>
      )}
    </div>
  );
}

export default RecallBlock;
