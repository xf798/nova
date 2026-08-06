/**
 * 底部跟随决策
 *
 * 会话里有两处滚动到底：
 *   1. 切换会话/消息增减后的重新定位 —— 直接赋 scrollTop，要求一步到位
 *   2. 流式输出期间的跟随     —— 平滑滚动，跟着新内容走
 *
 * 两者不能在同一次提交里同时发生。平滑滚动是跨帧动画，会盖掉同帧的直接
 * 赋值，最终停在动画开始时算出的旧目标上——表现就是「切换会话后没到底部，
 * 下方一片空白」。所以切换会话的那一次提交必须让位给直接定位。
 */

/** 距底部多少像素内算「贴着底」，此时新内容才自动跟随 */
export const NEAR_BOTTOM_PX = 30;

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/**
 * 是否贴着底部。
 *
 * 用户往上翻看历史时不应该被新消息拽回底部，所以跟随的前提是他本来就在底部。
 */
export function isNearBottom(m: ScrollMetrics, threshold = NEAR_BOTTOM_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < threshold;
}

/**
 * 本次消息变化是否该发平滑跟随滚动。
 *
 * justSwitched 为真表示这次提交是会话切换带来的，此时交给直接定位，
 * 不发平滑动画，避免两个滚动互相打断。
 */
export function shouldSmoothFollow(input: {
  justSwitched: boolean;
  isNearBottom: boolean;
  messageCount: number;
}): boolean {
  if (input.justSwitched) return false;
  if (!input.isNearBottom) return false;
  return input.messageCount > 0;
}
