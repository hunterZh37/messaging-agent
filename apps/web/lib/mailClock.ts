import { Ticker, ollamaChatBusy } from "@messaging-agent/core";
import { fetchMail, processMail, syncAllChats, syncModelBusy } from "@/lib/syncAll";
import { notifyNeedsReply, notifySignin } from "@/lib/push";

/** How often the server brings mail in (operator, 2026-09-14: option 1, "about 2 minutes, tab open or not"). */
export const MAIL_EVERY_MS = 120_000;

/**
 * Mail on the server's own clock (2026-09-14). Mail used to be pulled only by
 * an open, visible tab, every three minutes, inside a sync that also sorted
 * and drafted for a minute and a half: a reply to a Waiting thread sat
 * unfetched for twenty minutes and the thread read as still waiting. Now the
 * server fetches every two minutes whether or not a tab is open, and hands
 * what arrived to the sorter without waiting for it. The open page reads
 * itself again through /api/pulse the moment anything is stored.
 *
 * The handle lives on globalThis so a dev server reloading this module does
 * not start a second clock.
 */
const KEY = Symbol.for("celeste.mailClock");

export function startMailClock(): void {
  const g = globalThis as unknown as Record<symbol, Ticker | undefined>;
  if (g[KEY]) return;
  const ticker = new Ticker(
    async () => {
      // The chats as well, a safety net under the file watcher (2026-09-15):
      // macOS can drop a change event, after sleep above all, and a text
      // would then wait for the next one. Reading a chat with nothing new
      // costs about a tenth of a second.
      const texts = await syncAllChats().catch((err) => {
        console.error(`mail clock: chats: ${(err as Error).message}`);
        return 0;
      });
      if (texts > 0) {
        console.log(`mail clock: ${texts} new texts`);
        void notifyNeedsReply().catch((err) => console.error(`push: ${(err as Error).message}`));
      }
      const { fetched, stored } = await fetchMail();
      // The fetch is where a revoked token first fails, so it is where the
      // phone can first be told (2026-10-09). After the fetch, not before:
      // an account only flips to needs_signin once something has tried it.
      void notifySignin().catch((err) => console.error(`push: ${(err as Error).message}`));
      if (stored > 0) {
        console.log(`mail clock: ${stored} new`);
        // Mail reaches Need to reply once it is sorted; the phone hears then (2026-09-14).
        void processMail(fetched)
          .then(() => notifyNeedsReply())
          .catch((err) => console.error(`mail clock: sorting failed: ${(err as Error).message}`));
      }
    },
    { everyMs: MAIL_EVERY_MS, firstAfterMs: 15_000, onError: (err) => console.error(`mail clock: ${(err as Error).message}`) },
  );
  ticker.start();
  g[KEY] = ticker;
  console.log(`mail clock: every ${MAIL_EVERY_MS / 1000}s`);
}

/**
 * Whether the one local model is in use right now, so another consumer of it
 * (the embed clock) can leave it alone (2026-10-07, renamed from
 * `mailClockBusy`: the embed clock never cared about the mail clock
 * specifically, only about the model the two of them share). The OR of three
 * signals, because none alone covers every path to the model:
 *
 * - This clock's own ticker, `Ticker.running` — true only while a fetch is
 *   actually in flight.
 * - `syncModelBusy()` — true for the whole of a `processMail` run, which
 *   outlives the tick that kicked it off (`processMail(fetched).then(...)`
 *   below is fire-and-forget on purpose, so a ninety-second sort never
 *   delays the next fetch) but says nothing about the manual actions
 *   (Re-sort, draft, revise) that call the sorter/drafter directly, bypassing
 *   `processMail` entirely.
 * - `ollamaChatBusy()` (fix round 2) — true for as long as any chat call to
 *   Ollama is actually on the wire, from *any* caller, manual actions
 *   included, since every one of them goes through `createOllamaProvider`'s
 *   one `post()`.
 *
 * Residual, accepted rather than missed: `ollamaChatBusy()` is instantaneous,
 * not held for a whole manual sort the way `syncModelBusy()` holds a
 * `processMail` run — so between two model calls inside one manual sort (the
 * gap where the sorter is writing a verdict to the database, say), this
 * reads false and the embed clock can start one batch there, delaying the
 * manual sort's next step by roughly that batch's length. Bounded, and far
 * better than the previous unbounded overlap.
 */
export function localModelBusy(): boolean {
  const g = globalThis as unknown as Record<symbol, Ticker | undefined>;
  return (g[KEY]?.running ?? false) || syncModelBusy() || ollamaChatBusy();
}
