/**
 * 工具调用轮次上限
 *
 * tool loop 每轮把工具结果回注给模型再问一次，轮次必须有上限，
 * 否则模型在失败重试里打转就会无限跑下去。
 *
 * 但撞上限原先是静默的：while 条件不成立就退出，不留任何痕迹。
 * 如果最后一轮返回的是纯 tool_calls（没有正文），最终正文就是空的——
 * 会话里看到一条空消息、企微那头收到「（无输出）」，无从判断发生了什么。
 * 这里把「被上限中断」变成可见信息。
 */

/** tool loop 最大轮次。每轮是一次完整的模型往返，一轮内可含多个并行工具 */
export const MAX_TOOL_LOOPS = 25;

/**
 * 是否因为撞上轮次上限而中断。
 *
 * 判定要同时满足两条：轮次已用尽，且模型仍要求继续调用工具。
 * 只看轮次会误报——正好第 25 轮给出了最终答案是正常收尾，不是中断。
 */
export function isToolLoopCapped(loopCount: number, pendingToolCalls: number): boolean {
  return loopCount >= MAX_TOOL_LOOPS && pendingToolCalls > 0;
}

/**
 * 给正文追加中断说明。
 *
 * 正文为空时说明整条消息只有这句提示，此时不加空行前缀，
 * 避免消息以空白开头。
 */
export function withToolLoopCapNotice(content: string, executedTools: number): string {
  const notice =
    `⚠️ 已达工具调用上限（${MAX_TOOL_LOOPS} 轮，共执行 ${executedTools} 个工具），` +
    `任务未做完就被中断了。回复「继续」可以接着做。`;
  return content ? `${content}\n\n${notice}` : notice;
}
