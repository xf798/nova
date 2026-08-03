// ===== Playbook Slash 命令 =====
//
// /playbook [name] — 启动 Playbook 重放
// /playbook list    — 列出所有可用 Playbook

import { registerCommand } from "./registry";
import type { CommandContext } from "./registry";
import { playbookStore } from "../playbook";

registerCommand({
  name: "playbook",
  aliases: ["pb"],
  description: "启动 Playbook 重放 (用法: /playbook <name> 或 /playbook list)",
  run: async (ctx: CommandContext, argsRaw: string) => {
    const arg = argsRaw.trim();

    if (!arg || arg === "list") {
      // 列出所有 Playbook
      const playbooks = await playbookStore.getAll();
      if (playbooks.length === 0) {
        ctx.notify("暂无可执行的 Playbook。通过 /distill 蒸馏会话可产出 Playbook。", "info");
        return;
      }
      const list = playbooks.map(p => `• ${p.displayName} (${p.name})`).join("\n");
      ctx.notify(`可用 Playbook:\n${list}`, "info");
      return;
    }

    // 查找并打开 Playbook
    const playbook = await playbookStore.getByName(arg) ||
      (await playbookStore.getAll()).find(p =>
        p.displayName.includes(arg) || p.name.includes(arg)
      );

    if (!playbook) {
      ctx.notify(`未找到 Playbook: ${arg}`, "error");
      return;
    }

    // 通过事件触发 Playbook 执行浮层
    window.dispatchEvent(new CustomEvent("nova-playbook-run", {
      detail: { playbookId: playbook.id },
    }));
  },
});
