"use server";

import { revalidatePath } from "next/cache";
import { wholeInbox } from "@/lib/opened";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  afterBacklogRun,
  autoSortMinSentAt,
  connectorForAccount,
  sendText,
  countUnsortedBefore,
  createDrafter,
  createSorter,
  createProject,
  disposableThreadIds,
  draftForThread,
  fileThread,
  listProjects,
  loadPipelineInputs,
  markThreadOpened,
  alexConnected,
  freeTimes,
  retryAlexItem,
  sendToAlex,
  markThreadsOpened,
  proposeProjects,
  providerForRole,
  restoreThreadOpens,
  restoreThreads,
  unhideThreads,
  trashThreads,
  unopenedThreadIds,
  type ThreadOpenBefore,
  recordAction,
  resortImportant,
  resortWindow,
  saveCategories,
  saveProjectsWithGroups,
  listProjectGroups,
  schema,
  type ProjectRow,
  type AlexItem,
  type AlexItemRow,
  type AlexSlot,
  setThreadWaiting, hideThreads, keepThread, hiddenThreadIds, correctThread, sendersOf, setSenderRule, clearSenderRule, type KeepDestination, type Wants } from "@messaging-agent/core";
import { core } from "@/lib/core";

type StepError = { error: string };

/** Thread view's "Draft with Celeste": drafts for this thread on demand, and the reply card appears under the mail. */
export async function draftReplyAction(threadId: string, opts: { force?: boolean } = {}): Promise<StepError | { declined: string } | void> {
  const { cfg, db } = core();
  let result: Awaited<ReturnType<typeof draftForThread>>;
  try {
    const { voice } = await loadPipelineInputs(cfg);
    result = await draftForThread(db, createDrafter(cfg, db, { ref: threadId }), voice, threadId, { force: opts.force ?? false });
  } catch (err) {
    return { error: (err as Error).message };
  }
  if ("error" in result) return result;
  // Nothing to answer: said on the page, with the way to draft anyway.
  if ("declined" in result) return result;
  // The draft is read where the mail is now (spec 10a, 2026-09-10): it comes
  // back as the reply card under this thread, so the operator stays on the
  // page they pressed the button on rather than being carried to the queue.
  revalidatePath(`/inbox/${threadId}`);
  revalidatePath("/drafts");
}

/**
 * A text the operator typed into a chat (2026-09-11). It goes at once: one
 * line to one person, and Messages has no unsend either way.
 */
export async function sendTextAction(threadId: string, text: string): Promise<StepError | void> {
  const { cfg, db } = core();
  try {
    const thread = db.select().from(schema.threads).where(eq(schema.threads.id, threadId)).get();
    if (!thread) return { error: "Chat not found." };
    const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, thread.accountId)).get();
    if (!account) return { error: "Chat not found." };
    const connector = connectorForAccount(cfg, db, account);
    await sendText(db, connector.sender, { threadId, text });
    // The sent text is in the app's store already (the send was confirmed
    // by reading it there), so one sync brings the bubble in before the
    // page is read again (operator, 2026-09-11: "does not get synced").
    try {
      const { blocklist } = await loadPipelineInputs(cfg);
      await connector.sync(db, account, { backfillDays: 30, blocklist });
    } catch (err) {
      console.error(`sync after text to ${threadId}:`, (err as Error).message);
    }
  } catch (err) {
    return { error: (err as Error).message };
  }
  revalidatePath(`/inbox/${threadId}`);
  revalidatePath("/messages");
}

