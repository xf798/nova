/**
 * 蒸馏水位线
 *
 * 水位线 distilledMsgCount 记的是「这个会话已经蒸馏到第几条对话消息」，
 * 增量蒸馏靠它切出新内容。它有两个必须守住的性质：
 *
 * 1. 比较对象必须是会话全量消息数，不能是内存里的部分视图。
 *    内存只保留首屏 20 条，拿它和水位线 250 比，切出来恒为空，
 *    表现就是「一直提示自上次蒸馏没有新内容」——实测 22 个会话全部卡死。
 *
 * 2. 只能前进不能后退。一旦拿部分视图推进水位线，250 会被写成 20，
 *    下次把 230 条已蒸过的内容重蒸一遍。
 */

export interface NewSlice<T> {
  /** 切片起点（已钳制到合法范围） */
  start: number;
  /** 水位线之后的新消息 */
  slice: T[];
  /** 水位线是否超过了总数（历史脏数据的信号） */
  clamped: boolean;
}

/**
 * 按水位线切出新消息。
 *
 * @param all 会话全量对话消息
 * @param watermark 已蒸馏到的条数
 * @param force 全量重蒸（忽略水位线）
 */
export function sliceNewMessages<T>(all: T[], watermark: number, force = false): NewSlice<T> {
  const total = all.length;
  const wm = force ? 0 : Math.max(0, Math.floor(watermark) || 0);
  const start = Math.min(wm, total);
  return { start, slice: all.slice(start), clamped: wm > total };
}

/**
 * 计算应写回的水位线：只前进不后退。
 */
export function nextWatermark(existing: number | undefined, count: number): number {
  return Math.max(existing || 0, Math.max(0, Math.floor(count) || 0));
}
