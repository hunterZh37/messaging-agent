import { watch, type FSWatcher } from "node:fs";
import { ChangeTrigger, chatWatchTargets, isWatchedFile, type ChatWatchProvider } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { syncChats } from "@/lib/syncAll";
import { notifyNeedsReply } from "@/lib/push";

/**
 * Texts arrive the moment they land (operator, 2026-09-14). The server
 * watches the folders that hold Messages.app's and WhatsApp's databases,
 * and a change to one of those files, the file or its -wal, syncs that
 * chat's account a second later, whether or not a Celeste tab is open. Mail
 * stays on the page's clock: there is no file to watch for it.
 *
 * Started once from instrumentation.ts when the server comes up. The
 * handle lives on globalThis so a dev server reloading this module does
 * not watch the same folder twice.
 */
const KEY = Symbol.for("celeste.chatWatchers");

interface Watchers {
  watchers: FSWatcher[];
  trigger: ChangeTrigger<ChatWatchProvider>;
}

function held(): Watchers | undefined {
  return (globalThis as unknown as Record<symbol, Watchers | undefined>)[KEY];
}

export function startChatWatchers(): void {
  if (held()) return;
  const { cfg } = core();
  const trigger = new ChangeTrigger<ChatWatchProvider>(
    async (provider) => {
      const r = await syncChats(provider);
      // Only a text that arrived is worth a line; a write that stored nothing (a read receipt, a typing bubble) is not.
      if (r.stored > 0) {
        console.log(`chat watcher: ${provider} synced, ${r.stored} new`);
        // A text from someone the operator knows is in Need to reply now: say so on the phone (2026-09-14).
        await notifyNeedsReply().catch((err) => console.error(`push: ${(err as Error).message}`));
      }
    },
    {
      debounceMs: 1000,
      onError: (provider, err) => console.error(`chat watcher: ${provider}: ${(err as Error).message}`),
    },
  );
  // Texts that arrived while the server was down write nothing new once it is
  // up, so the watcher would never hear of them (2026-09-15): read both chats
  // once at start.
  trigger.touch("imessage");
  trigger.touch("whatsapp");
  const watchers: FSWatcher[] = [];
  for (const target of chatWatchTargets(cfg)) {
    try {
      const w = watch(target.dir, { persistent: false }, (_event, name) => {
        if (isWatchedFile(name, target.prefix)) trigger.touch(target.provider);
      });
      // A folder that goes away (an app never installed, a container
      // renamed) is logged and left; the clock still syncs that account.
      w.on("error", (err) => console.error(`chat watcher: ${target.provider}: ${err.message}`));
      watchers.push(w);
    } catch (err) {
      console.error(`chat watcher: cannot watch ${target.dir}: ${(err as Error).message}`);
    }
  }
  (globalThis as unknown as Record<symbol, Watchers>)[KEY] = { watchers, trigger };
  console.log(`chat watcher: watching ${watchers.length} folder${watchers.length === 1 ? "" : "s"}`);
}

export function stopChatWatchers(): void {
  const h = held();
  if (!h) return;
  h.trigger.stop();
  for (const w of h.watchers) w.close();
  delete (globalThis as unknown as Record<symbol, Watchers | undefined>)[KEY];
}
