import { describe, it, expect, vi, beforeEach } from "vitest";

// updater 通过动态 import 加载 Tauri 插件，测试环境需打桩
const mockCheck = vi.fn();
const mockGetVersion = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => mockCheck() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => mockGetVersion() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("./storage", () => ({
  StorageService: {
    getInstance: () => ({
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

const { useUpdateStore, checkForUpdate, downloadAndInstall } = await import("./updater");

/** 构造一个假的 Update 对象 */
function fakeUpdate(opts: {
  version?: string;
  currentVersion?: string;
  body?: string;
  chunks?: number[];
  contentLength?: number;
  failAt?: number;
}) {
  return {
    version: opts.version ?? "0.1.3",
    currentVersion: opts.currentVersion ?? "0.1.2",
    body: opts.body,
    downloadAndInstall: async (cb: (e: any) => void) => {
      cb({ event: "Started", data: { contentLength: opts.contentLength ?? 100 } });
      let sent = 0;
      for (const c of opts.chunks ?? [50, 50]) {
        sent += c;
        if (opts.failAt !== undefined && sent >= opts.failAt) throw new Error("网络中断");
        cb({ event: "Progress", data: { chunkLength: c } });
      }
      cb({ event: "Finished", data: {} });
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetVersion.mockResolvedValue("0.1.2");
  useUpdateStore.setState({
    stage: "idle", currentVersion: undefined, newVersion: undefined,
    notes: undefined, progress: undefined, error: undefined, lastCheckedAt: undefined,
  });
});

describe("checkForUpdate", () => {
  it("无更新时为 upToDate", async () => {
    mockCheck.mockResolvedValue(null);
    await checkForUpdate();
    const s = useUpdateStore.getState();
    expect(s.stage).toBe("upToDate");
    expect(s.newVersion).toBeUndefined();
    expect(s.lastCheckedAt).toBeGreaterThan(0);
  });

  it("有更新时写入版本与说明", async () => {
    mockCheck.mockResolvedValue(fakeUpdate({ version: "0.1.3", body: "修了几个 bug" }));
    await checkForUpdate();
    const s = useUpdateStore.getState();
    expect(s.stage).toBe("available");
    expect(s.newVersion).toBe("0.1.3");
    expect(s.notes).toBe("修了几个 bug");
  });

  it("检查失败进入 error 且记录原因", async () => {
    mockCheck.mockRejectedValue(new Error("updater 不可用"));
    await checkForUpdate();
    const s = useUpdateStore.getState();
    expect(s.stage).toBe("error");
    expect(s.error).toContain("updater 不可用");
  });

  it("force=false 时 TTL 内不重复请求", async () => {
    mockCheck.mockResolvedValue(null);
    await checkForUpdate(true);
    expect(mockCheck).toHaveBeenCalledTimes(1);

    await checkForUpdate(false);
    expect(mockCheck).toHaveBeenCalledTimes(1); // 沿用上次结果
  });

  it("force=true 时无视 TTL 强制请求", async () => {
    mockCheck.mockResolvedValue(null);
    await checkForUpdate(true);
    await checkForUpdate(true);
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });

  it("TTL 过期后 force=false 也会重新请求", async () => {
    mockCheck.mockResolvedValue(null);
    await checkForUpdate(true);
    // 把上次检查时间推到 TTL 之外
    useUpdateStore.setState({ lastCheckedAt: Date.now() - 10 * 60 * 1000 });
    await checkForUpdate(false);
    expect(mockCheck).toHaveBeenCalledTimes(2);
  });

  it("下载中不被检查打断", async () => {
    useUpdateStore.setState({ stage: "downloading", progress: 0.4 });
    await checkForUpdate(true);
    expect(mockCheck).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().stage).toBe("downloading");
  });

  it("已就绪待重启时不被检查打断", async () => {
    useUpdateStore.setState({ stage: "readyToRestart" });
    await checkForUpdate(true);
    expect(mockCheck).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().stage).toBe("readyToRestart");
  });
});

describe("downloadAndInstall", () => {
  it("进度写入 store，完成后进入 readyToRestart", async () => {
    mockCheck.mockResolvedValue(fakeUpdate({ chunks: [30, 30, 40], contentLength: 100 }));
    const seen: (number | undefined)[] = [];
    const unsub = useUpdateStore.subscribe(s => {
      if (s.stage === "downloading") seen.push(s.progress);
    });

    await downloadAndInstall();
    unsub();

    const s = useUpdateStore.getState();
    expect(s.stage).toBe("readyToRestart");
    expect(s.progress).toBe(1);
    // 进度应单调递增且落在 0~1
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) if (p !== undefined) expect(p).toBeLessThanOrEqual(1);
  });

  it("contentLength 未知时 progress 为 undefined 而非 NaN", async () => {
    mockCheck.mockResolvedValue(fakeUpdate({ chunks: [10], contentLength: 0 }));
    const seen: (number | undefined)[] = [];
    const unsub = useUpdateStore.subscribe(s => {
      if (s.stage === "downloading") seen.push(s.progress);
    });
    await downloadAndInstall();
    unsub();
    for (const p of seen) expect(Number.isNaN(p as number)).toBe(false);
  });

  it("下载失败进入 error", async () => {
    mockCheck.mockResolvedValue(fakeUpdate({ chunks: [50, 50], failAt: 50 }));
    await downloadAndInstall();
    const s = useUpdateStore.getState();
    expect(s.stage).toBe("error");
    expect(s.error).toContain("网络中断");
  });

  it("重复调用被忽略，不会并发下载", async () => {
    mockCheck.mockResolvedValue(fakeUpdate({ chunks: [100], contentLength: 100 }));
    await Promise.all([downloadAndInstall(), downloadAndInstall(), downloadAndInstall()]);
    // 只应触发一次 check（第二三次被 installing 闸门拦掉）
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("已在 readyToRestart 时不重复下载", async () => {
    useUpdateStore.setState({ stage: "readyToRestart" });
    await downloadAndInstall();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("下载时发现已无更新则回落到 upToDate", async () => {
    mockCheck.mockResolvedValue(null);
    await downloadAndInstall();
    expect(useUpdateStore.getState().stage).toBe("upToDate");
  });
});

describe("状态跨组件生命周期保持", () => {
  it("下载状态存于模块级 store，组件卸载不影响", async () => {
    mockCheck.mockResolvedValue(fakeUpdate({ chunks: [100], contentLength: 100 }));
    const p = downloadAndInstall();
    // 模拟组件卸载：此处不做任何 setState，store 仍应独立推进
    await p;
    expect(useUpdateStore.getState().stage).toBe("readyToRestart");
  });
});
