/**
 * 企微消息输入守卫
 *
 * 企微机器人是外部入口，任何人都能发消息触发 AI 操作本地文件系统。
 * 对高危指令做前置拦截，直接返回拒绝消息，不转发给 AI 连接器。
 *
 * 每条规则归到一个可开关的类别（见 wecomPolicy 的 GuardCategory），
 * 连接器里可按类别放开——例如只给自己用时放开「本地文件」，
 * 分享给同事时全部关严。不传 policy 时默认全部拦截。
 *
 * 拦截类别：
 * 1. 浏览器历史 / 浏览记录查询
 * 2. 本地工程文件查询 / 读取
 * 3. 删除本地文件 / 文件夹
 * 4. 高危操作（执行 shell、修改系统配置、安装软件等）
 * 5. 敏感个人信息（聊天记录、通讯录、日程、照片、财务、证件等）
 */

import {
  DEFAULT_WECOM_POLICY,
  isGuardEnabled,
  type GuardCategory,
  type WecomPolicy,
} from "./wecomPolicy";

/** 守卫规则 */
interface GuardRule {
  /** 规则名称 */
  name: string;
  /** 所属可开关类别 */
  category: GuardCategory;
  /** 匹配模式（正则，不区分大小写） */
  pattern: RegExp;
  /** 拒绝回复消息 */
  rejectMessage: string;
}

// ── 高危操作规则 ──

