// ===== 企微消息守卫 =====
//
// 企微机器人是外部入口，任何人都能发消息触发 AI 操作本地文件系统，
// 所以要对高危指令前置拦截。
//
// 这类拦截功能的风险是双向的：漏放会有安全隐患，误伤会挡掉正常使用。
// 因此测试同时覆盖两侧，尤其是「正常企微使用场景必须放行」——
// 规则里有几条正则相当宽泛（如匹配「查看…文件」），容易伤到日常指令。

import { describe, it, expect } from "vitest";
import { checkWecomGuard } from "./wecomGuard";

describe("拦截高危指令", () => {
  const cases: [string, string][] = [
    ["看看我的浏览器历史", "browser-history"],
    ["导出 chrome history", "browser-history"],
    ["查看本地工程文件", "local-file-read"],
    ["列出桌面的文件", "local-file-read"],
    ["删除本地文件", "local-file-delete"],
    ["rm -rf /tmp", "local-file-delete"],
    ["执行命令 ls", "shell-execute"],
    ["运行 shell 脚本", "shell-execute"],
    ["安装 brew 包", "install-uninstall"],
    ["brew install wget", "install-uninstall"],
    ["修改系统配置", "system-config"],
    ["查看密钥", "credential-access"],
    ["读取 .env", "credential-access"],
    ["扫描端口", "network-scan"],
    // 「待办」已从日历规则移除（Nova 任务是企微主用途），
    // 但系统日历/行程仍须拦住，否则这次收窄就放开过头了
    ["看下我的日程", "calendar-access"],
    ["导出日历事件", "calendar-access"],
    ["查看聊天记录", "chat-history"],
    ["看下通讯录", "contacts-access"],
  ];

  for (const [text, rule] of cases) {
    it(`拦截 ${JSON.stringify(text)}`, () => {
      const r = checkWecomGuard(text);
      expect(r.blocked).toBe(true);
      expect(r.ruleName).toBe(rule);
      expect(r.rejectMessage).toBeTruthy();
    });
  }
});

describe("放行正常的企微使用", () => {
  // 这些是日常真实用法，被拦掉会直接影响可用性
  const cases = [
    "帮我看下今天的待办",
    "查一下客户画像的进度",
    "部署 dev 环境",
    "看看构建成功了吗",
    "打包发布",
    "帮我查找一下这个问题的原因",
    "显示当前的任务列表",
    "客户画像的字段推断在哪一步",
    "看一下 CR 有没有过",
    "帮我记个待办：修复登录问题",
    "查看下部署状态",
    "列出待办",
    "搜索一下之前讨论的方案",
    "打开企微机器人配置",
    "会话存储为什么要改成 JSONL",
    "之前那个切换慢是怎么弄的",
  ];

  for (const text of cases) {
    it(`放行 ${JSON.stringify(text)}`, () => {
      const r = checkWecomGuard(text);
      expect(r.blocked, `被 ${r.ruleName} 误伤`).toBe(false);
    });
  }
});

describe("边界", () => {
  it("空文本放行", () => {
    expect(checkWecomGuard("").blocked).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(checkWecomGuard("BROWSER HISTORY").blocked).toBe(true);
    expect(checkWecomGuard("RM -RF /").blocked).toBe(true);
  });

  it("超长文本不出错", () => {
    expect(() => checkWecomGuard("正常内容".repeat(5000))).not.toThrow();
  });

  it("命中多条规则时返回首个匹配，信息完整", () => {
    const r = checkWecomGuard("删除本地文件并执行命令");
    expect(r.blocked).toBe(true);
    expect(r.ruleName).toBeTruthy();
    expect(r.rejectMessage).toBeTruthy();
  });
});
