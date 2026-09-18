import { and, eq, gt, like } from "drizzle-orm";
import { isBlocked } from "../blocklist";
import { noteBackfilledSince } from "../connectors/backfill";
import { storeNormalizedMessage } from "../connectors/store";
import { AccountAuthError, type BackfillOptions, type SyncOptions, type SyncResult } from "../connectors/types";
import type { Config } from "../config";
import { now, type Db } from "../db/client";
import { MAIL_FOLDERS, messages, watermarks, type AccountRow, type MailFolder } from "../db/schema";
import { markMessagesReadElsewhere } from "../queue/inbox";
import { normalizeImapMessage } from "./normalize";
import type { ImapClient, ImapMessage } from "./types";

/** The four mailboxes a sync walks (spec 10a). Also the watermark's keys. */
type FolderKey = MailFolder;

interface FolderWatermark {
  uidValidity: number;
  lastUid: number;
  /** The oldest uid we hold for this folder: the floor a backfill reaches below. Absent on watermarks written before backfill existed. */
  lowestUid?: number;
}

type ImapWatermark = Partial<Record<FolderKey, FolderWatermark>>;

function parseWatermark(historyId: string | undefined): ImapWatermark {
  if (!historyId) return {};
  try {
    const parsed = JSON.parse(historyId) as ImapWatermark;
    const out: ImapWatermark = {};
    for (const key of MAIL_FOLDERS) {
      const v = parsed?.[key];
      if (v && Number.isFinite(v.uidValidity) && Number.isFinite(v.lastUid)) {
        out[key] = {
          uidValidity: v.uidValidity,
          lastUid: v.lastUid,
          ...(Number.isFinite(v.lowestUid) ? { lowestUid: v.lowestUid! } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** True for the shapes ImapFlow throws when the server rejects the password. */
function isAuthFailure(err: unknown): boolean {
  if ((err as { authenticationFailed?: boolean }).authenticationFailed) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|Authentication failed/i.test(message);
}

/**
 * The mailboxes this server actually has, in the order a sync walks them.
 * Inbox is always there; Sent, Trash and Junk depend on what the server
 * reports as special-use, and a server with none of them is simply an inbox.
 */
async function folderTargets(imap: ImapClient): Promise<{ key: FolderKey; path: string }[]> {
  const paths = await imap.folders();
  const targets: { key: FolderKey; path: string }[] = [{ key: "inbox", path: paths.inbox }];
  for (const key of ["sent", "trash", "junk"] as const) {
    const path = paths[key];
    if (path) targets.push({ key, path });
  }
  return targets;
}

interface FolderResult extends FolderWatermark {
  backfilled: boolean;
  fetched: number;
  stored: number;
  blocked: number;
  failed: number;
}

async function storeAll(
  db: Db,
  cfg: Config,
  account: AccountRow,
  folder: string,
  folderKey: FolderKey,
  msgs: ImapMessage[],
  opts: { blocklist: SyncOptions["blocklist"]; clock?: () => number },
): Promise<{ stored: number; blocked: number; failed: number; highestUid: number; lowestUid: number | null }> {
  const clock = opts.clock ?? now;
  let stored = 0;
  let blocked = 0;
  let failed = 0;
  let highestUid = 0;
  let lowestUid: number | null = null;
  for (const m of msgs) {
    // The watermark advances past a message we could not parse, so one bad
    // message never wedges the folder.
    if (m.uid > highestUid) highestUid = m.uid;
    if (lowestUid === null || m.uid < lowestUid) lowestUid = m.uid;
    try {
      const n = await normalizeImapMessage(m, folder, clock, folderKey);
      if (isBlocked(opts.blocklist, n.fromAddress)) {
        blocked++;
        continue;
      }
      if (await storeNormalizedMessage(db, cfg, account, n, clock())) stored++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`imap sync: failed to store ${folder}:${m.uid}: ${message}`);
    }
  }
  return { stored, blocked, failed, highestUid, lowestUid };
}

async function syncFolder(
  db: Db,
  cfg: Config,
  imap: ImapClient,
  account: AccountRow,
  folder: string,
  folderKey: FolderKey,
  prev: FolderWatermark | undefined,
  opts: SyncOptions,
): Promise<FolderResult> {
  const clock = opts.clock ?? now;
  const sinceDate = () => (opts.backfillTo === null ? null : new Date(opts.backfillTo ?? clock() - opts.backfillDays * 86_400_000));

  let backfilled = prev === undefined;
  let result = backfilled
    ? await imap.fetchNew(folder, null, sinceDate())
    : await imap.fetchNew(folder, prev!.lastUid, null);

  // The mailbox was rebuilt: the uids we asked about mean something else now,
  // so throw that answer away and take the whole backfill window instead.
  if (prev !== undefined && result.uidValidity !== prev.uidValidity) {
    backfilled = true;
    result = await imap.fetchNew(folder, null, sinceDate());
  }

  // Guard the IMAP quirk where `n:*` yields the newest message even when
  // nothing is newer than n.
  const floor = backfilled ? 0 : prev!.lastUid;
  const fresh = result.messages.filter((m) => m.uid > floor);

  const { stored, blocked, failed, highestUid, lowestUid } = await storeAll(db, cfg, account, folder, folderKey, fresh, opts);

  // A first sync (or a rebuilt mailbox) establishes the floor a later
  // backfill reaches below; an incremental one only ever adds newer mail.
  const oldestUid = backfilled ? lowestUid : (prev!.lowestUid ?? null);

  return {
    backfilled,
    fetched: fresh.length,
    stored,
    blocked,
    failed,
    uidValidity: result.uidValidity,
    lastUid: Math.max(highestUid, backfilled ? 0 : prev!.lastUid),
    ...(oldestUid === null ? {} : { lowestUid: oldestUid }),
  };
}

/** How far back a sync asks the server what the operator has read since. */
const READ_REFRESH_MS = 7 * 86_400_000;

/**
 * Mail read on the phone since it was stored (2026-09-14): the \\Seen flags
 * of the last week's inbox mail are read again on every sync, and each one
 * now set opens its thread up to that message. Flags only, no bodies, so it
 * costs one FETCH; a server that cannot answer costs nothing more than a
 * line in the log, because the mail itself has already been synced.
 */
async function refreshReadFlags(db: Db, imap: ImapClient, account: AccountRow, folder: string, clock: () => number): Promise<number> {
  const prefix = `${folder}:`;
  const rows = db
    .select({ id: messages.id, providerMessageId: messages.providerMessageId })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, account.id),
        eq(messages.folder, "inbox"),
        eq(messages.isFromOperator, false),
        gt(messages.sentAt, clock() - READ_REFRESH_MS),
        like(messages.providerMessageId, `${prefix}%`),
      ),
    )
    .all();
  const byUid = new Map<number, string>();
  for (const r of rows) {
    const uid = Number(r.providerMessageId.slice(prefix.length));
    if (Number.isFinite(uid)) byUid.set(uid, r.id);
  }
  if (byUid.size === 0) return 0;
  try {
    const seen = await imap.fetchFlags(folder, [...byUid.keys()]);
    const read = [...seen].filter(([, isSeen]) => isSeen).map(([uid]) => byUid.get(uid)!);
    return markMessagesReadElsewhere(db, read);
  } catch (err) {
    console.error(`imap sync: could not read flags for ${account.email}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Incremental UID sync of Inbox, Sent, Trash and Junk (spec 10a). Fetches
 * with BODY.PEEK, so nothing is marked read; the only write this path makes
 * is to our own database.
 */
export async function syncImapAccount(db: Db, cfg: Config, imap: ImapClient, account: AccountRow, opts: SyncOptions): Promise<SyncResult> {
  const clock = opts.clock ?? now;
  const wm = parseWatermark(db.select().from(watermarks).where(eq(watermarks.accountId, account.id)).get()?.historyId);

  try {
    await imap.connect();
    try {
      const targets = await folderTargets(imap);

      const next: ImapWatermark = {};
      let mode: SyncResult["mode"] = "history";
      let fetched = 0;
      let stored = 0;
      let blocked = 0;
      let failed = 0;

      for (const t of targets) {
        const r = await syncFolder(db, cfg, imap, account, t.path, t.key, wm[t.key], opts);
        if (r.backfilled) mode = "backfill";
        fetched += r.fetched;
        stored += r.stored;
        blocked += r.blocked;
        failed += r.failed;
        next[t.key] = { uidValidity: r.uidValidity, lastUid: r.lastUid, ...(r.lowestUid === undefined ? {} : { lowestUid: r.lowestUid }) };
        if (t.key === "inbox") await refreshReadFlags(db, imap, account, t.path, clock);
      }

      const historyId = JSON.stringify(next);
      const at = clock();
      db.insert(watermarks)
        .values({ accountId: account.id, historyId, lastSyncAt: at })
        .onConflictDoUpdate({ target: watermarks.accountId, set: { historyId, lastSyncAt: at } })
        .run();

      // How far back this account now reaches, for the inbox window chips.
      noteBackfilledSince(db, account, opts.backfillTo === null ? null : (opts.backfillTo ?? at - opts.backfillDays * 86_400_000));

      return { mode, fetched, stored, blocked, failed };
    } finally {
      await imap.close();
    }
  } catch (err) {
    if (err instanceof AccountAuthError) throw err;
    if (isAuthFailure(err)) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AccountAuthError(account.id, `IMAP login failed for ${account.email}: ${message}`);
    }
    throw err;
  }
}

/** The oldest uid we already hold for a folder, read back off the stored ids. Only needed for watermarks written before `lowestUid` existed. */
function storedLowestUid(db: Db, accountId: string, folder: string): number | null {
  const prefix = `${folder}:`;
  let lowest: number | null = null;
  for (const row of db.select({ id: messages.providerMessageId }).from(messages).where(eq(messages.accountId, accountId)).all()) {
    if (!row.id.startsWith(prefix)) continue;
    const uid = Number(row.id.slice(prefix.length));
    if (!Number.isFinite(uid)) continue;
    if (lowest === null || uid < lowest) lowest = uid;
  }
  return lowest;
}

interface BackfillFolderResult {
  fetched: number;
  stored: number;
  blocked: number;
  failed: number;
  /** The folder's new floor, or undefined when it is unchanged/unknown. */
  lowestUid: number | undefined;
}

async function backfillFolder(
  db: Db,
  cfg: Config,
  imap: ImapClient,
  account: AccountRow,
  folder: string,
  folderKey: FolderKey,
  prev: FolderWatermark | undefined,
  opts: BackfillOptions,
): Promise<BackfillFolderResult> {
  const floor = prev?.lowestUid ?? storedLowestUid(db, account.id, folder);
  const empty = { fetched: 0, stored: 0, blocked: 0, failed: 0, lowestUid: floor ?? undefined };
  // uid 1 is the oldest there can be: this folder is already whole.
  if (floor !== null && floor <= 1) return empty;

  const result = await imap.fetchOlder(folder, floor, opts.to === null ? null : new Date(opts.to));
  const older = floor === null ? result.messages : result.messages.filter((m) => m.uid < floor);
  if (older.length === 0) return empty;

  const { stored, blocked, failed, lowestUid } = await storeAll(db, cfg, account, folder, folderKey, older, opts);
  const next = lowestUid === null ? floor : floor === null ? lowestUid : Math.min(floor, lowestUid);
  return { fetched: older.length, stored, blocked, failed, lowestUid: next ?? undefined };
}

/**
 * Reaches back past the oldest mail this account holds, down to `opts.to`
 * (null for the whole mailbox). The incremental watermark's `lastUid` never
 * moves: new mail stays the sync path's job, and running this twice to the
 * same depth fetches nothing the second time.
 */
export async function backfillImapAccount(
  db: Db,
  cfg: Config,
  imap: ImapClient,
  account: AccountRow,
  opts: BackfillOptions,
): Promise<SyncResult & { mode: "backfill" }> {
  const clock = opts.clock ?? now;
  const row = db.select().from(watermarks).where(eq(watermarks.accountId, account.id)).get();
  const wm = parseWatermark(row?.historyId);

  try {
    await imap.connect();
    try {
      const targets = await folderTargets(imap);

      const next: ImapWatermark = { ...wm };
      let fetched = 0;
      let stored = 0;
      let blocked = 0;
      let failed = 0;

      for (const t of targets) {
        const r = await backfillFolder(db, cfg, imap, account, t.path, t.key, wm[t.key], opts);
        fetched += r.fetched;
        stored += r.stored;
        blocked += r.blocked;
        failed += r.failed;
        // A folder with no watermark has never been synced; leave it for the
        // sync path rather than inventing a `lastUid` that skips new mail.
        const prev = wm[t.key];
        if (prev) next[t.key] = { ...prev, ...(r.lowestUid === undefined ? {} : { lowestUid: r.lowestUid }) };
      }

      if (row) {
        db.update(watermarks).set({ historyId: JSON.stringify(next) }).where(eq(watermarks.accountId, account.id)).run();
      }
      noteBackfilledSince(db, account, opts.to);

      return { mode: "backfill", fetched, stored, blocked, failed };
    } finally {
      await imap.close();
    }
  } catch (err) {
    if (err instanceof AccountAuthError) throw err;
    if (isAuthFailure(err)) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AccountAuthError(account.id, `IMAP login failed for ${account.email}: ${message}`);
    }
    throw err;
  }
}
