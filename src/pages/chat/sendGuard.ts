/**
 * 发送后的停止保护期
 *
 * 发送与停止是同一个位置的同一颗按钮：发送后输入框清空、isProcessing 变 true，
 * 停止按钮立刻出现在鼠标正下方。于是「双击发送」或「急着再点一下」的第二次
 * 点击就打在停止上，把刚发出的请求掐掉。
 *
 * 实测日志：10:48:51 发出 prompt，10:48:52 就 abort，正文 0 字符，
 * 同一条输入 5 秒后被重发。用户完全不知道是自己点的，只看到「任务自行停止」。
 *
 * 解法是发送后短暂保持发送态：这期间点击落在「加入队列」上，而输入框是空的，
 * 队列逻辑本身会忽略空输入，等于这一下什么都不做。
 * 真想停止的人不会在 800ms 内点第二下。
 */
export const SEND_GUARD_MS = 800;

/** 是否展示停止按钮（否则展示发送/加入队列） */
export function showStopButton(input: {
  isProcessing: boolean;
  hasInput: boolean;
  hasAttachments: boolean;
  withinSendGuard: boolean;
}): boolean {
  if (!input.isProcessing) return false;
  // 有内容待发时按钮属于「加入队列」，不能是停止
  if (input.hasInput || input.hasAttachments) return false;
  return !input.withinSendGuard;
}
