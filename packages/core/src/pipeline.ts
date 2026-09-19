import { eq } from "drizzle-orm";
import type { Blocklist } from "./blocklist";
import { loadBlocklist } from "./blocklist";
import { AccountAuthError, type MailConnector, type SyncResult } from "./connectors/types";
import { ensureConfigFiles, readTextFile, type Config } from "./config";
import { type Db } from "./db/client";
import { accounts, drafts, mailCredentials, oauthTokens, type AccountRow } from "./db/schema";
import { retireAnsweredDrafts } from "./queue/drafts";
import { draftPending } from "./draft/run";
import type { Drafter } from "./draft/types";
import { autoSortMinSentAt, sortPending } from "./sort/run";
import type { Sorter } from "./sort/types";

export interface AccountResult {
  email: string;
  sync?: SyncResult;
  syncError?: string;
  labeled?: number;
  labelFailed?: number;
  labelError?: string;
}

export interface PipelineResult {
  accounts: AccountResult[];
  sorted: number;
  sortFailed: number;
  drafted: number;
  draftFailed: number;
  pending: number;
}

export interface PipelineDeps {
  connectorFor: (account: AccountRow) => MailConnector;
  sorter: Sorter;
  drafter: Drafter | null;
  backfillDays: number;
  blocklist: Blocklist;
  criteria: string;
  voice: string;
}

/**
 * Sync every account (or just `accountIds`, when given), sort new mail,
 * apply labels, and (if a drafter is given) draft replies. Shared by the CLI
 * `run` command and the web sync actions so both drive the exact same
 * pipeline, for every connected provider.
 */
export async function runPipeline(db: Db, deps: PipelineDeps, accountIds?: string[]): Promise<PipelineResult> {
  const fetched = await fetchAccounts(db, deps, accountIds);
  return processPending(db, deps, fetched);
}

/** One account's fetch, carried into `processPending` so its labels go through the same connector. */
export interface FetchedAccount {
  account: AccountRow;
  connector: MailConnector | null;
  result: AccountResult;
}

/** How many inboxes are fetched at once. Four is a throughput win without looking like a scraper to any one provider. */
const FETCH_CONCURRENCY = 4;

/**
 * The fetch half of the pipeline (2026-09-14): every account's new mail
 * stored, and nothing else. Split out so the server's mail clock can bring
 * mail in every two minutes without waiting on a sort that takes a minute
 * and a half.
 */
export async function fetchAccounts(db: Db, deps: Pick<PipelineDeps, "connectorFor" | "backfillDays" | "blocklist">, accountIds?: string[]): Promise<FetchedAccount[]> {
  const accountRows = db.select().from(accounts).all().filter((a) => !accountIds || accountIds.includes(a.id));
  const entries: FetchedAccount[] = accountRows.map((account) => ({ account, connector: null as MailConnector | null, result: { email: account.email } as AccountResult }));

  // connectorFor can throw synchronously (e.g. missing credentials or an
  // unconnected account), so build it inside the per-account try/catch:
  // one bad account must never abort sync for the others.
  const one = async (entry: FetchedAccount): Promise<void> => {
    try {
      entry.connector = deps.connectorFor(entry.account);
      entry.result.sync = await entry.connector.sync(db, entry.account, {
        backfillDays: deps.backfillDays,
        blocklist: deps.blocklist,
      });
      db.update(accounts).set({ status: "ok", lastError: null }).where(eq(accounts.id, entry.account.id)).run();
    } catch (err) {
      entry.result.syncError = (err as Error).message;
      if (err instanceof AccountAuthError) {
        db.update(accounts).set({ status: "needs_signin", lastError: err.message }).where(eq(accounts.id, entry.account.id)).run();
      }
    }
  };

  // Several accounts at once (operator, 2026-09-18: "the sync takes
  // forever"). This was a loop with an await in it, so seven inboxes cost
  // the sum of seven, not the slowest of seven, and almost all of that time
  // was spent waiting on somebody else's server.
  //
  // Bounded rather than all at once: each account holds a connection and a
  // parse buffer, and a provider that sees every mailbox open at the same
  // instant is a provider that starts refusing. Each account still writes to
  // the one SQLite file, which is safe because better-sqlite3 is synchronous
  // and only the waiting overlaps, never two writes.
  //
  // Accounts are independent by construction: each has its own watermark and
  // its own row, and the shared `tail` above still keeps a second sync of the
  // same account from starting while this one runs.
  const queue = [...entries];
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) await one(entry);
  });
  await Promise.all(workers);

  return entries;
}

/**
 * The process half (2026-09-14): sort what is unsorted, apply labels for the
 * accounts just fetched, retire answered drafts and draft what needs one.
 */
export async function processPending(db: Db, deps: PipelineDeps, entries: FetchedAccount[]): Promise<PipelineResult> {
  // Only mail from the last 30 days is sorted automatically (spec 5).
  const sortResult = await sortPending(db, deps.sorter, deps.criteria, { minSentAt: autoSortMinSentAt() });

  for (const entry of entries) {
    try {
      const connector = entry.connector ?? deps.connectorFor(entry.account);
      entry.connector = connector;
      const labeled = await connector.applyLabels(db, entry.account.id);
      entry.result.labeled = labeled.labeled;
      entry.result.labelFailed = labeled.failed;
    } catch (err) {
      entry.result.labelError = (err as Error).message;
    }
  }

  // A reply the operator sent from the mailbox itself retires the draft that
  // was waiting for it, before the drafter spends anything more.
  retireAnsweredDrafts(db);
  let draftResult = { drafted: 0, failed: 0 };
  if (deps.drafter) {
    draftResult = await draftPending(db, deps.drafter, deps.voice);
  }

  const pending = db.select().from(drafts).where(eq(drafts.status, "pending")).all().length;

  return {
    accounts: entries.map((e) => e.result),
    sorted: sortResult.sorted,
    sortFailed: sortResult.failed,
    drafted: draftResult.drafted,
    draftFailed: draftResult.failed,
    pending,
  };
}

/**
 * Runs the full pipeline scoped to one account's sync and labels. Sort and
 * draft still run over every pending message across all accounts — they're
 * global steps and cheap enough to rerun on every connect.
 */
export async function runPipelineForAccount(db: Db, deps: PipelineDeps, accountId: string): Promise<PipelineResult> {
  return runPipeline(db, deps, [accountId]);
}

/** Disconnects an account: drops every stored credential and marks it disconnected. Messages, drafts, and everything else stay. */
export function disconnectAccount(db: Db, accountId: string): void {
  db.delete(oauthTokens).where(eq(oauthTokens.accountId, accountId)).run();
  db.delete(mailCredentials).where(eq(mailCredentials.accountId, accountId)).run();
  db.update(accounts).set({ status: "disconnected", lastError: null }).where(eq(accounts.id, accountId)).run();
}

/** Shared config loading for both the CLI and the web pipeline action. */
export async function loadPipelineInputs(cfg: Config): Promise<{ criteria: string; voice: string; blocklist: Blocklist }> {
  await ensureConfigFiles(cfg);
  const [criteria, voice, blocklist] = await Promise.all([
    readTextFile(cfg.criteriaPath),
    readTextFile(cfg.voicePath),
    loadBlocklist(cfg.blocklistPath),
  ]);
  return { criteria, voice, blocklist };
}
