import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeTrigger, Ticker, chatWatchTargets, isWatchedFile } from "../../src/connectors/watch";

describe("chatWatchTargets", () => {
  it("names the folder and file of each chat database", () => {
    expect(chatWatchTargets({ chatDbPath: "/Users/h/Library/Messages/chat.db", whatsappDbPath: "/Users/h/Library/Group Containers/g/ChatStorage.sqlite" })).toEqual([
      { provider: "imessage", dir: "/Users/h/Library/Messages", prefix: "chat.db" },
      { provider: "whatsapp", dir: "/Users/h/Library/Group Containers/g", prefix: "ChatStorage.sqlite" },
    ]);
  });
});

describe("isWatchedFile", () => {
  it("is the database, its -wal, -shm or -journal, and nothing else in the folder", () => {
    expect(isWatchedFile("chat.db", "chat.db")).toBe(true);
    expect(isWatchedFile("chat.db-wal", "chat.db")).toBe(true);
    expect(isWatchedFile("chat.db-shm", "chat.db")).toBe(true);
    expect(isWatchedFile("chat.db-journal", "chat.db")).toBe(true);
    expect(isWatchedFile("Attachments", "chat.db")).toBe(false);
    expect(isWatchedFile("chat.db.backup", "chat.db")).toBe(false);
    expect(isWatchedFile(null, "chat.db")).toBe(false);
  });
});

/**
 * A burst of writes is one sync, and a write during a sync is one more
 * after it (2026-09-14): the moment a text lands, and never a sync that
 * read the file halfway through.
 */
describe("ChangeTrigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for the burst to settle, then runs once", async () => {
    const runs: string[] = [];
    const t = new ChangeTrigger(async (k) => void runs.push(k), { debounceMs: 1000 });
    t.touch("imessage");
    await vi.advanceTimersByTimeAsync(600);
    t.touch("imessage");
    await vi.advanceTimersByTimeAsync(600);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toEqual(["imessage"]);
    expect(t.busy).toEqual([]);
  });

  it("keeps the two chats apart", async () => {
    const runs: string[] = [];
    const t = new ChangeTrigger(async (k) => void runs.push(k), { debounceMs: 100 });
    t.touch("imessage");
    t.touch("whatsapp");
    await vi.advanceTimersByTimeAsync(150);
    expect(runs.sort()).toEqual(["imessage", "whatsapp"]);
  });

  it("runs once more after a sync when something changed while it ran, not once per change", async () => {
    let release: () => void = () => {};
    const runs: number[] = [];
    const t = new ChangeTrigger(
      async () => {
        runs.push(Date.now());
        if (runs.length === 1) await new Promise<void>((r) => (release = r));
      },
      { debounceMs: 100 },
    );
    t.touch("imessage");
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toHaveLength(1);
    // Three changes while the first sync is still reading.
    t.touch("imessage");
    await vi.advanceTimersByTimeAsync(100);
    t.touch("imessage");
    await vi.advanceTimersByTimeAsync(100);
    t.touch("imessage");
    await vi.advanceTimersByTimeAsync(100);
    expect(runs).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toHaveLength(2);
  });

  it("reports a failed sync and keeps going", async () => {
    const errors: string[] = [];
    let calls = 0;
    const t = new ChangeTrigger(
      async () => {
        calls++;
        if (calls === 1) throw new Error("locked");
      },
      { debounceMs: 10, onError: (k, e) => errors.push(`${k}: ${(e as Error).message}`) },
    );
    t.touch("whatsapp");
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toEqual(["whatsapp: locked"]);
    t.touch("whatsapp");
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(2);
  });

  it("stop drops what is waiting", async () => {
    let calls = 0;
    const t = new ChangeTrigger(async () => void calls++, { debounceMs: 10 });
    t.touch("imessage");
    t.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(0);
  });
});

/** Mail from the server on a clock, never two runs at once (2026-09-14). */
describe("Ticker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs first after a moment, then on every tick", async () => {
    let runs = 0;
    const t = new Ticker(async () => void runs++, { everyMs: 120_000, firstAfterMs: 20_000 });
    t.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toBe(3);
    t.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runs).toBe(3);
  });

  it("skips a tick that lands while the last run is still going", async () => {
    let runs = 0;
    let release: () => void = () => {};
    const t = new Ticker(
      async () => {
        runs++;
        await new Promise<void>((r) => (release = r));
      },
      { everyMs: 1000 },
    );
    t.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.running).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);
    t.stop();
  });

  it("reports a failed run and keeps its clock", async () => {
    const errors: string[] = [];
    let runs = 0;
    const t = new Ticker(
      async () => {
        runs++;
        if (runs === 1) throw new Error("imap down");
      },
      { everyMs: 1000, onError: (e) => errors.push((e as Error).message) },
    );
    t.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(errors).toEqual(["imap down"]);
    expect(runs).toBe(2);
    t.stop();
  });
});
