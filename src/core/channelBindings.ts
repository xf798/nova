import { StorageService } from "./storage";

export type ChannelKind = "wecom";

export interface ChannelBinding {
  channel: ChannelKind;
  channelSessionId: string;
  targetSessionId: string;
  createdAt: string;
}

interface BindingStorage {
  get<T>(namespace: string, key: string, defaultValue?: T): Promise<T | undefined>;
  set(namespace: string, key: string, value: unknown): Promise<void>;
}

const NAMESPACE = "channel-bindings";
const STORAGE_KEY = "items";
export const CHANNEL_BINDING_CHANGED_EVENT = "nova-channel-binding-changed";

function bindingKey(channel: ChannelKind, channelSessionId: string): string {
  return `${channel}:${channelSessionId}`;
}

export function resolveBindingTarget(
  channelSessionId: string,
  binding: ChannelBinding | null,
  sessionIds: Iterable<string>,
): { targetSessionId: string; invalidBinding: boolean } {
  if (!binding) return { targetSessionId: channelSessionId, invalidBinding: false };
  const existing = new Set(sessionIds);
  if (!existing.has(binding.targetSessionId)) {
    return { targetSessionId: channelSessionId, invalidBinding: true };
  }
  return { targetSessionId: binding.targetSessionId, invalidBinding: false };
}


export interface BindableSession {
  id: string;
  title: string;
  updatedAt: string;
}

export type BindTargetMatch =
  | { kind: "matched"; session: BindableSession }
  | { kind: "ambiguous"; candidates: BindableSession[] }
  | { kind: "none" };

export function isChannelSessionId(sessionId: string): boolean {
  return sessionId.startsWith("wecom-");
}

/**
 * 对话里下达绑定指令时只会说会话标题（"绑到客户画像-UI"），拿不到 session-1755xxx-a1b2 这种 ID，
 * 所以按 ID → 同名 → 包含 三级放宽匹配。命中多个同名时取最近更新的那个：标题相同的会话
 * 在对话里无从区分，追问也问不出来，取最新最接近意图；包含匹配命中多个则交回候选让上层追问。
 */
export function matchBindTarget(target: string, sessions: BindableSession[]): BindTargetMatch {
  const keyword = target.trim().toLowerCase();
  if (!keyword) return { kind: "none" };

  const bindable = sessions.filter(session => !isChannelSessionId(session.id));
  const newestFirst = (a: BindableSession, b: BindableSession) => b.updatedAt.localeCompare(a.updatedAt);

  const byId = bindable.find(session => session.id === target.trim());
  if (byId) return { kind: "matched", session: byId };

  const exact = bindable.filter(session => session.title.trim().toLowerCase() === keyword);
  if (exact.length) return { kind: "matched", session: [...exact].sort(newestFirst)[0] };

  const partial = bindable.filter(session => session.title.toLowerCase().includes(keyword));
  if (partial.length === 1) return { kind: "matched", session: partial[0] };
  if (partial.length > 1) return { kind: "ambiguous", candidates: [...partial].sort(newestFirst).slice(0, 10) };

  return { kind: "none" };
}


export class ChannelBindingStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: BindingStorage = StorageService.getInstance()) {}

  private async load(): Promise<Record<string, ChannelBinding>> {
    return (await this.storage.get<Record<string, ChannelBinding>>(NAMESPACE, STORAGE_KEY, {})) || {};
  }

  private notify(binding?: ChannelBinding): void {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(CHANNEL_BINDING_CHANGED_EVENT, { detail: binding }));
    }
  }

  async get(channel: ChannelKind, channelSessionId: string): Promise<ChannelBinding | null> {
    const items = await this.load();
    return items[bindingKey(channel, channelSessionId)] || null;
  }

  async bind(channel: ChannelKind, channelSessionId: string, targetSessionId: string): Promise<ChannelBinding> {
    const binding: ChannelBinding = {
      channel,
      channelSessionId,
      targetSessionId,
      createdAt: new Date().toISOString(),
    };
    await this.mutate(items => {
      items[bindingKey(channel, channelSessionId)] = binding;
    });
    this.notify(binding);
    return binding;
  }

  async unbind(channel: ChannelKind, channelSessionId: string): Promise<void> {
    await this.mutate(items => {
      delete items[bindingKey(channel, channelSessionId)];
    });
    this.notify();
  }

  async removeByTargetSession(targetSessionId: string): Promise<void> {
    let changed = false;
    await this.mutate(items => {
      for (const [key, binding] of Object.entries(items)) {
        if (binding.targetSessionId === targetSessionId) {
          delete items[key];
          changed = true;
        }
      }
    });
    if (changed) this.notify();
  }

  private async mutate(update: (items: Record<string, ChannelBinding>) => void): Promise<void> {
    const operation = this.mutationQueue.catch(() => {}).then(async () => {
      const items = await this.load();
      update(items);
      await this.storage.set(NAMESPACE, STORAGE_KEY, items);
    });
    this.mutationQueue = operation;
    await operation;
  }
}

export const channelBindings = new ChannelBindingStore();
