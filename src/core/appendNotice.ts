/**
 * 异常提示的追加
 *
 * 提示必须同时写进 content 和 timeline，否则用户看不到。
 *
 * MessageItem 在 meta.timeline 存在时只渲染 timeline 事件，content 不单独渲染。
 * 于是「只追加到 content」的提示全是隐形的 —— 实测踩中三处：
 * 连接器的「生成中断，以上为部分内容」、工具轮次上限提示、Agent 侧中断提示。
 * 用户看到的就是「说了一句开场白、跑了几个工具、然后没有下文」。
 *
 * 换个角度说，content 与 timeline 的文本本该互为镜像
 * （实测 589 条历史消息里两者总量吻合），只动一边就是破坏这个不变量。
 */

import type { TimelineEvent } from "../connectors/base";

/**
 * 把一段提示追加到正文与过程时间线。
 *
 * @param content 当前正文
 * @param timeline 过程时间线（原地追加；为空数组时说明该消息不走 timeline 渲染，跳过）
 * @param notice 提示文本
 * @param now 时间戳来源（便于测试）
 * @returns 追加后的正文
 */
export function appendNotice(
  content: string,
  timeline: TimelineEvent[],
  notice: string,
  now: () => number = Date.now,
): string {
  const next = content ? `${content}\n\n${notice}` : notice;
  // timeline 为空表示这条消息没有过程流，渲染层会走 content，无需重复追加
  if (timeline.length > 0) {
    timeline.push({ kind: "text", text: content ? `\n\n${notice}` : notice, at: now() });
  }
  return next;
}
