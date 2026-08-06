// ===== 会话切换耗时测量 =====
//
// 「点击消息多的会话还是卡一下」反复出现，前几轮都是靠推断定位，改了三次
// 都没根治。这里改为实测：把切换拆成阶段分别计时，写入 frontend.log。
//
// 阶段划分：
//   click  → 点击发生（switchSession 入口）
//   store  → activeSessionId 已更新（同步，衡量 store 写入成本）
//   data   → 消息已就位（缓存命中为 0，未加载则含读盘 + IPC）
//   commit → React 完成渲染提交（useLayoutEffect，DOM 已在但还没绘制）
//   paint  → 浏览器完成绘制（rAF 回调，这之后用户才真正看到）
//
// 用 requestAnimationFrame 捕捉 paint：它在下一次绘制前触发，配合两层
// rAF 可以近似「已绘制」的时刻。

import { invoke } from "@tauri-apps/api/core";

interface Marks {
  sessionId: string;
  click: number;
  store?: number;
  data?: number;
  commit?: number;
  paint?: number;
  messageCount?: number;
  cached?: boolean;
}

let current: Marks | null = null;

/** 是否开启测量。改为 true 后重启 dev 生效 */
const ENABLED = true;

export function markClick(sessionId: string, cached: boolean): void {
  if (!ENABLED) return;
  current = { sessionId, click: performance.now(), cached };
}

export function markStore(): void {
  if (!ENABLED || !current) return;
  current.store = performance.now();
}

export function markData(messageCount: number): void {
  if (!ENABLED || !current) return;
  current.data = performance.now();
  current.messageCount = messageCount;
}

/** 渲染提交后调用（useLayoutEffect 里），随后自动等绘制完成并上报 */
export function markCommitAndReport(): void {
  if (!ENABLED || !current) return;
  const m = current;
  m.commit = performance.now();
  // 两层 rAF：第一层在下一帧绘制前，第二层已在绘制之后
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      m.paint = performance.now();
      report(m);
    });
  });
  current = null;
}

function report(m: Marks): void {
  const d = (a?: number, b?: number) =>
    a !== undefined && b !== undefined ? (a - b).toFixed(0).padStart(4) : "   -";
  const total = m.paint !== undefined ? (m.paint - m.click).toFixed(0) : "?";
  const line =
    `⏱ [SWITCH] ${m.sessionId.slice(8, 22)} ${m.messageCount ?? "?"}条 ` +
    `${m.cached ? "缓存" : "读盘"} | ` +
    `store ${d(m.store, m.click)}ms  ` +
    `data ${d(m.data, m.store)}ms  ` +
    `commit ${d(m.commit, m.data ?? m.store)}ms  ` +
    `paint ${d(m.paint, m.commit)}ms  ` +
    `= 合计 ${total}ms`;
  invoke("debug_log", { msg: line }).catch(() => {});
}
