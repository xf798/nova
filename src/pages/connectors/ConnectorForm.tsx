// ===== 连接器表单组件 =====
// 统一处理 API / CLI / Bot 三种类型的表单渲染，支持新增和编辑两种模式。

import type { BotPlatform } from "../../connectors";

// ─── 表单数据类型 ───

export interface ApiFormData {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  description: string;
}

export interface CliFormData {
  id: string;
  name: string;
  command: string;
  args: string;
  cwd: string;
  description: string;
}

export interface BotFormData {
  name: string;
  platform: BotPlatform;
  botId: string;
  secret: string;
  autoConnect: boolean;
}

// ─── 输入框样式常量 ───

const inputCls = "w-full px-3 py-2 rounded-lg border border-app-border bg-app-bg text-[13px] text-app-text focus:outline-none focus:border-app-text-muted";
const labelCls = "text-[11px] text-app-text-muted font-medium mb-1 block";
const btnPrimary = "px-4 py-1.5 rounded-lg text-[12px] font-medium bg-[#10a37f] text-white hover:bg-[#0d8c6d] disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
const btnSecondary = "px-3 py-1.5 rounded-lg text-[12px] font-medium border border-app-border text-app-text-muted hover:text-app-text transition-colors";

// ─── API 表单 ───

export function ApiForm({ data, onChange, onSubmit, onCancel, isEdit }: {
  data: ApiFormData;
  onChange: (d: ApiFormData) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  isEdit?: boolean;
}) {
  const disabled = isEdit
    ? !data.name || !data.endpoint || !data.apiKey
    : !data.id || !data.name || !data.endpoint || !data.apiKey;

  return (
    <div className="space-y-3">
      {!isEdit && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>ID</label>
            <input value={data.id} onChange={(e) => onChange({ ...data, id: e.target.value })} placeholder="deepseek" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>名称</label>
            <input value={data.name} onChange={(e) => onChange({ ...data, name: e.target.value })} placeholder="DeepSeek" className={inputCls} />
          </div>
        </div>
      )}
      {isEdit && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>名称</label>
            <input value={data.name} onChange={(e) => onChange({ ...data, name: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>默认模型</label>
            <input value={data.model} onChange={(e) => onChange({ ...data, model: e.target.value })} className={inputCls} />
          </div>
        </div>
      )}
      <div>
        <label className={labelCls}>API Endpoint</label>
        <input value={data.endpoint} onChange={(e) => onChange({ ...data, endpoint: e.target.value })} placeholder="https://api.openai.com/v1" className={inputCls} />
        {!isEdit && <p className="text-[10px] text-app-text-muted mt-1">支持任何 OpenAI 兼容接口：OpenAI、DeepSeek、Ollama (http://localhost:11434/v1) 等</p>}
      </div>
      <div>
        <label className={labelCls}>API Key</label>
        <input type="password" value={data.apiKey} onChange={(e) => onChange({ ...data, apiKey: e.target.value })} placeholder="sk-..." className={inputCls} />
      </div>
      {!isEdit && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>默认模型</label>
            <input value={data.model} onChange={(e) => onChange({ ...data, model: e.target.value })} placeholder="gpt-4o" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>描述（可选）</label>
            <input value={data.description} onChange={(e) => onChange({ ...data, description: e.target.value })} placeholder="我的 DeepSeek 账号" className={inputCls} />
          </div>
        </div>
      )}
      {isEdit && (
        <div>
          <label className={labelCls}>描述</label>
          <input value={data.description} onChange={(e) => onChange({ ...data, description: e.target.value })} className={inputCls} />
        </div>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && <button onClick={onCancel} className={btnSecondary}>取消</button>}
        <button onClick={onSubmit} disabled={disabled} className={btnPrimary}>{isEdit ? "保存" : "添加"}</button>
      </div>
    </div>
  );
}

// ─── CLI 表单 ───

export function CliForm({ data, onChange, onSubmit, onCancel, isEdit }: {
  data: CliFormData;
  onChange: (d: CliFormData) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  isEdit?: boolean;
}) {
  const disabled = isEdit
    ? !data.name || !data.command
    : !data.id || !data.name || !data.command;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {!isEdit && (
          <div>
            <label className={labelCls}>ID</label>
            <input value={data.id} onChange={(e) => onChange({ ...data, id: e.target.value })} placeholder="my-cli" className={inputCls} />
          </div>
        )}
        <div>
          <label className={labelCls}>名称</label>
          <input value={data.name} onChange={(e) => onChange({ ...data, name: e.target.value })} placeholder={isEdit ? "" : "My CLI"} className={inputCls} />
        </div>
        {isEdit && (
          <div>
            <label className={labelCls}>命令</label>
            <input value={data.command} onChange={(e) => onChange({ ...data, command: e.target.value })} className={inputCls} />
          </div>
        )}
      </div>
      {!isEdit && (
        <div>
          <label className={labelCls}>命令</label>
          <input value={data.command} onChange={(e) => onChange({ ...data, command: e.target.value })} placeholder="kiro-cli" className={inputCls} />
        </div>
      )}
      <div>
        <label className={labelCls}>默认参数</label>
        <input value={data.args} onChange={(e) => onChange({ ...data, args: e.target.value })} placeholder="chat --no-interactive --trust-all-tools" className={inputCls} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>工作目录</label>
          <input value={data.cwd} onChange={(e) => onChange({ ...data, cwd: e.target.value })} placeholder="/Users/wangxf/workspace" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>描述（可选）</label>
          <input value={data.description} onChange={(e) => onChange({ ...data, description: e.target.value })} placeholder="" className={inputCls} />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && <button onClick={onCancel} className={btnSecondary}>取消</button>}
        <button onClick={onSubmit} disabled={disabled} className={btnPrimary}>{isEdit ? "保存" : "添加"}</button>
      </div>
    </div>
  );
}

// ─── Bot 表单 ───

export function BotForm({ data, onChange, onSubmit, onCancel, isEdit, submitLabel }: {
  data: BotFormData;
  onChange: (d: BotFormData) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  isEdit?: boolean;
  submitLabel?: string;
}) {
  const disabled = !data.botId || !data.secret;

  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls}>机器人平台</label>
        <div className="flex gap-2">
          {(["wecom", "feishu", "dingtalk"] as BotPlatform[]).map(p => (
            <button
              key={p}
              onClick={() => onChange({ ...data, platform: p })}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors ${
                data.platform === p
                  ? "border-[#10a37f] bg-[#10a37f]/10 text-[#10a37f]"
                  : "border-app-border text-app-text-muted hover:border-app-text-muted"
              }`}
            >
              {p === "wecom" ? "企业微信" : p === "feishu" ? "飞书" : "钉钉"}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className={labelCls}>机器人名称</label>
        <input value={data.name} onChange={(e) => onChange({ ...data, name: e.target.value })} placeholder="如：Nova 助手" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Bot ID</label>
        <input value={data.botId} onChange={(e) => onChange({ ...data, botId: e.target.value })} placeholder="aib..." className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>Secret</label>
        <input type="password" value={data.secret} onChange={(e) => onChange({ ...data, secret: e.target.value })} placeholder="Secret..." className={inputCls} />
      </div>
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-[12px] cursor-pointer select-none">
          <button
            onClick={() => onChange({ ...data, autoConnect: !data.autoConnect })}
            className={`relative w-8 h-[18px] rounded-full transition-colors ${data.autoConnect ? 'bg-[#10a37f]' : 'bg-app-border'}`}
          >
            <span className={`absolute top-[2px] w-[14px] h-[14px] bg-white rounded-full shadow transition-transform ${data.autoConnect ? 'left-[14px]' : 'left-[2px]'}`}></span>
          </button>
          <span className="text-app-text-secondary">自动连接</span>
        </label>
        <div className="flex gap-2">
          {onCancel && <button onClick={onCancel} className={btnSecondary}>取消</button>}
          <button onClick={onSubmit} disabled={disabled} className={btnPrimary}>{submitLabel || (isEdit ? "保存" : "保存并连接")}</button>
        </div>
      </div>
      {!isEdit && (
        <p className="text-[10px] text-app-text-muted leading-relaxed">
          连接 IM 机器人后，收到的消息将通过当前活跃的 AI 连接器处理并自动回复。{data.platform !== "wecom" && "（飞书/钉钉支持即将推出）"}
        </p>
      )}
    </div>
  );
}

// ─── 类型切换 Tab ───

type AddMode = "api" | "cli" | "bot";

export function ModeSelector({ mode, onModeChange }: { mode: AddMode; onModeChange: (m: AddMode) => void }) {
  const items: { key: AddMode; label: string; icon: React.ReactNode }[] = [
    {
      key: "api", label: "API 模型",
      icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>,
    },
    {
      key: "cli", label: "CLI 工具",
      icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
    },
    {
      key: "bot", label: "IM 机器人",
      icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><circle cx="8" cy="16" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1" fill="currentColor" stroke="none"/></svg>,
    },
  ];

  return (
    <div className="flex gap-2">
      {items.map(item => (
        <button
          key={item.key}
          onClick={() => onModeChange(item.key)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
            mode === item.key
              ? "bg-app-surface-hover text-app-text"
              : "text-app-text-muted hover:text-app-text-secondary"
          }`}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
