// ===== 应用自动更新 =====
//
// 基于 tauri-plugin-updater：
// - 更新清单（latest.json）托管在公开仓库 xf798/nova-releases 的 Release 上
//   endpoint 见 tauri.conf.json → plugins.updater.endpoints
// - 更新包由 tauri build 生成（createUpdaterArtifacts: true），并用 minisign
//   私钥签名，客户端用 tauri.conf.json 里的 pubkey 校验，签名不通过则拒绝安装
//
// 状态放在模块级 store 而非组件内：
// 下载可能持续数十秒，用户中途离开设置页会导致组件卸载。若状态在组件里，
// 回调就写进了已销毁的 state，回到设置页只能从头下载。
//
// 注意：dev 模式下 updater 不可用（没有打包产物），check() 会直接报错，
// 因此所有入口都要容忍失败。

import { create } from "zustand";
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

interface UpdateStoreState {
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
  /** 上次检查完成时间戳，用于避免频繁重复检查 */
  lastCheckedAt?: number;
}

const STORAGE_NS = "updater";
const KEY_AUTO_CHECK = "autoCheckOnStartup";

/** 同一结果在此时间窗内不重复检查 */
const CHECK_TTL_MS = 5 * 60 * 1000;

const storage = StorageService.getInstance();

export const useUpdateStore = create<UpdateStoreState>(() => ({
  stage: "idle",
}));

/** 下载/安装是否正在进行，防止重复触发 */
let installing = false;
/** 检查是否正在进行，防止并发检查 */
let checking = false;

// ─── 设置项 ───

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

// ─── 版本 ───

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

/** 把当前版本号填入 store（供 UI 首次渲染显示） */
export async function primeCurrentVersion(): Promise<void> {
  if (useUpdateStore.getState().currentVersion) return;
  const v = await getCurrentVersion();
  if (v) useUpdateStore.setState({ currentVersion: v });
}

// ─── 检查 ───

async function rawCheck() {
  const { check } = await import("@tauri-apps/plugin-updater");
  return await check();
}

/**
 * 检查更新并写入 store。
 *
 * @param force 为 false 时，若已在 TTL 内检查过则跳过（用于进入设置页的自动检查）
 */
export async function checkForUpdate(force = true): Promise<void> {
  const s = useUpdateStore.getState();

  // 下载中或已就绪时不该被检查打断
  if (installing || s.stage === "downloading" || s.stage === "readyToRestart") return;
  if (checking) return;

  if (!force && s.lastCheckedAt && Date.now() - s.lastCheckedAt < CHECK_TTL_MS) {
    // 已有较新结果，直接沿用
    return;
  }

  checking = true;
  const currentVersion = s.currentVersion || (await getCurrentVersion());
  useUpdateStore.setState({ stage: "checking", currentVersion, error: undefined });

  try {
    const update = await rawCheck();
    if (!update) {
      useUpdateStore.setState({
        stage: "upToDate",
        currentVersion,
        newVersion: undefined,
        notes: undefined,
        lastCheckedAt: Date.now(),
      });
      return;
    }
    useUpdateStore.setState({
      stage: "available",
      currentVersion: update.currentVersion || currentVersion,
      newVersion: update.version,
      notes: update.body || undefined,
      lastCheckedAt: Date.now(),
    });
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.warn("[Updater] 检查更新失败:", msg);
    useUpdateStore.setState({
      stage: "error",
      currentVersion,
      error: msg,
      lastCheckedAt: Date.now(),
    });
  } finally {
    checking = false;
  }
}

// ─── 下载安装 ───

/**
 * 下载并安装更新。进度写入 store，因此中途离开设置页不影响下载。
 * 重复调用会被忽略。
 */
export async function downloadAndInstall(): Promise<void> {
  if (installing) return;
  const s = useUpdateStore.getState();
  if (s.stage === "downloading" || s.stage === "readyToRestart") return;

  installing = true;
  try {
    // 重新 check 拿到 Update 实例（Update 对象不便长期持有）
    const update = await rawCheck();
    if (!update) {
      useUpdateStore.setState({ stage: "upToDate", lastCheckedAt: Date.now() });
      return;
    }

    useUpdateStore.setState({
      stage: "downloading",
      currentVersion: update.currentVersion || s.currentVersion,
      newVersion: update.version,
      notes: update.body || s.notes,
      progress: 0,
      error: undefined,
    });

    let downloaded = 0;
    let contentLength = 0;

    await update.downloadAndInstall(event => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength || 0;
          useUpdateStore.setState({ progress: 0 });
          break;
        case "Progress":
          downloaded += event.data.chunkLength || 0;
          useUpdateStore.setState({
            progress: contentLength > 0 ? downloaded / contentLength : undefined,
          });
          break;
        case "Finished":
          useUpdateStore.setState({ progress: 1 });
          break;
      }
    });

    useUpdateStore.setState({ stage: "readyToRestart", progress: 1 });
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.warn("[Updater] 下载安装失败:", msg);
    useUpdateStore.setState({ stage: "error", error: msg });
  } finally {
    installing = false;
  }
}

/** 重启应用以应用更新 */
export async function restartApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
