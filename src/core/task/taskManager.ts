// ===== Task 跟踪系统 =====
//
// 轻量级任务管理，持久化到独立 JSON 文件 ~/.nova/data/tasks.json。
// AI (Kiro CLI) 通过 read/write tool 直接操作此文件，Nova UI 通过 fs watch 同步。
// 支持：创建、状态流转、优先级、时间管理、删除。

import { invoke } from "@tauri-apps/api/core";

export type TaskStatus = "pending" | "in_progress" | "completed";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  startDate: string;       // ISO date string (YYYY-MM-DD)
  dueDate?: string;        // ISO date string (YYYY-MM-DD)
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** tasks.json 最大任务数 */
const MAX_TASKS = 200;

/** 获取今天的日期字符串 YYYY-MM-DD */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

class TaskManager {
  private cache: Task[] | null = null;
  private listeners = new Set<() => void>();

  /** 订阅变更 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 强制清除缓存，下次读取时从文件重新加载 */
  invalidateCache(): void {
    this.cache = null;
  }

  private notify(): void {
    this.listeners.forEach(fn => fn());
  }

  private async readFile(): Promise<Task[]> {
    try {
      const content = await invoke<string>("read_tasks_file");
      const data = JSON.parse(content);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  private async writeFile(tasks: Task[]): Promise<void> {
    const content = JSON.stringify(tasks, null, 2);
    await invoke("write_tasks_file", { data: content });
  }

  private async ensureLoaded(): Promise<Task[]> {
    if (this.cache !== null) return this.cache;
    this.cache = await this.readFile();
    return this.cache;
  }

  private async persist(): Promise<void> {
    if (this.cache === null) return;
    await this.writeFile(this.cache);
    this.notify();
  }

  /** 获取所有任务 */
  async getAll(): Promise<Task[]> {
    return [...(await this.ensureLoaded())];
  }

  /** 获取未完成任务 */
  async getActive(): Promise<Task[]> {
    const tasks = await this.ensureLoaded();
    return tasks.filter(t => t.status !== "completed");
  }

  /** 创建任务 */
  async create(
    title: string,
    opts?: {
      description?: string;
      priority?: TaskPriority;
      startDate?: string;
      dueDate?: string;
    }
  ): Promise<Task> {
    const tasks = await this.ensureLoaded();
    const task: Task = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      description: opts?.description,
      status: "pending",
      priority: opts?.priority || "medium",
      startDate: opts?.startDate || today(),
      dueDate: opts?.dueDate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    tasks.unshift(task);
    if (tasks.length > MAX_TASKS) tasks.length = MAX_TASKS;
    await this.persist();
    return task;
  }

  /** 更新状态 */
  async updateStatus(id: string, status: TaskStatus): Promise<void> {
    const tasks = await this.ensureLoaded();
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return;
    tasks[idx] = {
      ...tasks[idx],
      status,
      updatedAt: new Date().toISOString(),
      completedAt: status === "completed" ? new Date().toISOString() : undefined,
    };
    await this.persist();
  }

  /** 更新任务 */
  async update(id: string, patch: Partial<Pick<Task, "title" | "description" | "priority" | "startDate" | "dueDate">>): Promise<void> {
    const tasks = await this.ensureLoaded();
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return;
    tasks[idx] = { ...tasks[idx], ...patch, updatedAt: new Date().toISOString() };
    await this.persist();
  }

  /** 删除任务 */
  async remove(id: string): Promise<void> {
    const tasks = await this.ensureLoaded();
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return;
    tasks.splice(idx, 1);
    await this.persist();
  }

  /** 清除已完成 */
  async clearCompleted(): Promise<void> {
    const tasks = await this.ensureLoaded();
    this.cache = tasks.filter(t => t.status !== "completed");
    await this.persist();
  }

  /** 统计 */
  async getStats(): Promise<{ total: number; pending: number; inProgress: number; completed: number }> {
    const tasks = await this.ensureLoaded();
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === "pending").length,
      inProgress: tasks.filter(t => t.status === "in_progress").length,
      completed: tasks.filter(t => t.status === "completed").length,
    };
  }
}

/** 全局单例 */
export const taskManager = new TaskManager();
