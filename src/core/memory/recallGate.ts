// ===== 召回闸门 =====
//
// 判断一句输入是否值得触发记忆召回。
//
// 由来：反复遇到「无主题的短消息召回一堆无关记忆」。典型案例
// 「可以，按完整方案实现」命中了「客户画像UI还原」那条记忆（得分 0.168），
// 只因为共享了「实现」这个泛用动词。
//
// 换过三种算法都没解决（IDF、会话当查询、反向覆盖度），后来用 API 嵌入实测
// 也一样：向量空间里这类查询的相似度全挤在 0.44-0.66，没有区分度。
// 说明问题不在「用什么算法召回」，而在「这句话本身没有主题，压根不该召回」。
//
// 真实数据支持这个判断：1208 条用户消息里 13.7% 不超过 4 字，
// 且几乎全是指令与确认（做吧 / 继续 / 推 / 1 / 确认 / 改吧）。
//
// 注意不能按长度一刀切 —— 「打包」「截图」「关机」同样很短，却是有主题的。
// 因此判据是「去掉程序性词汇后还剩不剩实义内容」。

/**
 * 程序性词汇：表达指令、确认、过渡，不承载话题。
 *
 * 全部来自真实消息统计，不是凭感觉列的。
 */
const PROCEDURAL = new Set([
  // 确认与同意
  "可以", "好的", "好", "行", "对", "是", "嗯", "ok", "okay", "yes",
  "确认", "同意", "没问题", "可以了", "有了", "对的", "正确",
  // 指令与推进
  "做吧", "做", "开始", "继续", "执行", "运行", "跑", "试试", "试", "来",
  "改吧", "改", "修", "修复", "调", "调吧", "加", "加上", "删", "删掉", "去掉",
  "提交", "推", "推送", "发", "发吧", "重试", "再来", "重新", "统一", "统一吧",
  // 泛用动词（正是「实现」这类导致误召回的词）
  "实现", "完成", "处理", "使用", "需要", "支持", "优化", "调整", "更新",
  "方案", "完整", "全部", "所有", "这个", "那个", "一下", "一起",
  // 否定与状态
  "不", "不用", "不要", "不对", "没", "没有", "没生效", "失败", "错了",
  // 反馈类：确认结果的话，本身不带话题
  // （来自真实数据：不卡了 / 正常了 / 好了 / 不做了）
  "不卡了", "正常了", "好了", "不做了", "解决了", "生效了", "可用了",
  // 疑问与语气
  "呢", "吗", "吧", "啊", "怎么", "为什么", "什么", "如何", "哪个", "多少",
]);

/** 单字通常不承载话题；有意义的技术名词几乎都是两字以上 */
const MIN_MEANINGFUL_LENGTH = 2;

/**
 * 从输入中提取「实义片段」——去掉程序性词汇后剩下的内容。
 *
 * 按标点与空白切分，再逐段剥离程序性词汇。
 * 返回剩余片段，供调用方判断是否值得召回。
 */
export function extractMeaningful(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  // 按标点与空白粗切
  const segments = trimmed
    .split(/[\s,，。、；;：:!！?？~～"'"'（）()【】\[\]{}<>|/\\]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (PROCEDURAL.has(lower)) continue;
    if (seg.length < MIN_MEANINGFUL_LENGTH) continue;

    // 段内可能是「程序性词 + 实义词」拼在一起（如「按完整方案实现」），
    // 逐个剥离已知程序性词后看还剩什么
    let rest = seg;
    for (const p of PROCEDURAL) {
      if (p.length < MIN_MEANINGFUL_LENGTH) continue;
      // 反复剥离，处理重复出现
      while (rest.toLowerCase().includes(p)) {
        const idx = rest.toLowerCase().indexOf(p);
        rest = rest.slice(0, idx) + rest.slice(idx + p.length);
      }
    }
    rest = rest.replace(/^[按用把将从对给让使]+/, "").trim();
    if (rest.length >= MIN_MEANINGFUL_LENGTH) out.push(rest);
  }
  return out;
}

/**
 * 这句输入是否值得触发记忆召回。
 *
 * 剥离程序性词汇后没有实义内容 → 不召回。宁可不召回，也不要塞一堆
 * 无关记忆进上下文：后者既浪费 token，又可能让模型据此编造关联。
 */
export function shouldRecall(input: string): boolean {
  return extractMeaningful(input).length > 0;
}
