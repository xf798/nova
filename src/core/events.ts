// ===== 事件总线 =====

type EventHandler = (...args: any[]) => void;

/**
 * 简易事件总线，插件间通信的桥梁。
 * 
 * 使用方式：
 *   eventBus.on("connector:health", (id, ok) => { ... });
 *   eventBus.emit("connector:health", "kiro-cli", true);
 */
class EventBus {
  private listeners: Map<string, Set<EventHandler>> = new Map();

  /** 订阅事件 */
  on(event: string, handler: EventHandler): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);

    // 返回 unsubscribe 函数
    return () => {
      this.listeners.get(event)?.delete(handler);
    };
  }

  /** 单次订阅 */
  once(event: string, handler: EventHandler): () => void {
    const wrapper: EventHandler = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  /** 取消订阅 */
  off(event: string, handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  /** 发布事件 */
  emit(event: string, ...args: any[]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch (e) {
        console.error(`[EventBus] Error in handler for "${event}":`, e);
      }
    }
  }

  /** 清除某事件的所有监听 */
  clear(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

// 全局单例
export const eventBus = new EventBus();
export type { EventHandler };
