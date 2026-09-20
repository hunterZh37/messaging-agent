import { eq } from "drizzle-orm";
import { now as nowMs, type Db } from "../db/client";
import { messages, senderRules, sorts, type SenderRuleRow, type Wants } from "../db/schema";
import { assignedProjectName } from "../projects/projects";
import { NO_PROJECT, type Sorter, type SortResult } from "./types";

/**
 * The operator putting a message where it belongs (operator, 2026-09-20:
 * "where Jev sorts wrong, I can in the UI tell where that email is supposed
 * to be"), and, when they say so, remembering it about the sender.
 *
 * Two things had to be true for a correction to be worth making. It has to
 * survive: a verdict the operator set by hand and the next re-sort quietly
 * overwrote would be worse than no feature, because they would stop trusting
 * the ones that stuck. And it has to be able to reach forward, or the same
 * four Zillow alerts arrive again tomorrow and get corrected again.
 */

/**
 * What `sorts.model` says when the operator decided rather than a model.
 *
 * It doubles as the mark the codebase was missing — "nothing marks a hand
 * correction yet" — so these verdicts are the ones the learned rules trust
 * most, and every re-sort passes over them.
 */
export const OPERATOR = "operator";

/** Lowercased, so one rule covers Codes@x and codes@x. */
const key = (address: string) => (address.match(/<([^>]+)>/)?.[1] ?? address).trim().toLowerCase();

export function senderRuleFor(db: Db, fromAddress: string): SenderRuleRow | undefined {
  return db.select().from(senderRules).where(eq(senderRules.fromAddress, key(fromAddress))).get();
}

export function listSenderRules(db: Db): SenderRuleRow[] {
  return db.select().from(senderRules).orderBy(senderRules.fromAddress).all();
}

export function setSenderRule(db: Db, fromAddress: string, wants: Wants, clock: () => number = nowMs): void {
  db.insert(senderRules)
    .values({ fromAddress: key(fromAddress), wants, createdAt: clock() })
    .onConflictDoUpdate({ target: senderRules.fromAddress, set: { wants } })
    .run();
}

export function clearSenderRule(db: Db, fromAddress: string): void {
  db.delete(senderRules).where(eq(senderRules.fromAddress, key(fromAddress))).run();
}

/**
 * Put a thread on a rung because the operator said so.
 *
 * Every message in the thread moves, the way the list reads it, and each is
 * stamped as the operator's so no pass rewrites it. A thread bound for the
 * bin keeps no sub-category, for the same reason the sorter gives it none:
 * a category is a way of filing what will be looked at.
 *
 * Returns how many verdicts changed, so a caller can tell a correction that
 * did something from one that was already true.
 */
export function correctThread(db: Db, threadId: string, wants: Wants, clock: () => number = nowMs): number {
  const ids = db.select({ id: messages.id }).from(messages).where(eq(messages.threadId, threadId)).all().map((r) => r.id);
  if (ids.length === 0) return 0;

  // Written, not merely updated. Mail the sorter has not reached yet carries
  // no verdict row at all, and an update against nothing changed nothing:
  // the row slid away, the server said it had worked, and the message came
  // back on the next paint (operator, 2026-09-20: "safe to delete does not
  // show up that new email"). Correcting a message the machine has not
  // judged is exactly when a person is most likely to want to.
  const at = clock();
  let changed = 0;
  for (const id of ids) {
    changed += db
      .insert(sorts)
      .values({
        messageId: id,
        wants,
        scheduling: false,
        category: null,
        finance: "none",
        reason: "You put this here.",
        model: OPERATOR,
        labeledAt: null,
        createdAt: at,
      })
      .onConflictDoUpdate({
        target: sorts.messageId,
        set: { wants, model: OPERATOR, reason: "You put this here.", ...(wants === "bin" ? { category: null } : {}) },
      })
      .run().changes;
  }
  return changed;
}

/** Everyone who wrote in this thread, other than the operator: who a sender rule would be about. */
export function sendersOf(db: Db, threadId: string): string[] {
  const rows = db
    .select({ from: messages.fromAddress, mine: messages.isFromOperator })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .all();
  return [...new Set(rows.filter((r) => !r.mine).map((r) => key(r.from)))];
}

/**
 * A sorter that reads the operator's standing instructions first.
 *
 * A sender they have ruled on never reaches the model: no call, no cost, and
 * no chance of the answer drifting between one message and the next. Wrapped
 * around whichever sorter is configured rather than built into one, so the
 * rule holds whoever is answering.
 */
export function withSenderRules(db: Db, inner: Sorter): Sorter {
  return {
    model: inner.model,
    async sort(criteria, categories, projects, input): Promise<SortResult> {
      const rule = senderRuleFor(db, input.fromAddress);
      if (!rule) return inner.sort(criteria, categories, projects, input);
      // The rule decides the rung and nothing else, so a message already
      // filed under a project stays filed. Re-judging that would be a second
      // decision the operator never asked for, and a sender rule that
      // silently unfiled a client's mail would be a bad trade for the saving.
      const held = input.id
        ? db.select({ category: sorts.category, finance: sorts.finance, scheduling: sorts.scheduling }).from(sorts).where(eq(sorts.messageId, input.id)).get()
        : undefined;
      return {
        wants: rule.wants,
        scheduling: held?.scheduling ?? false,
        category: rule.wants === "bin" ? "Other" : (held?.category ?? "Other"),
        finance: (held?.finance as SortResult["finance"]) ?? "none",
        project: input.id ? assignedProjectName(db, input.id) : NO_PROJECT,
        reason: `You said everything from ${key(input.fromAddress)} belongs in ${rule.wants}.`,
      };
    },
  };
}
