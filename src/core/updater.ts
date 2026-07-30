// ===== 应用自动更新 =====
//
// 基于 tauri-plugin-updater：
// - 更新清单（latest.json）托管在公开仓库 xf798/nova-releases 的 Release 上
//   endpoint 见 tauri.conf.json → plugins.updater.endpoints
// - 更新包由 tauri build 生成（createUpdaterArtifacts: true），并用 minisign
//   私钥签名，客户端用 tauri.conf.json 里的 pubkey 校验，签名不通过则拒绝安装
//
// 注意：dev 模式下 updater 不可用（没有打包产物），check() 会直接报错，
// 因此所有入口都要容忍失败。

import { StorageService } from "./storage";

/** 更新流程状态 */
export type UpdateStage =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "readyToRestart"
  | "error";

export interface UpdateState {
  stage: UpdateStage;
  /** 当前已安装版本 */
  currentVersion?: string;
  /** 可更新到的版本 */
  newVersion?: string;
  /** 更新说明 */
  notes?: string;
  /** 下载进度 0~1（contentLength 未知时为 undefined） */
  progress?: number;
  /** 错误信息 */
  error?: string;
}

const STORAGE_NS = "updater";
const KEY_AUTO_CHECK = "autoCheckOnStartup";

const storage = StorageService.getInstance();

/** 读取「启动时自动检查更新」开关（默认开启） */
export async function getAutoCheckEnabled(): Promise<boolean> {
  try {
    const v = await storage.get<boolean>(STORAGE_NS, KEY_AUTO_CHECK);
    return v === undefined || v === null ? true : !!v;
  } catch {
    return true;
  }
}

/** 写入「启动时自动检查更新」开关 */
export async function setAutoCheckEnabled(enabled: boolean): Promise<void> {
  try {
    await storage.set(STORAGE_NS, KEY_AUTO_CHECK, enabled);
  } catch (e) {
    console.warn("[Updater] 保存自动检查开关失败:", e);
  }
}

/** 获取当前应用版本 */
export async function getCurrentVersion(): Promise<string | undefined> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch (e) {
    console.warn("[Updater] 获取版本号失败:", e);
    return undefined;
  }
}

/**
 * 检查是否有更新。
 * @returns 有更新时返回 Update 对象，无更新返回 null；出错抛异常
 */
async function checkUpdate() {
  const { check } = await import("@tauri-apps/plugin-updater");
  return await check();
}

/**
 * 仅检查更新，不下载。用于启动时静默探测。
 * 失败时返回 error 态而非抛出，避免影响启动流程。
 */
export async function checkOnly(): Promise<UpdateState> {
  const currentVersion = await getCurrentVersion();
  try {
    const update = await checkUpdate();
    if (!update) {
      return { stage: "upToDate", currentVersion };
    }
    return {
      stage: "available",
      currentVersion: update.currentVersion || currentVersion,
      newVersion: update.version,
      notes: update.body || undefined,
    };
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.warn("[Updater] 检查更新失败:", msg);
    return { stage: "error", currentVersion, error: msg };
  }
}

/**
 * 检查 → 下载 → 安装，全程回调进度。
 * 安装完成后需调用 restartApp() 生效。
 */
export async function downloadAndInstall(
  onState: (s: UpdateState) => void,
): Promise<void> {
  const currentVersion = await getCurrentVersion();
  onState({ stage: "checking", currentVersion });

  let update: Awaited<ReturnType<typeof checkUpdate>>;
  try {
    update = await checkUpdate();
  } catch (e: any) {
    onState({ stage: "error", currentVersion, error: e?.message || String(e) });
    return;
  }

  if (!update) {
    onState({ stage: "upToDate", currentVersion });
    return;
  }

  const base: UpdateState = {
    stage: "downloading",
    currentVersion: update.currentVersion || currentVersion,
    newVersion: update.version,
    notes: update.body || undefined,
  };
  onState({ ...base, progress: 0 });

  let downloaded = 0;
  let contentLength = 0;

  try {
    await update.downloadAndInstall(event => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength || 0;
          onState({ ...base, progress: 0 });
          break;
        case "Progress":
          downloaded += event.data.chunkLength || 0;
          onState({
            ...base,
            progress: contentLength > 0 ? downloaded / contentLength : undefined,
          });
          break;
        case "Finished":
          onState({ ...base, progress: 1 });
          break;
      }
    });
    onState({ ...base, stage: "readyToRestart", progress: 1 });
  } catch (e: any) {
    onState({ ...base, stage: "error", error: e?.message || String(e) });
  }
}

/** 重启应用以应用更新 */
export async function restartApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
