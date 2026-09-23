import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, ne, notInArray, sql } from "drizzle-orm";
import { now, type Db } from "../db/client";
import { draftRevisions, drafts, messages, sorts, threads, type MessageRow } from "../db/schema";
import { operatorAddresses } from "../accounts/aliases";
import { buildDraftContext, computeRecipients } from "./context";
import type { Drafter } from "./types";

const DRAFT_WINDOW_MS = 7 * 86_400_000;

/**
 * The reason the drafter gave for writing nothing, when its whole answer is
 * the one `NO REPLY:` line it is told to use for mail that asks nothing;
 * null for a draft.
 */
export function declined(text: string): string | null {
  const m = text.trim().match(/^NO REPLY:\s*(.*)$/i);
  if (!m || m[0] !== text.trim()) return null;
  return m[1]!.trim() || "Nothing here asks for an answer.";
}

/**
 * Latest message in each thread where: thread's last message is not the
 * operator's, thread is within 7 days, message sorted important + needs_reply,
 * and no pending, sent or skipped draft exists for that message. A skip is
 * the operator's answer to that message (operator, 2026-09-10: "when we skip
 * an email in drafts, it should not display anything anymore"); the next
 * message in the thread is a new question and is drafted afresh.
 */
export function selectDraftCandidates(db: Db, clock: () => number = now): MessageRow[] {
  const since = clock() - DRAFT_WINDOW_MS;
  const drafted = db
    .select({ id: drafts.replyToMessageId })
    .from(drafts)
    .where(inArray(drafts.status, ["pending", "sent", "skipped", "declined"]));

  return db
    .select({ m: messages })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(sorts, eq(sorts.messageId, messages.id))
    .where(
      and(
        eq(threads.lastFromOperator, false),
        gt(threads.lastMessageAt, since),
        eq(messages.sentAt, threads.lastMessageAt),
        eq(messages.isFromOperator, false),
        // Texts are drafted on request only (operator, 2026-09-11: read + reply, no auto-drafting).
        ne(messages.folder, "messages"),
        eq(sorts.wants, "reply"),
        notInArray(messages.id, drafted),
      ),
    )
    .orderBy(sql`${messages.sentAt} asc`)
    .all()
    .map((r) => r.m);
}

export async function draftPending(
  db: Db,
  drafter: Drafter,
  voice: string,
  opts: { clock?: () => number } = {},
): Promise<{ drafted: number; failed: number; declined: number }> {
  const clock = opts.clock ?? now;
  let drafted = 0;
  let failed = 0;
  let declinedCount = 0;
  for (const m of selectDraftCandidates(db, clock)) {
    try {
      const ctx = buildDraftContext(db, m.id);
      const text = await drafter.draft(voice, ctx);
      const { to, cc } = computeRecipients(ctx.replyTo, ctx.operatorEmail);
      const t = clock();
      const reason = declined(text);
      db.insert(drafts)
        .values({
          id: randomUUID(),
          threadId: m.threadId,
          replyToMessageId: m.id,
          originalText: reason ?? text,
          finalText: null,
          toAddresses: to,
          ccAddresses: cc,
          status: reason ? "declined" : "pending",
          model: drafter.model,
          sentProviderMessageId: null,
          error: null,
          createdAt: t,
          updatedAt: t,
        })
        .run();
      if (reason) declinedCount++;
      else drafted++;
    } catch (err) {
      failed++;
      console.error(`draft failed for ${m.id}:`, (err as Error).message);
    }
  }
  return { drafted, failed, declined: declinedCount };
}

/**
 * Drafts for one thread on demand, from the Thread view's button. Unlike
 * `draftPending`, it ignores the sorter's important and needs_reply flags
 * entirely — the operator asked for this directly. A thread whose last
 * message is theirs has nothing inbound to answer, so what they get is a
 * follow-up: a nudge to the people they wrote to, threaded onto their own
 * message (spec 6). Refusing that was the old behaviour and it was wrong;
 * chasing an unanswered message is most of what a follow-up is for.
 */