/** Thread view's "Mark handled": records the action and removes the row from the Important filter. */
export async function markHandledAction(messageId: string): Promise<{ ok: true } | StepError> {
  try {
    const { db } = core();
    recordAction(db, { kind: "handled", messageId, payload: {} });
    revalidatePath("/inbox");
    return { ok: true };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Category editor's Save: writes the whole ordered list, or returns the validation error to show under it. */
export async function saveCategoriesAction(items: { id?: string; name: string; description: string }[]): Promise<StepError | void> {
  try {
    const { db } = core();
    saveCategories(db, items);
    revalidatePath("/inbox");
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Category editor's "Re-sort important mail": re-files mail already sorted important under the current categories. */
export async function resortImportantAction(): Promise<{ resorted: number; failed: number } | StepError> {
  try {
    const { cfg, db } = core();
    const { criteria } = await loadPipelineInputs(cfg);
    const result = await resortImportant(db, createSorter(cfg, db, "backlog"), criteria);
    // The backlog model has just judged a pile of mail, so what the trickle
    // model reads is out of date. Not awaited: the operator is waiting on the
    // sort, not on the rewrite (spec 7a).
    void afterBacklogRun(db, cfg);
    revalidatePath("/inbox");
    return result;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * The header's "Re-sort window": re-runs the sorter over everything already
 * sorted in the window on screen, so a new sub-category or a corrected money
 * verdict reaches mail that arrived before it. Importance is left alone
 * (see `resortWindow`), so nothing the operator has been shown disappears.
 */
export async function resortWindowAction(
  since: number | null,
  accountId?: string,
): Promise<{ resorted: number; failed: number } | StepError> {
  try {
    const { cfg, db } = core();
    const { criteria } = await loadPipelineInputs(cfg);
    const result = await resortWindow(db, createSorter(cfg, db, "backlog"), criteria, {
      // "All" has no lower bound, so the window start is the epoch.
      since: since ?? 0,
      ...(accountId ? { accountId } : {}),
    });
    // Same as above: the rules the trickle model reads are now out of date.
    void afterBacklogRun(db, cfg);
    revalidatePath("/inbox");
    return result;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * The projects editor's Save once groups are in it (2026-09-15): the groups
 * and the projects in one transaction, each project naming its group by the
 * editor's key. The saved rows and groups come back with their ids.
 */
export async function saveProjectsWithGroupsAction(
  accountId: string,
  items: { id?: string; name: string; description: string; groupKey?: string | null }[],
  groups: { id?: string; key: string; name: string }[],
): Promise<{ saved: { id: string; name: string; description: string; groupKey: string | null }[]; groups: { id: string; key: string; name: string }[] } | StepError> {
  try {
    const { db } = core();
    saveProjectsWithGroups(db, accountId, items, groups);
    revalidatePath("/inbox");
    return {
      saved: listProjects(db, accountId).map((p) => ({ id: p.id, name: p.name, description: p.description, groupKey: p.groupId })),
      groups: listProjectGroups(db, accountId).map((g) => ({ id: g.id, key: g.id, name: g.name })),
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Project editor's "Propose projects": Sonnet reads this inbox's senders,
 * subjects and snippets and answers with the projects the mail is about
 * (spec 10d). Nothing is written — the proposals go back as unsaved rows,
 * and Save is still the only thing that creates a project.
 */
export async function proposeProjectsAction(accountId: string): Promise<{ proposals: { name: string; description: string }[] } | StepError> {
  try {
    const { cfg, db } = core();
    const { proposals } = await proposeProjects(db, providerForRole("drafter", cfg, db, { role: "propose", accountId }), { accountId });
    return { proposals };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Project editor's "Re-file this inbox": the sorter reads this window's mail
 * again and names each message's project, which is the same work
 * "Re-sort window" does (spec 10d). Filing is a verdict on the message, so
 * the only way to change it is to read the message again.
 */
export async function refileProjectsAction(accountId: string, since: number | null): Promise<{ resorted: number; failed: number } | StepError> {
  return resortWindowAction(since, accountId);
}

/** Thread view's "Move to project…": files every message in the thread by hand, then re-files what that teaches. */
export async function fileThreadAction(threadId: string, projectId: string | null): Promise<{ ok: true } | StepError> {
  try {
    const { db } = core();
    const thread = db.select().from(schema.threads).where(eq(schema.threads.id, threadId)).get();
    if (!thread) return { error: "Thread not found." };
    fileThread(db, threadId, projectId);
    // Cheap: only messages with no vector are embedded, and the new exemplar
    // applies to the rest of the inbox straight away.
    revalidatePath("/inbox");
    revalidatePath(`/inbox/${threadId}`);
    return { ok: true };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** The picker's "New project…": creates it on this inbox and files the thread there in one step. */
export async function createProjectAction(
  accountId: string,
  name: string,
  threadId: string,
  /** The bigger project it belongs inside, when one is open (operator, 2026-09-20). */
  groupId: string | null = null,
): Promise<{ project: ProjectRow } | StepError> {
  try {
    const { db } = core();
    const project = createProject(db, accountId, name, "", undefined, groupId);
    fileThread(db, threadId, project.id);
    revalidatePath("/inbox");
    revalidatePath(`/inbox/${threadId}`);
    return { project };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * "The operator has seen this thread." Called by the thread view on mount,
 * not during its render: a page being rendered is not a person reading it.
 */
export async function markOpenedAction(threadId: string): Promise<void> {
  const { db } = core();
  markThreadOpened(db, threadId);
  // No revalidation: it would render the whole page again inside this
  // request, for a dot the selected row already paints (operator,
  // 2026-09-11: a click took seconds). Every page is dynamic, so the next
  // one read shows the open.
}

/** What the Unopened view is narrowed to, as the button hands it over. */
export interface UnopenedScope {
  /** Mail, or chats (2026-09-11): the Messages page marks chats, not the inbox. */
  folder?: "inbox" | "messages";
  accountId?: string;
  since?: number;
  projectId?: string;
  finance?: "income" | "expense";
}

/**
 * "Mark all opened": every unopened thread in this inbox, in one go, and it
 * returns what each thread said before so the toast can offer a way back.
 * The window chip is left out on purpose (operator, 2026-09-14): marking
 * only the days on screen left older read mail to surface again the moment
 * the window widened, which read as opened mail reappearing.
 */
export async function markAllOpenedAction(scope: UnopenedScope): Promise<{ marked: number; previous: ThreadOpenBefore[] }> {
  const { db } = core();
  const previous = markThreadsOpened(db, unopenedThreadIds(db, wholeInbox(scope)));
  revalidatePath("/inbox");
  return { marked: previous.length, previous };
}

/** Undo for the above: each thread back to what it said, un-opened where it said nothing. */
export async function restoreThreadOpensAction(previous: ThreadOpenBefore[]): Promise<void> {
  const { db } = core();
  restoreThreadOpens(db, previous);
  revalidatePath("/inbox");
}

/** What Delete all acts on: the Safe-to-delete view exactly as it is narrowed. */
export interface DisposableScope {
  /** Mail, or chats (2026-09-11): each has its own reading of safe. */
  folder?: "inbox" | "messages";
  accountId?: string;
  since?: number;
  projectId?: string;
  finance?: "income" | "expense";
}

/**
 * Every thread the Safe-to-delete list is showing, resolved at the moment
 * "Delete all" is pressed rather than baked into the page: the list may have
 * moved since it was rendered, and the threads that go are the ones that are
 * there now. Threads rather than messages, because that is what a delete
 * acts on.
 */
export async function disposableThreadsAction(scope: DisposableScope): Promise<string[]> {
  const { db } = core();
  return disposableThreadIds(db, { ...scope, folder: scope.folder ?? "inbox" });
}

/**
 * The same, for the Hidden list (operator, 2026-09-18). Hidden threads are
 * out of the way but still in the mailbox, and there was no way to clear
 * them out short of unhiding each one first.
 *
 * Resolved when the button is pressed, not when the page was drawn, for the
 * same reason: a sender who wrote again has taken their thread off this list
 * meanwhile, and it must not go with the rest.
 */
export async function hiddenThreadsAction(scope: DisposableScope): Promise<string[]> {
  const { db } = core();
  return hiddenThreadIds(db, { ...scope, folder: scope.folder ?? "inbox" });
}

/**
 * The delete itself (spec 10a, 2026-09-11). By the time this runs the
 * operator has clicked and the six seconds have run out: the gate in the
 * browser is the confirmation, and this is the act. Mail moves to the
 * provider's own Trash, where it keeps for about thirty days; nothing here
 * destroys anything.
 */
/**
 * Undo delete (operator, 2026-09-11: Cmd-Z): the threads' mail moves back
 * out of the provider's Trash into the inbox. The mirror of the delete, and
 * the same shape of answer.
 */
export async function restoreThreadsAction(threadIds: string[]): Promise<{ moved: number; failed: number } | StepError> {
  try {
    const { cfg, db } = core();
    const result = await restoreThreads(db, (account) => connectorForAccount(cfg, db, account), threadIds);
    revalidatePath("/inbox");
    revalidatePath("/deleted");
    for (const threadId of threadIds) revalidatePath(`/inbox/${threadId}`);
    return result;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * Hide (operator, 2026-09-11): the chat leaves Celeste for Deleted items and
 * stays in Messages or WhatsApp. The same rows a delete would move, moved
 * here alone; Put back and Undo bring them back as after a delete.
 */
export async function hideThreadsAction(threadIds: string[]): Promise<{ moved: number; failed: number; kept: string[]; reasons?: { email: string; message: string }[] } | StepError> {
  try {
    const { db } = core();
    const { moved } = hideThreads(db, threadIds);
    revalidatePath("/inbox");
    revalidatePath("/messages");
    revalidatePath("/deleted");
    for (const threadId of threadIds) revalidatePath(`/inbox/${threadId}`);
    return { moved, failed: 0, kept: [] };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Unhide (2026-09-15): the threads are back on the four sorting lists. */
export async function unhideThreadsAction(threadIds: string[]): Promise<{ unhidden: number } | StepError> {
  try {
    const unhidden = unhideThreads(core().db, threadIds);
    revalidatePath("/inbox");
    revalidatePath("/messages");
    for (const threadId of threadIds) revalidatePath(`/inbox/${threadId}`);
    return { unhidden };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function trashThreadsAction(threadIds: string[]): Promise<{ moved: number; failed: number; kept: string[]; reasons?: { email: string; message: string }[] } | StepError> {
  try {
    const { cfg, db } = core();
    const result = await trashThreads(db, (account) => connectorForAccount(cfg, db, account), threadIds);
    // The threads still holding something outside Trash are the ones the
    // provider kept (2026-09-11: Messages.app would not delete two chats,
    // and the page hid them as if it had). The browser puts them back.
    // Kept means the rows a delete moves are still where they were: a mail
    // thread's inbound inbox rows, a chat's rows. The operator's own mail
    // that sits in the inbox folder never moves and must not count
    // (2026-09-12: a big Delete all said "the provider kept them" for threads
    // that had gone, because a reply of the operator's own sat in the inbox).
    const kept = new Set<string>();
    for (let i = 0; i < threadIds.length; i += 400) {
      for (const r of db
        .select({ threadId: schema.messages.threadId })
        .from(schema.messages)
        .where(
          and(
            inArray(schema.messages.threadId, threadIds.slice(i, i + 400)),
            or(and(eq(schema.messages.folder, "inbox"), eq(schema.messages.isFromOperator, false)), eq(schema.messages.folder, "messages")),
          ),
        )
        .all()) {
        kept.add(r.threadId);
      }
    }
    revalidatePath("/inbox");
    revalidatePath("/deleted");
    revalidatePath("/messages");
    for (const threadId of threadIds) revalidatePath(`/inbox/${threadId}`);
    return { ...result, kept: [...kept] };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * "No reply needed" on a thread the operator sent last: it leaves Waiting for
 * reply at once (spec 10a). `waiting: true` puts it back.
 */
/**
 * Putting a thread where it belongs, because the model got it wrong
 * (operator, 2026-09-20). Optionally standing for every future message from
 * the same sender, which is the half that stops the same four alerts being
 * corrected again tomorrow.
 *
 * Nothing is re-judged and nothing is sent. The verdict is stamped as the
 * operator's, so no later pass rewrites it.
 */
export async function correctThreadAction(
  threadId: string,
  wants: Wants,
  alsoSender: boolean,
): Promise<{ ok: true; moved: number; senders: string[] } | StepError> {
  try {
    const { db } = core();
    const senders = alsoSender ? sendersOf(db, threadId) : [];
    const moved = correctThread(db, threadId, wants);
    for (const address of senders) setSenderRule(db, address, wants);
    revalidatePath("/inbox");
    revalidatePath("/messages");
    revalidatePath(`/inbox/${threadId}`);
    return { ok: true, moved, senders };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Who a "and always from them" would be about, for the menu to name. */
export async function threadSendersAction(threadId: string): Promise<string[]> {
  const { db } = core();
  return sendersOf(db, threadId);
}

/**
 * Take a thread out of Safe to delete (operator, 2026-09-18: "move a mail
 * from Safe to delete"), and say where it goes instead.
 *
 * The sorter is not re-run. This is the operator overruling it, the same way
 * the waiting dismissal already does, so it is a write and not a re-judgement.
 */
export async function keepThreadAction(threadId: string, dest: KeepDestination): Promise<{ ok: true } | StepError> {
  try {
    const { db } = core();
    keepThread(db, threadId, dest);
    revalidatePath("/inbox");
    return { ok: true };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function setThreadWaitingAction(threadId: string, waiting: boolean): Promise<{ ok: true } | StepError> {
  try {
    const { db } = core();
    setThreadWaiting(db, threadId, waiting);
    revalidatePath("/inbox");
    return { ok: true };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * "Add to Alex": one item off this thread into the scheduling agent (spec
 * 10e). Nothing is written unattended; this runs because the operator filled
 * the form in and pressed Add. Alex's tools are deterministic code over its
 * own database, so no model on either side talks to the other.
 *
 * A refusal comes back rather than throwing: it is recorded on the thread
 * beside a retry, which is what the operator wants to see.
 */
export async function addToAlexAction(threadId: string, item: AlexItem): Promise<{ item: AlexItemRow } | StepError> {
  try {
    const { db, cfg } = core();
    const thread = db.select().from(schema.threads).where(eq(schema.threads.id, threadId)).get();
    if (!thread) return { error: "Thread not found." };
    const row = await sendToAlex(db, threadId, item, cfg.alex);
    revalidatePath(`/inbox/${threadId}`);
    return { item: row };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** The retry beside a failed item: the same item again, as it was sent. */
export async function retryAlexItemAction(threadId: string, id: string): Promise<{ item: AlexItemRow } | StepError> {
  try {
    const { db, cfg } = core();
    const row = await retryAlexItem(db, id, cfg.alex);
    if (!row) return { error: "That item is already in Alex." };
    revalidatePath(`/inbox/${threadId}`);
    return { item: row };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * The times Alex says are free on one day, for the picker to offer. They are
 * Alex's *bookable* slots, so working hours and minimum notice apply; the
 * field still takes anything typed, so this narrows nothing (2026-09-16).
 * A failure is an empty list: a suggestion that cannot be fetched is not an
 * error worth stopping the operator for.
 */
export async function alexFreeTimesAction(startISO: string, endISO: string, minutes: number): Promise<{ slots: AlexSlot[]; timezone: string }> {
  try {
    const { cfg } = core();
    return await freeTimes({ startISO, endISO, minutes }, cfg.alex);
  } catch {
    return { slots: [], timezone: "UTC" };
  }
}

/** Whether Alex can be written to at all, so the button can say what is missing. */
export async function alexConnectedAction(): Promise<boolean> {
  return alexConnected(core().cfg.alex);
}

/**
 * The standing rule on its own, so the checkbox that shows one can also set
 * and clear one (operator, 2026-09-20: "the Always From toggle is
 * automatically off even though I turned it on"). A box that reports the
 * stored rule but only writes on a later pick would be the same lie the
 * other way round, so the toggle acts when it is toggled.
 */
export async function ruleSenderAction(
  threadId: string,
  wants: Wants | null,
): Promise<{ ok: true; senders: string[] } | StepError> {
  try {
    const { db } = core();
    const senders = sendersOf(db, threadId);
    for (const address of senders) {
      if (wants) setSenderRule(db, address, wants);
      else clearSenderRule(db, address);
    }
    revalidatePath("/inbox");
    return { ok: true, senders };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
