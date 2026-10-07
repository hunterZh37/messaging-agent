import { Ticker, embedPending, createOllamaEmbedder } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { localModelBusy } from "@/lib/mailClock";

/** How many messages one pass embeds. 200 is `embedPending`'s own batch. */
export const EMBED_BATCH = 200;

/** How often a pass runs while there is a backlog. */
export const EMBED_EVERY_MS = 60_000;

/** How long the clock rests once there is nothing left to embed. */
export const EMBED_RESTING_MS = 900_000;

/**
 * Whether the previous failure is still the same one: kept across ticks so
 * a dead Ollama is one log line, not one every minute (2026-10-07). Module
 * state rather than something threaded through every call, because the
 * thing it is remembering — "did the last tick already say this" — only
 * means anything across repeated ticks of the same clock.
 */
let quiet = false;

/**
 * One pass, with everything it talks to passed in so the test never starts a
 * timer or reaches Ollama. `resting` means the backlog is done: the pass
 * embedded less than a full batch, so the next tick can wait a long time.
 */
export async function embedBatch(deps: {
  embed: () => Promise<{ embedded: number; reembedded: number }>;
  sorting: () => boolean;
  log?: (message: string) => void;
}): Promise<{ embedded: number; resting: boolean }> {
  // The sorter and drafter share one local model with this, and the operator
  // is waiting on a sort in a way they are never waiting on a backfill
  // (2026-10-07).
  if (deps.sorting()) return { embedded: 0, resting: false };
  try {
    const { embedded } = await deps.embed();
    quiet = false;
    return { embedded, resting: embedded < EMBED_BATCH };
  } catch (err) {
    // Ollama off for a week is one line, not one a minute.
    if (!quiet) {
      deps.log?.(`embed clock: ${(err as Error).message}`);
      quiet = true;
    }
    return { embedded: 0, resting: false };
  }
}

const KEY = Symbol.for("celeste.embedClock");

/**
 * The mail the operator might ask about, embedded a batch at a time on the
 * server's own clock (operator, 2026-10-07: everything, email first, in the
 * background). Their mailbox is 94,149 messages at about forty milliseconds
 * each — an hour if it were done in one go, which would hold up the sorter,
 * since both share the one local model. So it is done in two-hundreds, and
 * it gets out of the way whenever mail is being brought in and sorted.
 *
 * Once there is nothing left the clock slows to a quarter-hour, so a mailbox
 * that is fully embedded is not a query a minute for ever. New mail is a
 * handful of messages, and a quarter-hour late to be searchable by meaning is
 * not a wait anybody notices.
 *
 * The handle lives on globalThis so a dev server reloading this module does
 * not start a second clock.
 */
export function startEmbedClock(): void {
  const g = globalThis as unknown as Record<symbol, Ticker | undefined>;
  if (g[KEY]) return;
  const { cfg, db } = core();
  const embedder = createOllamaEmbedder(cfg.ollamaUrl, cfg.embedModel, { db });

  let every = EMBED_EVERY_MS;

  const run = async (): Promise<void> => {
    const { embedded, resting } = await embedBatch({
      embed: () => embedPending(db, embedder, { scope: "search", limit: EMBED_BATCH }),
      sorting: localModelBusy,
      log: console.log,
    });
    if (embedded > 0) console.log(`embed clock: ${embedded} embedded`);
    // Resting and working are the same job on two different clocks, so the
    // one in flight is swapped rather than left running beside the new one.
    const want = resting ? EMBED_RESTING_MS : EMBED_EVERY_MS;
    if (g[KEY] && every !== want) {
      g[KEY].stop();
      every = want;
      const next = new Ticker(run, { everyMs: want, onError: (err) => console.error(`embed clock: ${(err as Error).message}`) });
      next.start();
      g[KEY] = next;
    }
  };

  const ticker = new Ticker(run, {
    everyMs: EMBED_EVERY_MS,
    // After the mail clock's first fetch, not alongside it.
    firstAfterMs: 30_000,
    onError: (err) => console.error(`embed clock: ${(err as Error).message}`),
  });
  ticker.start();
  g[KEY] = ticker;
  console.log(`embed clock: every ${EMBED_EVERY_MS / 1000}s while there is a backlog`);
}