export async function draftForThread(
  db: Db,
  drafter: Drafter,
  voice: string,
  threadId: string,
  opts: { clock?: () => number; force?: boolean; instruction?: string } = {},
): Promise<{ draftId: string } | { declined: string } | { error: string }> {
  const clock = opts.clock ?? now;
  const thread = db.select().from(threads).where(eq(threads.id, threadId)).get();
  if (!thread) return { error: `thread not found: ${threadId}` };

  const latest = db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(desc(messages.sentAt)).limit(1).get();
  if (!latest) return { error: "This thread has no messages." };

  const mode = latest.isFromOperator ? "follow-up" : "reply";
  const ctx = buildDraftContext(db, latest.id, mode);
  // What the operator asked the draft to say goes with the thread (Ask
  // Celeste, 2026-09-14); asked in so many words, there is nothing to decline.
  const instruction = opts.instruction?.trim() || undefined;
  const text = await drafter.draft(voice, ctx, { force: opts.force ?? false, ...(instruction ? { instruction } : {}) });
  // The drafter saw nothing to answer. The reason is kept as a declined row
  // and handed back, so the page can say so and offer to draft anyway.
  const reason = opts.force || instruction ? null : declined(text);
  // A follow-up goes to the people the operator wrote to. If that message was
  // addressed to nobody but themselves, whoever wrote to them last is who the
  // thread is with.
  const lastInbound =
    mode === "follow-up"
      ? db
          .select({ from: messages.fromAddress })
          .from(messages)
          .where(and(eq(messages.threadId, threadId), eq(messages.isFromOperator, false)))
          .orderBy(desc(messages.sentAt))
          .limit(1)
          .get()?.from
      : undefined;
  const { to, cc } = computeRecipients(ctx.replyTo, ctx.operatorEmail, {
    mode,
    operators: operatorAddresses(db),
    ...(lastInbound ? { fallbackTo: lastInbound } : {}),
  });
  const t = clock();
  const id = randomUUID();
  db.insert(drafts)
    .values({
      id,
      threadId,
      replyToMessageId: latest.id,
      originalText: reason ?? text,
      finalText: null,
      toAddresses: to,
      ccAddresses: cc,
      status: reason ? "declined" : "pending",
      mode,
      model: drafter.model,
      sentProviderMessageId: null,
      error: null,
      createdAt: t,
      updatedAt: t,
    })
    .run();
  return reason ? { declined: reason } : { draftId: id };
}

/**
 * "Revise with Celeste" (spec 8, 2026-09-10): the operator types one line
 * under the draft — shorter, more formal, add that I am out Friday — and
 * gets the whole body back with that change made. `current` is the text on
 * the card, which may already carry their own edits.
 *
 * The revision is remembered beside the draft and nothing in `drafts`
 * moves: `original_text` is still what Celeste first wrote, so the confirm
 * diff keeps showing everything that changed since, and `final_text` is
 * still only written by a send. A revision is an offer, exactly like a
 * manual edit, and the operator is the one who accepts it.
 */
export async function reviseDraft(
  db: Db,
  drafter: Drafter,
  voice: string,
  draftId: string,
  current: string,
  instruction: string,
  clock: () => number = now,
): Promise<{ text: string; revisionId: string }> {
  const draft = db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft) throw new Error(`draft not found: ${draftId}`);
  if (draft.status !== "pending") throw new Error(`draft ${draftId} is not pending (status=${draft.status})`);
  if (!instruction.trim()) throw new Error("Say what to change.");

  // A composed message has nothing above it to build a context from; its own
  // rewriting waits for its own change (spec 2026-09-22).
  if (!draft.replyToMessageId) throw new Error("Revise is not available for a composed message yet.");
  // mode is "reply" or "follow-up" here: a composed draft threw two lines up.
  const ctx = buildDraftContext(db, draft.replyToMessageId, draft.mode as "reply" | "follow-up");
  const text = await drafter.revise(voice, ctx, current, instruction);

  return { text, revisionId: recordDraftRevision(db, { draftId, instruction, before: current, after: text, model: drafter.model }, clock) };
}

/**
 * One row in `draft_revisions` for a rewrite that has already happened
 * somewhere else: "Apply to draft" in the Ask Celeste panel, where the text
 * came back with the answer rather than from a call made here (spec 10c,
 * 2026-09-10). Same rules as a revision in the card — the draft is still
 * pending, and nothing in `drafts` moves — so the record of what a draft has
 * been through stays complete whichever field the operator typed in.
 */
export function recordDraftRevision(
  db: Db,
  input: { draftId: string; instruction: string; before: string; after: string; model: string },
  clock: () => number = now,
): string {
  const draft = db.select().from(drafts).where(eq(drafts.id, input.draftId)).get();
  if (!draft) throw new Error(`draft not found: ${input.draftId}`);
  if (draft.status !== "pending") throw new Error(`draft ${input.draftId} is not pending (status=${draft.status})`);

  const id = randomUUID();
  db.insert(draftRevisions)
    .values({ id, draftId: input.draftId, instruction: input.instruction, before: input.before, after: input.after, model: input.model, createdAt: clock() })
    .run();
  return id;
}
