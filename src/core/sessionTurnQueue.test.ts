import { describe, expect, it } from "vitest";
import { SessionTurnQueue } from "./sessionTurnQueue";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("SessionTurnQueue", () => {
  it("同一会话严格串行，不同会话可并行", async () => {
    const queue = new SessionTurnQueue();
    const events: string[] = [];

    await Promise.all([
      queue.enqueue("a", async () => { events.push("a1-start"); await delay(20); events.push("a1-end"); }),
      queue.enqueue("a", async () => { events.push("a2-start"); events.push("a2-end"); }),
      queue.enqueue("b", async () => { events.push("b-start"); events.push("b-end"); }),
    ]);

    expect(events.indexOf("a2-start")).toBeGreaterThan(events.indexOf("a1-end"));
    expect(events.indexOf("b-start")).toBeLessThan(events.indexOf("a1-end"));
    expect(queue.isBusy("a")).toBe(false);
  });

  it("任务抛错后仍释放后续任务", async () => {
    const queue = new SessionTurnQueue();
    await expect(queue.enqueue("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(queue.enqueue("a", async () => "ok")).resolves.toBe("ok");
  });
});
