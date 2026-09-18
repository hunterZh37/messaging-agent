import { and, eq } from "drizzle-orm";
import { isBlocked } from "../blocklist";
import { noteBackfilledSince } from "../connectors/backfill";
import { storeNormalizedMessage } from "../connectors/store";
import type { BackfillOptions, SyncOptions, SyncResult } from "../connectors/types";
import type { Config } from "../config";
import { now, type Db } from "../db/client";
import { messages, type AccountRow, watermarks } from "../db/schema";
import { normalizeGraphMessage } from "./normalize";
import type { OutlookClient, OutlookFolder } from "./types";

/** One delta link per mailbox (spec 10a): Inbox, Sent, Deleted items, Junk. */
type OutlookWatermark = Record<OutlookFolder, string | null>;

/** The order a sync walks the mailboxes. */
const FOLDERS: OutlookFolder[] = ["inbox", "sent", "trash", "junk"];

const EMPTY: OutlookWatermark = { inbox: null, sent: null, trash: null, junk: null };

function parseWatermark(historyId: string | undefined): OutlookWatermark {
  if (!historyId) return { ...EMPTY };
  try {
    const parsed = JSON.parse(historyId) as Partial<OutlookWatermark>;
    const out = { ...EMPTY };
    for (const folder of FOLDERS) out[folder] = parsed[folder] ?? null;
    return out;
  } catch {
    return { ...EMPTY };
  }
}

function sinceIsoFor(backfillDays: number, at: number): string {
  return new Date(at - backfillDays * 86_400_000).toISOString();
}

interface FolderSyncResult {
  deltaLink: string;
  fetched: number;
  stored: number;
  blocked: number;
  failed: number;
}

async function syncFolder(
  db: Db,
  cfg: Config,
  client: OutlookClient,
  account: AccountRow,
  folder: OutlookFolder,
  deltaLink: string | null,
  opts: SyncOptions,
): Promise<FolderSyncResult> {
  const clock = opts.clock ?? now;
  const since = () => (opts.backfillTo === null ? null : opts.backfillTo !== undefined ? new Date(opts.backfillTo).toISOString() : sinceIsoFor(opts.backfillDays, clock()));
  let result = await client.delta(folder, deltaLink, deltaLink ? null : since());
  if (result === "expired") {
    result = await client.delta(folder, null, since());
    if (result === "expired") throw new Error(`outlook sync: delta for ${folder} expired twice in a row`);
  }

  let stored = 0;
  let blocked = 0;
  let failed = 0;
  for (const raw of result.messages) {
    try {
      const n = normalizeGraphMessage(raw, folder);
      if (isBlocked(opts.blocklist, n.fromAddress)) {
        blocked++;
        continue;
      }
      if (await storeNormalizedMessage(db, cfg, account, n, clock())) stored++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`outlook sync: failed to normalize a ${folder} message: ${message}`);
    }
  }
  // What left the folder on the server leaves it here: the local row moves
  // to Deleted items, where a message deleted in Outlook belongs. A move to
  // another synced folder arrives there as its own message.
  for (const id of result.removed ?? []) {
    db.update(messages)
      .set({ folder: "trash" })
      .where(and(eq(messages.id, `${account.id}:${id}`), eq(messages.folder, folder)))
      .run();
  }
  return { deltaLink: result.deltaLink, fetched: result.messages.length, stored, blocked, failed };
}

function setWatermark(db: Db, accountId: string, historyId: string, at: number): void {
  db.insert(watermarks)
    .values({ accountId, historyId, lastSyncAt: at })
    .onConflictDoUpdate({ target: watermarks.accountId, set: { historyId, lastSyncAt: at } })
    .run();
}

export async function syncOutlookAccount(db: Db, cfg: Config, client: OutlookClient, account: AccountRow, opts: SyncOptions): Promise<SyncResult> {
  const wm = db.select().from(watermarks).where(eq(watermarks.accountId, account.id)).get();
  const parsed = parseWatermark(wm?.historyId);
  const mode: SyncResult["mode"] = FOLDERS.every((f) => parsed[f] === null) ? "backfill" : "history";

  const next = { ...EMPTY };
  let fetched = 0;
  let stored = 0;
  let blocked = 0;
  let failed = 0;
  for (const folder of FOLDERS) {
    const r = await syncFolder(db, cfg, client, account, folder, parsed[folder], opts);
    next[folder] = r.deltaLink;
    fetched += r.fetched;
    stored += r.stored;
    blocked += r.blocked;
    failed += r.failed;
  }

  const at = (opts.clock ?? now)();
  setWatermark(db, account.id, JSON.stringify(next), at);
  // How far back this account now reaches, for the inbox window chips.
  noteBackfilledSince(db, account, opts.backfillTo === null ? null : (opts.backfillTo ?? at - opts.backfillDays * 86_400_000));

  return { mode, fetched, stored, blocked, failed };
}

/**
 * Reaches back past what delta has handed over, down to `opts.to` (null for
 * the whole mailbox), by listing the folder by date. The delta links are left
 * exactly as they are: new mail stays the sync path's job.
 */
export async function backfillOutlookAccount(
  db: Db,
  cfg: Config,
  client: OutlookClient,
  account: AccountRow,
  opts: BackfillOptions,
): Promise<SyncResult & { mode: "backfill" }> {
  const clock = opts.clock ?? now;
  const sinceIso = opts.to === null ? null : new Date(opts.to).toISOString();

  let fetched = 0;
  let stored = 0;
  let blocked = 0;
  let failed = 0;

  for (const folder of FOLDERS) {
    const raws = await client.listMessages(folder, sinceIso);
    fetched += raws.length;
    for (const raw of raws) {
      try {
        const n = normalizeGraphMessage(raw, folder);
        if (isBlocked(opts.blocklist, n.fromAddress)) {
          blocked++;
          continue;
        }
        if (await storeNormalizedMessage(db, cfg, account, n, clock())) stored++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`outlook backfill: failed to normalize a ${folder} message: ${message}`);
      }
    }
  }

  noteBackfilledSince(db, account, opts.to);
  return { mode: "backfill", fetched, stored, blocked, failed };
}
