import path from "node:path";
import type { Config } from "../config";

/**
 * Texts arrive the moment they land (operator, 2026-09-14: "the message
 * syncing is not immediate"). Messages.app and WhatsApp both write their
 * chats to a SQLite file on this Mac, and SQLite writes go to the file or
 * its -wal beside it, so a change to either is a text having arrived. The
 * app watches the two folders and syncs the account behind whichever file
 * moved, instead of waiting for the three-minute clock.
 */
export type ChatWatchProvider = "imessage" | "whatsapp";

export interface ChatWatchTarget {
  provider: ChatWatchProvider;
  /** The folder to watch: a file that does not exist yet (a fresh -wal) still fires here. */
  dir: string;
  /** The database's own name; the file, its -wal and its -shm all start with it. */
  prefix: string;
}

export function chatWatchTargets(cfg: Pick<Config, "chatDbPath" | "whatsappDbPath">): ChatWatchTarget[] {
  return [
    { provider: "imessage", dir: path.dirname(cfg.chatDbPath), prefix: path.basename(cfg.chatDbPath) },
    { provider: "whatsapp", dir: path.dirname(cfg.whatsappDbPath), prefix: path.basename(cfg.whatsappDbPath) },
  ];
}

/** Whether a name the folder reported belongs to the database: the file, its -wal or its -shm. */
export function isWatchedFile(name: string | null | undefined, prefix: string): boolean {
  if (!name) return false;
  return name === prefix || name === `${prefix}-wal` || name === `${prefix}-shm` || name === `${prefix}-journal`;
}

/**
 * Turns a burst of file events into one sync, and a change during a sync
 * into one more afterwards. A text is several writes close together, and a
 * sync that started on the first would miss the last; waiting a moment
 * after the burst ends catches the whole text, and a change that lands
 * while the sync is reading is not lost either, it runs the sync again once.
 */
export class ChangeTrigger<K extends string = string> {
  private timers = new Map<K, ReturnType<typeof setTimeout>>();
  private running = new Set<K>();
  private again = new Set<K>();

  constructor(
    private readonly run: (key: K) => Promise<void>,
    private readonly opts: { debounceMs: number; onError?: (key: K, err: unknown) => void } = { debounceMs: 1000 },
  ) {}

  /** Something changed for `key`: a sync follows once the burst has settled. */
  touch(key: K): void {
    const pending = this.timers.get(key);
    if (pending) clearTimeout(pending);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.fire(key);
      }, this.opts.debounceMs),
    );
  }

  /** Keys with a sync waiting or running, for tests and for a status line. */
  get busy(): K[] {
    return [...new Set([...this.timers.keys(), ...this.running])];
  }

  /** Drops every waiting sync; a running one finishes on its own. */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.again.clear();
  }

  private async fire(key: K): Promise<void> {
    if (this.running.has(key)) {
      this.again.add(key);
      return;
    }
    this.running.add(key);
    try {
      await this.run(key);
    } catch (err) {
      this.opts.onError?.(key, err);
    } finally {
      this.running.delete(key);
    }
    if (this.again.delete(key)) void this.fire(key);
  }
}

/**
 * A task on a clock that never runs twice at once (2026-09-14: mail from the
 * server every two minutes, "tab open or not"). A tick that lands while the
 * last run is still going is skipped rather than queued: the run in flight
 * will already bring in whatever the skipped tick would have.
 */
export class Ticker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(
    private readonly run: () => Promise<void>,
    private readonly opts: { everyMs: number; firstAfterMs?: number; onError?: (err: unknown) => void },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.everyMs);
    if (this.opts.firstAfterMs !== undefined) this.first = setTimeout(() => void this.tick(), this.opts.firstAfterMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = null;
    this.first = null;
  }

  get running(): boolean {
    return this.busy;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.run();
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.busy = false;
    }
  }
}
