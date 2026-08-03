// ===== 命令模块出口 =====

import { registerCommand } from "./registry";
import { distillCommand } from "./distill";
// playbook 命令通过 import 副作用自注册
import "./playbook";

export type { SlashCommand, CommandContext } from "./registry";
export {
  registerCommand,
  dispatchCommand,
  resolveCommand,
  listCommands,
} from "./registry";
export { runDistill, distillCommand } from "./distill";

let _bootstrapped = false;

/** 注册所有内置命令（幂等） */
export function bootstrapCommands(): void {
  if (_bootstrapped) return;
  registerCommand(distillCommand);
  _bootstrapped = true;
}
