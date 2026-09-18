import { providerFor, readPsych, type PsychProgress } from "@messaging-agent/core";
import { core } from "./core";

/**
 * The psychology read: twenty model calls, about five minutes. Same shape as
 * the tone run and behind a route for the same reason, that a page's server
 * actions are serialized and this would block every button on it.
 */

export interface PsychRunState {
  running: boolean;
  done: number;
  total: number;
  axis: string | null;
  error: string | null;
}

interface Run extends PsychRunState {
  stop: AbortController | null;
}

const KEY = Symbol.for("celeste.psychRun");
const store = globalThis as unknown as Record<symbol, Run | undefined>;

function run(): Run {
  store[KEY] ??= { running: false, done: 0, total: 0, axis: null, error: null, stop: null };
  return store[KEY];
}

export function psychState(): PsychRunState {
  const { stop: _stop, ...state } = run();
  return state;
}

export function startPsychRun(): PsychRunState {
  const r = run();
  if (r.running) return psychState();

  const { cfg, db } = core();
  const stop = new AbortController();
  Object.assign(r, { running: true, done: 0, total: 20, axis: null, error: null, stop });

  void (async () => {
    try {
      await readPsych(db, providerFor(cfg.models.stats, cfg), {
        signal: stop.signal,
        onProgress: (p: PsychProgress) => Object.assign(r, { done: p.done, total: p.total, axis: p.axis }),
      });
    } catch (err) {
      r.error = (err as Error).message;
    } finally {
      r.running = false;
      r.stop = null;
    }
  })();

  return psychState();
}

/** Stop after the reading in flight. Axes already settled are kept. */
export function stopPsychRun(): PsychRunState {
  run().stop?.abort();
  return psychState();
}
