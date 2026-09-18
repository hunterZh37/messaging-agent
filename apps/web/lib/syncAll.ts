import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { connectorForAccount, createDrafter, createSorter, fetchAccounts, loadPipelineInputs, processPending, schema, type ChatWatchProvider, type FetchedAccount, type PipelineResult } from "@messaging-agent/core";
import { core } from "@/lib/core";

// Guards against overlapping full syncs: auto-sync on load and the header
// refresh icon can both fire around the same time, and a click while one is
// already running must join it rather than start a second one.
let running: Promise<PipelineResult> | null = null;
// Every sync in the order it was asked for, the chat watcher's included
// (2026-09-14): two syncs of one account at once would race over its
// watermark, so a full sync waits for a chat sync in flight and the other
// way round.
let tail: Promise<unknown> = Promise.resolve();

const error = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Syncs, sorts, labels, and drafts for every inbox. Used by the auto-sync on
 * load and the header refresh icon, through the /api/sync route rather than
 * a server action: React sends a page's server actions one at a time, so
 * while a sync ran (twenty seconds on a slow provider) every other action
 * from the page, a delete, a mark-opened, waited behind it (stress audit,
 * 2026-09-11). A route handler waits in no such line.
 */
export function syncAll(): Promise<PipelineResult> {
  if (!running) {
    running = runAll().finally(() => {
      running = null;
    });
  }
  return running;
}

/**
 * The chat watcher's sync (2026-09-14): the accounts of one chat provider,
 * and nothing else. No sorter and no drafter, because texts take neither
 * and a model call for every text that lands would be credit spent on
 * nothing; and no revalidation, because this runs outside any request and
 * the open page reads itself again through /api/pulse.
 */
export function syncChats(provider: ChatWatchProvider): Promise<{ synced: number; stored: number }> {
  const run = tail.then(async () => {
    const { cfg, db } = core();
    const rows = db.select().from(schema.accounts).where(eq(schema.accounts.provider, provider)).all();
    if (rows.length === 0) return { synced: 0, stored: 0 };
    const { blocklist } = await loadPipelineInputs(cfg);
    let synced = 0;
    let stored = 0;
    for (const account of rows) {
      try {
        const r = await connectorForAccount(cfg, db, account).sync(db, account, { backfillDays: 30, blocklist });
        synced++;
        stored += r.stored;
      } catch (err) {
        console.error(`chat watcher: sync of ${account.email} failed: ${(error(err))}`);
      }
    }
    return { synced, stored };
  });
  tail = run.catch(() => undefined);
  return run;
}

/** The mail accounts: everything but the chats, which the watcher syncs. */
function mailAccountIds(): string[] {
  const { db } = core();
  return db
    .select({ id: schema.accounts.id, provider: schema.accounts.provider, status: schema.accounts.status })
    .from(schema.accounts)
    .all()
    .filter((a) => a.provider !== "imessage" && a.provider !== "whatsapp" && a.status !== "disconnected")
    .map((a) => a.id);
}

/**
 * New mail in, and nothing else (2026-09-14): the fetch half, queued with
 * every other sync so no account is read twice at once. The server's mail
 * clock runs this every two minutes; sorting follows it separately.
 */
export function fetchMail(accountIds?: string[]): Promise<{ fetched: FetchedAccount[]; stored: number }> {
  const run = tail.then(async () => {
    const { cfg, db } = core();
    const { blocklist } = await loadPipelineInputs(cfg);
    const fetched = await fetchAccounts(db, { connectorFor: (account) => connectorForAccount(cfg, db, account), backfillDays: 7, blocklist }, accountIds ?? mailAccountIds());
    return { fetched, stored: fetched.reduce((n, f) => n + (f.result.sync?.stored ?? 0), 0) };
  });
  tail = run.catch(() => undefined);
  return run;
}

// One sort at a time, apart from the fetch queue: a sort that takes a minute
// and a half never holds the next fetch back (2026-09-14). A request while
// one runs is remembered, and it runs once more afterwards with every
// account fetched in between.
let processing: Promise<PipelineResult> | null = null;
let waiting: FetchedAccount[] | null = null;

export function processMail(fetched: FetchedAccount[]): Promise<PipelineResult> {
  if (processing) {
    waiting = [...(waiting ?? []), ...fetched];
    return processing;
  }
  processing = (async () => {
    const { cfg, db } = core();
    const { criteria, voice, blocklist } = await loadPipelineInputs(cfg);
    return processPending(
      db,
      {
        connectorFor: (account) => connectorForAccount(cfg, db, account),
        // The routine refresh is the one trickle path: a handful of messages
        // between syncs, on the cheap local model that learns from the
        // backlog model's verdicts (spec 7a).
        sorter: createSorter(cfg, db, "trickle"),
        drafter: createDrafter(cfg, db),
        backfillDays: 7,
        blocklist,
        criteria,
        voice,
      },
      fetched,
    );
  })().finally(() => {
    processing = null;
    const next = waiting;
    waiting = null;
    if (next) void processMail(next);
  });
  return processing;
}

/** Both chat providers, one after the other: the refresh button and the clock's safety net. */
export async function syncAllChats(): Promise<number> {
  let stored = 0;
  for (const provider of ["imessage", "whatsapp"] as const) stored += (await syncChats(provider)).stored;
  return stored;
}

async function runAll(): Promise<PipelineResult> {
  // Chats too (2026-09-15: the newest iMessage texts sat unsynced): since the
  // mail clock split the fetch out, the refresh button had quietly stopped
  // reading Messages and WhatsApp at all.
  await syncAllChats();
  const { fetched } = await fetchMail();
  const result = await processMail(fetched);
  revalidatePath("/drafts");
  revalidatePath("/inboxes");
  return result;
}
