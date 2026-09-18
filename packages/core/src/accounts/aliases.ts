import { asc, eq, inArray, sql } from "drizzle-orm";
import { now, type Db } from "../db/client";
import { accounts, messages, operatorAliases, sorts, threads, type OperatorAliasRow } from "../db/schema";
import type { NormalizedMessage } from "../connectors/types";

export type { OperatorAliasRow };

/**
 * Senders that forward on someone's behalf, putting their own address in the
 * envelope and the real one in the display name. Mail from the operator's
 * other accounts arrives this way and would otherwise read as inbound.
 */
const RELAYS = new Set(["office365@messaging.microsoft.com"]);

/** Enough of an address to be one: something, an @, a dot in the domain. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The operator's other addresses, alphabetically. A list of addresses has no
 * priority order the way sub-categories do, so it is sorted rather than
 * carrying a position column nobody would ever reorder.
 */
export function listAliases(db: Db): OperatorAliasRow[] {
  return db.select().from(operatorAliases).orderBy(asc(operatorAliases.address)).all();
}

/**
 * Replaces the whole list in one transaction, the way the category and
 * project editors do: the form holds the truth and Save writes it. Addresses
 * are lowercased and de-duplicated, so the stored list is already the set
 * that matching wants. Throws a readable Error the UI can show as-is.
 */
export function saveAliases(db: Db, addresses: string[], clock: () => number = now): void {
  const cleaned: string[] = [];
  for (const raw of addresses) {
    const address = raw.trim().toLowerCase();
    if (!address) continue;
    if (!EMAIL.test(address)) throw new Error(`"${raw.trim()}" is not an email address.`);
    if (!cleaned.includes(address)) cleaned.push(address);
  }

  const at = clock();
  db.transaction((tx) => {
    const existing = new Map(tx.select().from(operatorAliases).all().map((a) => [a.address, a.createdAt]));
    tx.delete(operatorAliases).run();
    for (const address of cleaned) {
      // An address that survives a Save keeps the day it was added.
      tx.insert(operatorAliases).values({ address, createdAt: existing.get(address) ?? at }).run();
    }
  });
}

/**
 * Every address that is the operator: the inbox each connected account reads,
 * plus the aliases they have added. A disconnected account is still them, so
 * it stays in the set — old mail should not change sides when an inbox goes.
 */
export function operatorAddresses(db: Db): Set<string> {
  const emails = db.select({ email: accounts.email }).from(accounts).all().map((a) => a.email.toLowerCase());
  return new Set([...emails, ...listAliases(db).map((a) => a.address)]);
}

/**
 * Is this message the operator's own? Their address in the From line says so
 * directly; a relay says so through the display name, which is where the
 * real sender ends up when a service forwards on their behalf (spec 10a).
 */
export function isOperatorMessage(
  n: Pick<NormalizedMessage, "fromAddress" | "fromName">,
  operators: Set<string>,
): boolean {
  const from = n.fromAddress.trim().toLowerCase();
  if (operators.has(from)) return true;
  if (!RELAYS.has(from)) return false;
  const name = n.fromName?.trim().toLowerCase();
  return name !== undefined && operators.has(name);
}

/**
 * Re-decides who wrote every stored message with the current set of operator
 * addresses, for when that set changes. A message that turns out to be the
 * operator's loses its sort: a verdict about whether they want to see their
 * own mail today is meaningless, and leaving it would keep the message in the
 * Important counts. Threads are re-stamped from their newest message, which
 * is what "waiting for a reply" reads.
 */
export function restampOperator(db: Db): { messages: number; threads: number; sorts: number } {
  const operators = operatorAddresses(db);
  const rows = db
    .select({ id: messages.id, fromAddress: messages.fromAddress, fromName: messages.fromName, isFromOperator: messages.isFromOperator })
    .from(messages)
    .all();

  const flipped = rows.filter((r) => isOperatorMessage(r, operators) !== r.isFromOperator);
  const nowOperator = flipped.filter((r) => !r.isFromOperator).map((r) => r.id);

  let threadsChanged = 0;
  db.transaction((tx) => {
    for (const row of flipped) {
      tx.update(messages).set({ isFromOperator: !row.isFromOperator }).where(eq(messages.id, row.id)).run();
    }
    // A verdict on the operator's own mail is not a verdict on anything.
    for (let i = 0; i < nowOperator.length; i += 400) {
      tx.delete(sorts).where(inArray(sorts.messageId, nowOperator.slice(i, i + 400))).run();
    }
    // Whoever sent a thread's newest message is who the thread ends with.
    const latest = tx
      .select({
        threadId: messages.threadId,
        isFromOperator: sql<number>`(
          select m.is_from_operator from messages m
          where m.thread_id = ${messages.threadId}
          order by m.sent_at desc, m.id desc limit 1
        )`,
      })
      .from(messages)
      .groupBy(messages.threadId)
      .all();
    for (const t of latest) {
      const value = t.isFromOperator === 1;
      const changed = tx
        .update(threads)
        .set({ lastFromOperator: value })
        .where(sql`${threads.id} = ${t.threadId} and ${threads.lastFromOperator} != ${value ? 1 : 0}`)
        .run();
      threadsChanged += changed.changes;
    }
  });

  return { messages: flipped.length, threads: threadsChanged, sorts: nowOperator.length };
}
