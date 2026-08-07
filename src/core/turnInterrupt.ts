/**
 * Agent 侧中断的识别
 *
 * kiro-cli 在自己终止一轮时，会把一句 "Response was interrupted by the user"
 * 直接拼到正文末尾，而 ACP 的 stopReason 仍然是 end_turn —— 也就是说，
 * 从 Nova 的角度这一轮是「正常结束」的，界面上看不出任何异常，
 * 用户只感觉「任务自行停止了」。
 *
 * 实测 5 次出现，其中一次紧跟在额度倒计时后面：
 *   "You have 6387 weighted tokens leftResponse was interrupted by the user."
 * 额度序列 8023 → 6387 → 3736 → 3057 → 1948 → 1793 → 633 一路递减，
 * 另有一次直接说明「当前工具时间窗口结束，我还没有执行提交」。
 * 所以这句话并不代表用户点了停止，更多是 Agent 侧的额度或时间窗口用尽。
 *
 * Nova 管不了对面为什么中断，但至少要让它可见、可续。
 */

/** kiro-cli 中断时追加的固定句式（句尾句号可有可无） */
const INTERRUPT_MARKERS = [
  "Response was interrupted by the user",
];

/** 正文是否带着 Agent 侧的中断标记 */
export function isTurnInterrupted(content: string): boolean {
  if (!content) return false;
  return INTERRUPT_MARKERS.some(m => content.includes(m));
}

/**
 * 中断说明文本。
 *
 * 只返回提示本身，由 appendNotice 负责同时写进正文和过程时间线。
 * 不改写 Agent 的原句：那是对面的原始输出，改了会让日志与界面对不上。
 */
export const TURN_INTERRUPT_NOTICE =
  "⚠️ 本轮被 Agent 侧中断，任务可能未完成。" +
  "常见原因是模型额度或工具时间窗口用尽（并非你点了停止）。回复「继续」可以接着做。";
