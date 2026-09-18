import { providerFor, readAll, unreadMonths, type ReadProgress } from "@messaging-agent/core";
import { core } from "./core";

/**
 * The tone reading, which takes minutes rather than seconds: about six
 * seconds a month on a local 8B model, so a full archive is a quarter of an
 * hour. Held in a module global for the same reason `syncAll` is, and behind
 * a route rather than a server action, because React serializes a page's
 * server actions and a run this long would block every button on the page.
 *
 * Nothing is queued and nothing resumes by itself. The operator starts it,
 * watches it, and can stop it; months already read stay read.
 */

export interface ToneRunState {
  running: boolean;
  done: number;
  total: number;
  /** The month last finished, so the page can show movement rather than a bare count. */
  month: string | null;
  error: string | null;
  /** Months with no reading yet, refreshed when a run ends. */
  remaining: number;
}

interface Run extends ToneRunState {
  stop: AbortController | null;
}

// Survives the dev server's module reloads, which would otherwise lose the
// handle on a run that is still going and let a second one start beside it.
const KEY = Symbol.for("celeste.toneRun");
const store = globalThis as unknown as Record<symbol, Run | undefined>;

function run(): Run {
  store[KEY] ??= { running: false, done: 0, total: 0, month: null, error: null, remaining: -1, stop: null };
  return store[KEY];
}

export function toneState(): ToneRunState {
  const r = run();
  const remaining = r.running ? r.remaining : unreadMonths(core().db).length;
  const { stop: _stop, ...state } = r;
  return { ...state, remaining };
}

/**
 * Start reading every month that has none. Calling it while a run is going
 * is not an error and does not start a second one: the operator pressing a
 * button twice means they want it done, not done twice.
 */
export function startToneRun(): ToneRunState {
  const r = run();
  if (r.running) return toneState();

  const { cfg, db } = core();
  const months = unreadMonths(db);
  const stop = new AbortController();
  Object.assign(r, { running: true, done: 0, total: months.length, month: null, error: null, remaining: months.length, stop });

  void (async () => {
    try {
      await readAll(db, providerFor(cfg.models.stats, cfg), {
        signal: stop.signal,
        onProgress: (p: ReadProgress) => {
          Object.assign(r, { done: p.done, month: p.month, remaining: p.total - p.done });
        },
      });
    } catch (err) {
      // Ollama not running, or the model not pulled. A setup step, and the
      // operator needs the sentence rather than a spinner that never ends.
      r.error = (err as Error).message;
    } finally {
      r.running = false;
      r.stop = null;
    }
  })();

  return toneState();
}

/** Stop after the month in flight. What has been read is kept. */
export function stopToneRun(): ToneRunState {
  run().stop?.abort();
  return toneState();
}
