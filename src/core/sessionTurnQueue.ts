/** 按 Nova sessionId 串行正式对话，不影响标题生成、记忆提取等临时连接器。 */
export class SessionTurnQueue {
  private readonly tails = new Map<string, Promise<void>>();

  isBusy(sessionId: string): boolean {
    return this.tails.has(sessionId);
  }

  async acquire(sessionId: string): Promise<() => void> {
    const previous = this.tails.get(sessionId) || Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    this.tails.set(sessionId, tail);

    await previous.catch(() => {});

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      void tail.finally(() => {
        if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
      });
    };
  }

  async enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(sessionId);
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export const sessionTurnQueue = new SessionTurnQueue();
