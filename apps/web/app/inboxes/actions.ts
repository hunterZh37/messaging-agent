"use server";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  AccountAuthError,
  afterBacklogRun,
  autoSortMinSentAt,
  connectorForAccount,
  createDrafter,
  createSorter,
  detectProvider,
  disconnectAccount,
  draftPending,
  loadPipelineInputs,
  runPipeline,
  saveImapAccount,
  schema,
  sortPending,
  testImapLogin,
  type ImapSettings,
  type PipelineResult,
  type SyncResult, openChatStorage, connectWhatsappAccount } from "@messaging-agent/core";
import { connectImessageAccount, openChatDb, restampOperator, saveAliases } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { ACCOUNT_COOKIE } from "@/lib/selection";
import { syncAll } from "@/lib/syncAll";

type StepError = { error: string };

function revalidateSurfaces(): void {
  revalidatePath("/drafts");
  revalidatePath("/inboxes");
}

/** Syncs every inbox: kept for callers that hold an action, the app's own refresh goes through /api/sync (lib/syncAll.ts). */
export async function syncAllAction(): Promise<PipelineResult | StepError> {
  try {
    return await syncAll();
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function requireAccount(db: ReturnType<typeof core>["db"], accountId: string) {
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!account) throw new Error("Inbox not found.");
  return account;
}

/** Step 1 of Add inbox: works out how this address connects. No credentials involved. */
export async function detectAction(address: string): Promise<{ provider: "gmail" | "outlook" | "generic"; settings?: ImapSettings } | StepError> {
  try {
    // An address that is already an inbox here is said so, rather than
    // walked through an app password again (stress loop, 2026-09-11).
    const { db } = core();
    const wanted = address.trim().toLowerCase();
    const known = db.select({ email: schema.accounts.email }).from(schema.accounts).all().find((a) => a.email.toLowerCase() === wanted);
    if (known) return { error: `${known.email} is already connected.` };
    return await detectProvider(address.trim());
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Step 2 of Add inbox: proves the password works, then stores it. The password
 * only ever travels inward — it is never logged and never returned.
 */
export async function connectImapAction(p: { email: string; settings: ImapSettings; password: string }): Promise<{ accountId: string } | StepError> {
  const email = p.email.trim().toLowerCase();
  if (!email.includes("@")) return { error: "Enter a full email address." };
  if (!p.password) return { error: "Enter the password for this inbox." };
  if (!p.settings.imapHost || !p.settings.smtpHost) return { error: "Enter the IMAP and SMTP host names." };
  if (!Number.isInteger(p.settings.imapPort) || !Number.isInteger(p.settings.smtpPort)) {
    return { error: "Ports must be whole numbers." };
  }

  const creds = { username: email, password: p.password };
  try {
    await testImapLogin(p.settings, creds);
  } catch (err) {
    return { error: (err as Error).message };
  }

  try {
    const { db } = core();
    const account = saveImapAccount(db, { email, settings: p.settings, ...creds });
    revalidateSurfaces();
    return { accountId: account.id };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * One inbox pulled on its own. Progress step 1 of connecting (or reconnecting)
 * one, and the pull that follows a send: the reply only exists at the provider
 * until this runs, so the thread goes on looking unanswered (spec 8,
 * 2026-09-10).
 */
export async function syncStep(accountId: string): Promise<SyncResult | StepError> {
  const { cfg, db } = core();
  try {
    const account = requireAccount(db, accountId);
    const { blocklist } = await loadPipelineInputs(cfg);
    const connector = connectorForAccount(cfg, db, account);
    const result = await connector.sync(db, account, { backfillDays: 7, blocklist });
    db.update(schema.accounts).set({ status: "ok", lastError: null }).where(eq(schema.accounts.id, accountId)).run();
    return result;
  } catch (err) {
    if (err instanceof AccountAuthError) {
      db.update(schema.accounts).set({ status: "needs_signin", lastError: err.message }).where(eq(schema.accounts.id, accountId)).run();
    }
    return { error: (err as Error).message };
  }
}

/**
 * Progress step 2 of connecting an inbox: sort every unsorted message from
 * the last 30 days, across all inboxes. This is the first sync of a newly
 * connected mailbox, so it is a backlog job and the backlog model judges it
 * (spec 7a).
 */
export async function sortStep(): Promise<{ sorted: number; failed: number } | StepError> {
  const { cfg, db } = core();
  try {
    const { criteria } = await loadPipelineInputs(cfg);
    const result = await sortPending(db, createSorter(cfg, db, "backlog"), criteria, { minSentAt: autoSortMinSentAt() });
    // The backlog model has just judged a pile of mail, so what the trickle
    // model reads is out of date. Not awaited: the operator is waiting on the
    // sort, not on the rewrite (spec 7a).
    void afterBacklogRun(db, cfg);
    return result;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Progress step 3: apply this inbox's labels (IMAP) or categories (Outlook) for its newly sorted messages. */
export async function labelStep(accountId: string): Promise<{ labeled: number; failed: number } | StepError> {
  const { cfg, db } = core();
  try {
    const account = requireAccount(db, accountId);
    const connector = connectorForAccount(cfg, db, account);
    return await connector.applyLabels(db, accountId);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Progress step 4: draft replies for every eligible thread across all inboxes. */
export async function draftStep(): Promise<{ drafted: number; failed: number } | StepError> {
  const { cfg, db } = core();
  try {
    const { voice } = await loadPipelineInputs(cfg);
    return await draftPending(db, createDrafter(cfg, db), voice);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Drops an inbox's stored credentials and marks it disconnected. Stored mail and drafts stay. */
export async function disconnectAction(accountId: string): Promise<{ ok: true } | StepError> {
  try {
    const { db } = core();
    disconnectAccount(db, accountId);
    // The switcher would fall back to All anyway, but leaving the id in the
    // cookie means a later reconnect silently re-selects an inbox nobody chose.
    const jar = await cookies();
    if (jar.get(ACCOUNT_COOKIE)?.value === accountId) jar.delete(ACCOUNT_COOKIE);
    revalidateSurfaces();
    return { ok: true };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * "Also you": the operator's other addresses. Saving the list re-decides who
 * wrote every stored message, because the answer has just changed for some of
 * them — mail they sent from another address stops being somebody else's,
 * moves to their side of the thread, and gives up a verdict that was never
 * about anything (spec 10a).
 */
export async function saveAliasesAction(addresses: string[]): Promise<{ restamped: number } | { error: string }> {
  try {
    const { db } = core();
    saveAliases(db, addresses);
    const { messages } = restampOperator(db);
    revalidatePath("/inboxes");
    revalidatePath("/inbox");
    revalidatePath("/drafts");
    return { restamped: messages };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Connects Messages on this Mac (operator, 2026-09-11): opens chat.db
 * read-only to prove it can be read (Full Disk Access), makes the one
 * Messages account, and runs a sync so the 30 days of texts are here
 * before the page comes back.
 */
/** "Connect WhatsApp" (spec 10g, 2026-09-11): the first 30 days of chats, and nothing else, like Messages. */
export async function connectWhatsappAction(): Promise<{ accountId: string } | StepError> {
  try {
    const { cfg, db } = core();
    let source;
    try {
      source = openChatStorage(cfg.whatsappDbPath);
    } catch (err) {
      return { error: `WhatsApp on this Mac cannot be read: ${(err as Error).message}. Is WhatsApp installed and signed in, and does the app have Full Disk Access?` };
    }
    try {
      if (!source.own()) return { error: "WhatsApp on this Mac has no chats yet." };
      const account = connectWhatsappAccount(db, source);
      const { blocklist } = await loadPipelineInputs(cfg);
      // Thirty days of chats and nothing older (operator, 2026-09-14:
      // "eliminate backfill"): history only ever filled the triage rows.
      await connectorForAccount(cfg, db, account).sync(db, account, { backfillDays: 30, blocklist });
      revalidatePath("/inboxes");
      revalidatePath("/messages");
      return { accountId: account.id };
    } finally {
      source.close();
    }
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function connectImessageAction(): Promise<{ accountId: string } | StepError> {
  try {
    const { cfg, db } = core();
    let source;
    try {
      source = openChatDb(cfg.chatDbPath);
    } catch (err) {
      return { error: `Messages on this Mac cannot be read: ${(err as Error).message}. Give the app Full Disk Access in System Settings, then try again.` };
    }
    try {
      if (!source.ownHandle()) return { error: "Messages on this Mac has no account signed in." };
      const account = connectImessageAccount(db, source);
      // The first 30 days of texts, and nothing else: sorting and the rest of
      // the pipeline run on the next routine sync, off this page's action
      // (a full run held the page for twenty minutes on first connect).
      const { blocklist } = await loadPipelineInputs(cfg);
      await connectorForAccount(cfg, db, account).sync(db, account, { backfillDays: 30, blocklist });
      revalidatePath("/inboxes");
      revalidatePath("/messages");
      return { accountId: account.id };
    } finally {
      source.close();
    }
  } catch (err) {
    return { error: (err as Error).message };
  }
}
