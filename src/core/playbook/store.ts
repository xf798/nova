// ===== 可执行 Playbook — 持久化 Store =====
//
// 持久化到 ~/.nova/data/playbooks.json（通过 StorageService ns="playbook"）。
// 提供 CRUD + 查询接口。

import { StorageService } from "../storage";
import type { Playbook, PlaybookPreset, PlaybookRun } from "./types";

const NS = "playbook";
const KEY_PLAYBOOKS = "playbooks";
const KEY_RUNS = "runs";

/** 运行历史保留条数 */
const MAX_RUNS = 30;

type StoreListener = (playbooks: Playbook[]) => void;

class PlaybookStore {
  private storage = StorageService.getInstance();
  private playbooks: Playbook[] = [];
  private runs: PlaybookRun[] = [];
  private loaded = false;
  private listeners = new Set<StoreListener>();

  // ─── 生命周期 ───

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      this.playbooks = (await this.storage.get<Playbook[]>(NS, KEY_PLAYBOOKS, [])) || [];
      this.runs = (await this.storage.get<PlaybookRun[]>(NS, KEY_RUNS, [])) || [];
    } catch {
      this.playbooks = [];
      this.runs = [];
    }
    this.loaded = true;
    console.log(`[PlaybookStore] init: ${this.playbooks.length} playbooks, ${this.runs.length} runs`);
  }

  /** 确保已加载 */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.init();
  }

  // ─── 查询 ───

  async getAll(): Promise<Playbook[]> {
    await this.ensureLoaded();
    return [...this.playbooks];
  }

  async getById(id: string): Promise<Playbook | undefined> {
    await this.ensureLoaded();
    return this.playbooks.find(p => p.id === id);
  }

  async getByName(name: string): Promise<Playbook | undefined> {
    await this.ensureLoaded();
    return this.playbooks.find(p => p.name === name);
  }

  // ─── 写入 ───

  async add(playbook: Playbook): Promise<void> {
    await this.ensureLoaded();
    // 同名覆盖
    const idx = this.playbooks.findIndex(p => p.name === playbook.name);
    if (idx >= 0) {
      this.playbooks[idx] = playbook;
    } else {
      this.playbooks.push(playbook);
    }
    await this.persist();
    this.notify();
  }

  async update(id: string, patch: Partial<Omit<Playbook, "id" | "createdAt">>): Promise<void> {
    await this.ensureLoaded();
    const idx = this.playbooks.findIndex(p => p.id === id);
    if (idx < 0) return;
    this.playbooks[idx] = {
      ...this.playbooks[idx],
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
    this.notify();
  }

  async remove(id: string): Promise<void> {
    await this.ensureLoaded();
    this.playbooks = this.playbooks.filter(p => p.id !== id);
    await this.persist();
    this.notify();
  }

  /** 添加/更新参数预设 */
  async addPreset(playbookId: string, preset: PlaybookPreset): Promise<void> {
    await this.ensureLoaded();
    const pb = this.playbooks.find(p => p.id === playbookId);
    if (!pb) return;
    if (!pb.presets) pb.presets = [];
    const idx = pb.presets.findIndex(p => p.name === preset.name);
    if (idx >= 0) {
      pb.presets[idx] = preset;
    } else {
      pb.presets.push(preset);
    }
    pb.updatedAt = new Date().toISOString();
    await this.persist();
    this.notify();
  }

  /** 删除参数预设 */
  async removePreset(playbookId: string, presetName: string): Promise<void> {
    await this.ensureLoaded();
    const pb = this.playbooks.find(p => p.id === playbookId);
    if (!pb || !pb.presets) return;
    pb.presets = pb.presets.filter(p => p.name !== presetName);
    pb.updatedAt = new Date().toISOString();
    await this.persist();
    this.notify();
  }

  // ─── 运行历史 ───

  async getRuns(playbookId?: string): Promise<PlaybookRun[]> {
    await this.ensureLoaded();
    if (playbookId) return this.runs.filter(r => r.playbookId === playbookId);
    return [...this.runs];
  }

  async saveRun(run: PlaybookRun): Promise<void> {
    await this.ensureLoaded();
    const idx = this.runs.findIndex(r => r.id === run.id);
    if (idx >= 0) {
      this.runs[idx] = run;
    } else {
      this.runs.push(run);
    }
    // 保留最近 N 条
    if (this.runs.length > MAX_RUNS) {
      this.runs = this.runs.slice(-MAX_RUNS);
    }
    await this.persistRuns();
  }

  // ─── 监听 ───

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    const snapshot = [...this.playbooks];
    for (const fn of this.listeners) {
      try { fn(snapshot); } catch {}
    }
  }

  // ─── 持久化 ───

  private async persist(): Promise<void> {
    try {
      await this.storage.set(NS, KEY_PLAYBOOKS, this.playbooks);
    } catch (e) {
      console.error("[PlaybookStore] persist failed:", e);
    }
  }

  private async persistRuns(): Promise<void> {
    try {
      await this.storage.set(NS, KEY_RUNS, this.runs);
    } catch (e) {
      console.error("[PlaybookStore] persistRuns failed:", e);
    }
  }

  /** 内部测试用：重置 */
  _reset(): void {
    this.playbooks = [];
    this.runs = [];
    this.loaded = false;
    this.listeners.clear();
  }
}

/** 全局单例 */
export const playbookStore = new PlaybookStore();