const HIGH_RISK_RULES: GuardRule[] = [
  // 1. 浏览器历史
  {
    name: "browser-history",
    category: "browser",
    pattern: /浏览器(历史|记录)|浏览记录|browser\s*history|chrome\s*history|safari\s*history|浏览(器)?(搜索|访问)(记录|历史)/i,
    rejectMessage: "⛔ 企微通道不支持查询浏览器历史记录，该操作涉及隐私安全。",
  },

  // 2. 本地文件查询 / 读取
  {
    name: "local-file-read",
    category: "local-files",
    pattern: /(?:查看|读取|读|看看|看一?下|搜索|查找|找|列出|展示|显示|打开).*(?:本地|工程|项目|桌面|desktop|downloads|documents|home|个人|电脑|磁盘|目录|文件夹|文件)|read\s*(?:file|local|project)|list\s*files|search\s*files|find\s*files|ls\s+\/|cat\s+\/|glob\s*\*|查看.*源码/i,
    rejectMessage: "⛔ 企微通道不支持查询或读取本地工程文件，请通过 Nova 应用直接操作。",
  },

  // 3. 删除本地文件 / 文件夹
  {
    name: "local-file-delete",
    category: "local-files",
    pattern: /删除[\s\S]{0,4}(?:本地|工程|项目|桌面|电脑|磁盘|目录|文件夹)|delete\s*(?:file|folder|dir|local)|rm\s+-rf|remove(?:-)?item|清空(?:回收站|文件夹|目录)|格式化[\s\S]{0,4}(?:磁盘|硬盘|驱动器|disk|drive)|format\s*(?:disk|drive)/i,
    rejectMessage: "⛔ 企微通道禁止删除本地文件或文件夹，该操作不可逆，请通过 Nova 应用确认后执行。",
  },

  // 4. 执行 shell 命令 / 系统操作
  //
  // 同样允许关键词间夹少量字符：「运行 shell 脚本」会因空格漏放。
  {
    name: "shell-execute",
    category: "system-ops",
    pattern: /(?:执行|运行|跑)[\s\S]{0,4}(?:命令|脚本|shell|terminal|终端|bash|zsh)|execute\s*(?:command|script|shell)|run\s*(?:command|script|shell)|exec\s*\(|osascript|apple\s*script|powershell|cmd\s*\/c|bash\s+-c/i,
    rejectMessage: "⛔ 企微通道不支持执行 shell 命令或脚本，请通过 Nova 应用操作。",
  },

  // 5. 安装 / 卸载软件
  //
  // 关键词之间允许夹少量字符：实测「安装 brew 包」会漏放，
  // 因为原先要求「安装」紧跟目标词，而中文里常插入量词或空格。
  {
    name: "install-uninstall",
    category: "system-ops",
    pattern: /(?:安装|卸载|下载)[\s\S]{0,4}(?:软件|应用|程序|app|包|package|brew|npm|pip|apt|yum|cargo)|install\s*(?:software|app|package|brew|npm|pip)|uninstall\s*(?:software|app|package)|brew\s+(?:install|uninstall)|npm\s+i(?:nstall)?\b/i,
    rejectMessage: "⛔ 企微通道不支持安装或卸载软件，请通过 Nova 应用操作。",
  },

  // 6. 修改系统配置
  {
    name: "system-config",
    category: "system-ops",
    pattern: /(?:修改|更改|设置|配置)(?:系统|系统配置|环境变量|注册表|launchd|plist|crontab|sudo|hosts\s*文件|权限|permission|chmod|chown)/i,
    rejectMessage: "⛔ 企微通道不支持修改系统配置，请通过 Nova 应用操作。",
  },

  // 7. 访问密码 / 凭证 / 密钥
  {
    name: "credential-access",
    category: "system-ops",
    pattern: /(?:查看|读取|获取|导出|展示)(?:密码|凭证|密钥|token|secret|key|credential|证书)|password\s*file|keychain|钥匙串|\.env\b|credentials?\s*file/i,
    rejectMessage: "⛔ 企微通道不支持访问密码、凭证或密钥文件。",
  },

  // 8. 网络请求 / 内部系统扫描
  {
    name: "network-scan",
    category: "system-ops",
    pattern: /(?:扫描|scan)(?:端口|网络|ip|主机)|nmap|masscan|port\s*scan|网络(嗅探|抓包)|wireshark|tcpdump/i,
    rejectMessage: "⛔ 企微通道不支持网络扫描或嗅探操作。",
  },

  // ── 敏感个人信息 ──

  // 9. 聊天记录 / 消息记录
  {
    name: "chat-history",
    category: "privacy",
    pattern: /(?:查看|读取|获取|导出|看看|看一?下|搜索|查找).*(?:聊天|消息|对话|会话)(?:记录|历史|内容)|chat\s*history|message\s*history|聊天记录|微信.*记录|wecom.*history|imessage|短信.*记录|sms.*history/i,
    rejectMessage: "⛔ 企微通道不支持查看聊天记录或消息历史，涉及个人隐私。",
  },

  // 10. 通讯录 / 联系人
  {
    name: "contacts-access",
    category: "privacy",
    pattern: /(?:查看|读取|获取|导出|看看|看一?下|搜索|查找|列出|展示).*(?:通讯录|联系人|contact)|contact\s*(?:list|book|access)|address\s*book|电话簿|phone\s*book/i,
    rejectMessage: "⛔ 企微通道不支持访问通讯录或联系人信息。",
  },

  // 11. 日程 / 日历
  //
  // 不含「待办」：Nova 自身的任务管理是企微机器人最主要的用途
  // （「记个待办」「列出待办」），拦掉会废掉核心功能。
  // 系统日历/提醒事项仍由「日程」「日历」「reminders」覆盖。
  {
    name: "calendar-access",
    category: "privacy",
    pattern: /(?:查看|读取|获取|导出|看看|看一?下|搜索|查找|列出).*(?:日程|日历|日程表|日历事件|行程|reminders?)|calendar\s*(?:event|schedule|access)|ical|ics\s*file|日程表|行程表/i,
    rejectMessage: "⛔ 企微通道不支持查看日程或日历信息，涉及个人行程隐私。",
  },

  // 12. 照片 / 相册 / 媒体文件
  {
    name: "photo-access",
    category: "privacy",
    pattern: /(?:查看|读取|获取|导出|看看|看一?下|搜索|查找|列出|展示|打开).*(?:照片|相册|图片|相片|媒体|media|photo|gallery)|photo\s*(?:library|album|access)|image\s*library|照片库|相册库/i,
    rejectMessage: "⛔ 企微通道不支持访问照片、相册或媒体文件。",
  },

  // 13. 财务 / 银行 / 支付信息
  {
    name: "financial-info",
    category: "privacy",
    pattern: /(?:查看|读取|获取|导出|看看|看一?下|搜索|查找).*(?:银行|账户|余额|流水|交易|账单|财务|工资|收入|存款|信用卡|借记卡|支付宝|微信支付|余额宝)|bank\s*(?:account|statement|balance)|financial\s*(?:record|data)|payment\s*history|交易记录|账单明细/i,
    rejectMessage: "⛔ 企微通道不支持访问财务、银行或支付信息。",
  },

  // 14. 证件 / 身份信息
  {
    name: "id-document",
    category: "privacy",
    pattern: /(?:查看|读取|获取|导出|看看|看一?下|搜索|查找).*(?:身份证|护照|驾照|社保|公积金|证件|身份信息)|id\s*(?:card|document)|passport|identity\s*(?:card|document)|身份信息|证件信息/i,
    rejectMessage: "⛔ 企微通道不支持访问身份证件或身份信息。",
  },

  // 15. 邮件内容
  {
    name: "email-access",
    category: "privacy",
    pattern: /(?:查看|读取|获取|导出|看看|看一?下|搜索|查找).*(?:邮件|邮箱|email|收件箱|发件箱|邮件内容)|mail\s*(?:box|content|history)|email\s*(?:content|access|inbox)|收件箱|发件箱/i,
    rejectMessage: "⛔ 企微通道不支持查看邮件内容或邮箱信息。",
  },

  // 16. 位置 / 定位信息
  {
    name: "location-access",
    category: "privacy",
    pattern: /(?:查看|获取|看看|看一?下|查询|定位|追踪).*(?:位置|定位|location|gps|坐标|位置信息|实时位置)|location\s*(?:data|access|tracking)|gps\s*(?:data|location)|位置信息|实时定位/i,
    rejectMessage: "⛔ 企微通道不支持查看位置或定位信息。",
  },

  // 17. 笔记 / 备忘录 / 日记
  {
    name: "notes-access",
    category: "privacy",
    pattern: /(?:查看|读取|获取|导出|看看|看一?下|搜索|查找).*(?:笔记|备忘录|日记|备忘|note|memo|journal)|notes\s*(?:app|content|access)|memo\s*(?:content|access)|apple\s*notes|印象笔记|evernote|notion.*note/i,
    rejectMessage: "⛔ 企微通道不支持查看笔记、备忘录或日记内容。",
  },

  // 18. 社交媒体账号 / 个人资料
  {
    name: "social-media",
    category: "privacy",
    pattern: /(?:查看|读取|获取|导出|看看|看一?下).*(?:社交|账号|账户|个人资料|social|profile)|social\s*(?:media|account|profile)|account\s*(?:list|password|info)|个人账号|社交账号/i,
    rejectMessage: "⛔ 企微通道不支持查看社交媒体账号或个人资料。",
  },
];

/** 守卫检查结果 */
export interface GuardResult {
  /** 是否被拦截 */
  blocked: boolean;
  /** 命中的规则（被拦截时） */
  ruleName?: string;
  /** 命中规则所属类别（被拦截时） */
  category?: GuardCategory;
  /** 拒绝消息（被拦截时） */
  rejectMessage?: string;
}

/**
 * 检查企微消息是否命中高危规则
 * @param text 企微消息文本
 * @param policy 访问策略，决定哪些类别参与拦截；不传则全部拦截
 * @returns 守卫检查结果
 */
export function checkWecomGuard(text: string, policy: WecomPolicy = DEFAULT_WECOM_POLICY): GuardResult {
  for (const rule of HIGH_RISK_RULES) {
    if (!isGuardEnabled(policy, rule.category)) continue;
    if (rule.pattern.test(text)) {
      return {
        blocked: true,
        ruleName: rule.name,
        category: rule.category,
        rejectMessage: rule.rejectMessage,
      };
    }
  }
  return { blocked: false };
}
