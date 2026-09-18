import { Ticker } from "@messaging-agent/core";
import { fetchMail, processMail, syncAllChats } from "@/lib/syncAll";
import { notifyNeedsReply } from "@/lib/push";

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
