// ===== Coding Tools 统一注册入口 =====

import { registerFileRead } from "./fileRead";
import { registerFileWrite } from "./fileWrite";
import { registerFileEdit } from "./fileEdit";
import { registerBash } from "./bash";
import { registerGlob } from "./glob";
import { registerGrep } from "./grep";

/**
 * 注册所有 coding tools 到 ToolRegistry。
 * 在应用启动时调用（useNovaInit）。
 */
export function registerCodingTools() {
  registerFileRead();
  registerFileWrite();
  registerFileEdit();
  registerBash();
  registerGlob();
  registerGrep();
  console.log("[Nova] ✅ Coding tools registered (6): file_read, file_write, file_edit, bash, glob, grep");
}
