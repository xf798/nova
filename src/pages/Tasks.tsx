import { useState, useEffect, useCallback } from "react";
import { taskManager, buildTaskPrompt } from "../core/task";
import type { Task, TaskStatus, TaskPriority } from "../core/task";
import { useAppStore } from "../App";

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: "text-app-text-muted",
  medium: "text-app-text-secondary",
  high: "text-orange-400",
};

function Tasks() {
  const { navigateTo } = useAppStore();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "completed">("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [, forceUpdate] = useState(0);

  const refresh = useCallback(async () => {
    const all = await taskManager.getAll();
    setTasks(all);
  }, []);

  useEffect(() => {
    // 页面切入时清除缓存，确保读取最新文件数据
    taskManager.invalidateCache();
    refresh();
    const unsub = taskManager.subscribe(() => {
      forceUpdate(n => n + 1);
      refresh();
    });
    return () => { unsub(); };
  }, [refresh]);

  const handleAdd = async () => {
    const title = newTitle.trim();
    if (!title) return;
    await taskManager.create(title);
    setNewTitle("");
  };

  const handleStatusChange = async (id: string, status: TaskStatus) => {
    await taskManager.updateStatus(id, status);
  };

  const handleDelete = async (id: string) => {
    await taskManager.remove(id);
    if (editingId === id) setEditingId(null);
  };

  const handleClearCompleted = async () => {
    await taskManager.clearCompleted();
  };

  /**
   * 把任务交给对话处理：开新会话发出首条消息，并切到 chat 页。
   *
   * 派发事件而不直接调 ChatView —— ChatView 始终挂载但不在这里的组件树上，
   * 事件是现有的跨页通信方式（参考 nova-add-attachment）。
   */
  const handleSendToChat = (task: Task) => {
    window.dispatchEvent(new CustomEvent("nova-send-to-new-session", {
      detail: buildTaskPrompt(task),
    }));
    navigateTo("chat");
  };

  const filtered = filter === "all" ? tasks :
    filter === "active" ? tasks.filter(t => t.status !== "completed") :
    tasks.filter(t => t.status === "completed");

  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-app-text">Tasks</h2>
        {tasks.some(t => t.status === "completed") && (
          <button
            onClick={handleClearCompleted}
            className="text-[12px] text-app-text-muted hover:text-red-400 transition-colors"
          >
            清除已完成
          </button>
        )}
      </div>

      {/* 新建任务 — 极简，只有输入框 */}
      <div className="flex gap-2 mb-6">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          placeholder="添加任务… 按回车确认"
          className="flex-1 px-4 py-2.5 rounded-xl border border-app-border bg-transparent text-[14px] text-app-text placeholder:text-app-text-muted focus:outline-none focus:border-app-text-muted"
        />
      </div>

      {/* 筛选 */}
      <div className="flex gap-2 mb-4">
        {(["all", "active", "completed"] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
              filter === f
                ? "bg-app-surface-hover text-app-text"
                : "text-app-text-muted hover:text-app-text-secondary"
            }`}
          >
            {f === "all" ? "全部" : f === "active" ? "进行中" : "已完成"}
          </button>
        ))}
      </div>

      {/* 任务列表 */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-app-text-muted text-sm">
            {filter === "completed" ? "暂无已完成任务" : "暂无任务，添加一个吧"}
          </div>
        ) : (
          filtered.map(task => (
            <TaskItem
              key={task.id}
              task={task}
              isEditing={editingId === task.id}
              onEdit={() => setEditingId(editingId === task.id ? null : task.id)}
              onStatusChange={handleStatusChange}
              onDelete={handleDelete}
              onSave={async (id, patch) => {
                await taskManager.update(id, patch);
                setEditingId(null);
              }}
              onSendToChat={() => handleSendToChat(task)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskItem({ task, isEditing, onEdit, onStatusChange, onDelete, onSave, onSendToChat }: {
  task: Task;
  isEditing: boolean;
  onEdit: () => void;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onDelete: (id: string) => void;
  onSave: (id: string, patch: Partial<Pick<Task, "title" | "description" | "priority" | "dueDate">>) => void;
  onSendToChat: () => void;
}) {
  const isCompleted = task.status === "completed";
  const [editTitle, setEditTitle] = useState(task.title);
  const [editPriority, setEditPriority] = useState(task.priority);
  const [editDueDate, setEditDueDate] = useState(task.dueDate || "");
  const [editDescription, setEditDescription] = useState(task.description || "");

  const isOverdue = task.dueDate && !isCompleted && task.dueDate < new Date().toISOString().slice(0, 10);

  useEffect(() => {
    setEditTitle(task.title);
    setEditPriority(task.priority);
    setEditDueDate(task.dueDate || "");
    setEditDescription(task.description || "");
  }, [task]);

  const handleSave = () => {
    onSave(task.id, {
      title: editTitle.trim() || task.title,
      priority: editPriority,
      dueDate: editDueDate || undefined,
      description: editDescription.trim() || undefined,
    });
  };

  return (
    <div className="group p-3 rounded-xl border border-app-border bg-app-surface hover:bg-app-surface-hover transition-colors">
      <div className="flex items-center gap-3">
        {/* 状态切换 */}
        <button
          onClick={() => {
            const next = isCompleted ? "pending" :
              task.status === "pending" ? "in_progress" : "completed";
            onStatusChange(task.id, next);
          }}
          className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
            isCompleted ? "bg-green-500 border-green-500" :
            task.status === "in_progress" ? "border-blue-500" :
            "border-app-border"
          }`}
        >
          {isCompleted && (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8.5L7 11.5l5-7" />
            </svg>
          )}
          {task.status === "in_progress" && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
          )}
        </button>

        {/* 内容 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-[14px] leading-tight ${isCompleted ? "line-through text-app-text-muted" : "text-app-text"}`}>
              {task.title}
            </span>
            <span className={`text-[10px] ${PRIORITY_COLORS[task.priority]}`}>
              {PRIORITY_LABELS[task.priority]}
            </span>
            {isOverdue && <span className="text-[10px] text-red-400">逾期</span>}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] text-app-text-muted">{STATUS_LABELS[task.status]}</span>
            {task.dueDate && (
              <>
                <span className="text-[10px] text-app-text-muted">·</span>
                <span className={`text-[10px] ${isOverdue ? "text-red-400" : "text-app-text-muted"}`}>
                  {task.dueDate}
                </span>
              </>
            )}
          </div>
        </div>

        {/* 操作 */}
        {!isCompleted && (
          <button
            onClick={onSendToChat}
            className="opacity-0 group-hover:opacity-100 text-app-text-muted hover:text-[#10a37f] transition-all p-1"
            title="发送到新会话处理"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2L11 13" />
              <path d="M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        )}
        <button
          onClick={onEdit}
          className="opacity-0 group-hover:opacity-100 text-app-text-muted hover:text-app-text transition-all p-1"
          title="编辑"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
        <button
          onClick={() => onDelete(task.id)}
          className="opacity-0 group-hover:opacity-100 text-app-text-muted hover:text-red-400 transition-all p-1"
          title="删除"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* 编辑面板 — 紧凑内联 */}
      {isEditing && (
        <div className="mt-2 pt-2 border-t border-app-border space-y-2">
          <input
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            placeholder="任务标题"
            className="w-full px-2.5 py-1.5 rounded-lg border border-app-border bg-app-bg text-[13px] text-app-text focus:outline-none focus:border-app-text-muted"
          />
          <textarea
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            placeholder="描述（可选）"
            rows={4}
            className="w-full px-2.5 py-1.5 rounded-lg border border-app-border bg-app-bg text-[12px] text-app-text placeholder:text-app-text-muted focus:outline-none focus:border-app-text-muted resize-y leading-relaxed min-h-[80px]"
          />
          <div className="flex items-center gap-2">
            <select
              value={editPriority}
              onChange={(e) => setEditPriority(e.target.value as TaskPriority)}
              className="h-[30px] px-2.5 rounded-lg border border-app-border bg-app-bg text-[12px] text-app-text focus:outline-none"
            >
              <option value="low">低优先</option>
              <option value="medium">中优先</option>
              <option value="high">高优先</option>
            </select>
            <input
              type="date"
              value={editDueDate}
              onChange={(e) => setEditDueDate(e.target.value)}
              className="h-[30px] px-2.5 rounded-lg border border-app-border bg-app-bg text-[12px] text-app-text focus:outline-none"
              placeholder="截止日期"
            />
            <div className="flex-1" />
            <button
              onClick={onEdit}
              className="px-2.5 py-1 rounded-md text-[11px] text-app-text-muted hover:text-app-text transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-[#10a37f] text-white hover:bg-[#0d8c6d] transition-colors"
            >
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Tasks;
