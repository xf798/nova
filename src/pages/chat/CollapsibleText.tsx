// ===== 超长纯文本折叠 =====
//
// 用户消息不走 markdown，是 whitespace-pre-wrap 直出纯文本。
// 实测有单条 150KB 的用户消息（贴进来的大段日志），整段塞进一个节点会让
// 浏览器绘制不动 —— 该会话的切换耗时里 paint 占 164ms，而 React 渲染只要 44ms。
//
// 阈值与 MarkdownBody 保持一致：全部 4053 个真实文本段里，超过 8KB 的
// 只占 0.6%，却占了 64% 的正文量。折叠这一小撮几乎不影响正常阅读。

import { useState } from "react";

const COLLAPSE_THRESHOLD = 8 * 1024;
const PREVIEW_CHARS = 2 * 1024;

/** 在换行处截断，避免把一行劈开 */
function cutAtLineBreak(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const nl = text.lastIndexOf("\n", limit);
  // 前段没有换行（极长单行）时就按字符硬截
  return text.slice(0, nl > limit * 0.5 ? nl : limit);
}

function CollapsibleText({ text, className, style }: {
  text: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const collapsible = text.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  const shown = collapsible && !expanded ? cutAtLineBreak(text, PREVIEW_CHARS) : text;

  return (
    <div className={className} style={style}>
      {shown}
      {collapsible && (
        <>
          {!expanded && "…"}
          <button
            onClick={() => setExpanded(!expanded)}
            className="block mt-1.5 text-[12px] opacity-60 hover:opacity-100 underline transition-opacity"
          >
            {expanded ? "收起" : `展开全文（共 ${(text.length / 1024).toFixed(0)}KB）`}
          </button>
        </>
      )}
    </div>
  );
}

export default CollapsibleText;
