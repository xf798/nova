/**
 * 企微消息拦截器
 *
 * 企微回复内容与 Nova 应用内显示不同——Nova 的 ChatView 会解析
 * <!--TOOL_CALLS:...-->、<!--TOOL_ACTIVE:...-->、<!--THOUGHT:...-->
 * 等 HTML 注释标记并分离渲染，但企微客户端只显示纯文本，
 * 这些标记会以原始形式显示给用户。
 *
 * 拦截器在企微回复发送前对内容做过滤，可扩展更多规则。
 */

/** 拦截器上下文 */
export interface WecomInterceptorContext {
  /** 原始企微消息 */
  msg?: any;
  /** sendMessage 返回的完整结果 */
  result?: any;
}

/** 拦截器函数签名：输入内容 + 上下文，返回过滤后的内容 */
export type WecomContentInterceptor = (content: string, ctx?: WecomInterceptorContext) => string;

// ── 内置拦截器 ──

/**
 * 移除所有 tool call / thought 相关的 HTML 注释标记
 *
 * 包括：
 * - <!--TOOL_CALLS:JSON-->
 * - <!--TOOL_ACTIVE:name-->
 * - <!--TOOL_STATUS:...-->（旧格式兼容）
 * - <!--THOUGHT:JSON-->
 */
const stripToolCallMarkers: WecomContentInterceptor = (content: string): string => {
  // HTML 注释标记正则：匹配 <!--TOOL_XXX:任意内容--> 和 <!--THOUGHT:任意内容-->
  // 写入时已对 JSON 中的 --> 转义为 --\>，所以非贪婪匹配安全
  const markerRegex = /<!--(?:TOOL_CALLS|TOOL_ACTIVE|TOOL_STATUS|THOUGHT):[\s\S]*?-->/g;
  let cleaned = content.replace(markerRegex, "");

  // 清理标记移除后可能残留的空行和尾部空白
  cleaned = cleaned
    .replace(/\n{3,}/g, "\n\n")  // 多个空行压缩为最多两个
    .trimEnd();

  return cleaned;
};

// ── 拦截器注册 ──

/** 已注册的拦截器列表（按注册顺序执行） */
const interceptors: WecomContentInterceptor[] = [
  stripToolCallMarkers,
];

/**
 * 注册新的企微内容拦截器
 * @param interceptor 拦截器函数
 */
export function registerWecomInterceptor(interceptor: WecomContentInterceptor): void {
  interceptors.push(interceptor);
}

/**
 * 对企微回复内容应用所有已注册的拦截器
 * @param content 原始内容
 * @param ctx 拦截器上下文（可选）
 * @returns 过滤后的内容
 */
export function applyWecomInterceptors(content: string, ctx?: WecomInterceptorContext): string {
  let result = content;
  for (const interceptor of interceptors) {
    result = interceptor(result, ctx);
  }
  return result;
}
