import { and, eq, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { now, type Db } from "../db/client";
import { accounts, drafts, messages, type DraftRow } from "../db/schema";
import { validateRecipients } from "../connectors/mime";

/**
 * A message that begins a conversation (operator, 2026-09-22: a compose button,
 * and Celeste able to draft a new email rather than only a reply).
 *
 * It is an ordinary pending draft with no thread and nothing it answers, so it
 * queues, previews, revises and sends through the one gate everything else
 * goes through. Nothing here reaches a provider: the send button does that.
 */

export interface ComposeInput {
  accountId: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  /** What wrote it: a model's name, or "operator" when the words are the operator's own. */
  model?: string;
}

export function composeDraft(db: Db, input: ComposeInput, clock: () => number = now): DraftRow {
  const account = db.select().from(accounts).where(eq(accounts.id, input.accountId)).get();
  if (!account) throw new Error(`account not found: ${input.accountId}`);
  // Mail only for now: a chat has no subject, and its compose lands in its own
  // change (spec 2026-09-22) rather than being half-built here.
  if (account.provider === "imessage" || account.provider === "whatsapp") {
    throw new Error(`compose is not supported for ${account.provider} yet`);
  }
  const to = input.to.map((a) => a.trim()).filter(Boolean);
  const cc = (input.cc ?? []).map((a) => a.trim()).filter(Boolean);
  if (to.length === 0) throw new Error("at least one To recipient is required");
  validateRecipients(to, cc);
  const subject = input.subject.trim();
  if (!subject) throw new Error("a subject is required");

  const t = clock();
  const row: DraftRow = {
    id: randomUUID(),
    threadId: null,
    replyToMessageId: null,
    accountId: account.id,
    subject,
    originalText: input.text,
    finalText: null,
    toAddresses: to,
    ccAddresses: cc,
    status: "pending",
    mode: "new",
    model: input.model ?? "operator",
    sentProviderMessageId: null,
    error: null,
    createdAt: t,
    updatedAt: t,
  };
  db.insert(drafts).values(row).run();
  return row;
}

/**
 * Addresses this account has never exchanged a message with.
 *
 * A reply is implicitly safe: the other side wrote first. A composed message
 * has no such history, so the confirm dialog says plainly when an address is
 * new (spec 2026-09-22). A warning, not a block: the operator may well be
 * writing to someone for the first time on purpose.
 */
export function firstContact(db: Db, accountId: string, addresses: string[]): string[] {
  const seen = new Set<string>();
  for (const address of addresses) {
    const a = address.trim().toLowerCase();
    if (!a || seen.has(a)) continue;
    const hit = db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.accountId, accountId),
          or(
            sql`lower(${messages.fromAddress}) = ${a}`,
            // To and Cc are JSON arrays of addresses; a substring match on the
            // quoted address is exact enough for a warning and needs no table.
            sql`lower(${messages.toAddresses}) like ${`%"${a}"%`}`,
            sql`lower(${messages.ccAddresses}) like ${`%"${a}"%`}`,
          ),
        ),
      )
      .limit(1)
      .get();
    if (!hit) seen.add(a);
  }
  return [...seen];
}
