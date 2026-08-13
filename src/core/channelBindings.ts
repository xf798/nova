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
