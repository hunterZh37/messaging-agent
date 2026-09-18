import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, messages, type MessageRow } from "../db/schema";
import { operatorAddresses } from "../accounts/aliases";
import type { DraftContext, DraftMode } from "./types";

/** Escapes `\`, `%`, and `_` so a raw address can be embedded in a LIKE pattern literally. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function buildDraftContext(db: Db, replyToMessageId: string, mode: DraftMode = "reply"): DraftContext {
  const replyTo = db.select().from(messages).where(eq(messages.id, replyToMessageId)).get();
  if (!replyTo) throw new Error(`message not found: ${replyToMessageId}`);
  const account = db.select().from(accounts).where(eq(accounts.id, replyTo.accountId)).get();
  if (!account) throw new Error(`account not found: ${replyTo.accountId}`);

  const thread = db.select().from(messages).where(eq(messages.threadId, replyTo.threadId)).orderBy(desc(messages.sentAt)).limit(10).all().reverse();

  // toAddresses/ccAddresses are stored as JSON arrays of quoted strings (e.g. `["bob@example.com"]`).
  // Wrapping the escaped address in literal double quotes anchors the match to a whole array
  // element, so "bob@example.com" cannot spuriously match a longer address like
  // "notbob@example.com" that merely contains it as a substring.
  const pattern = `%"${escapeLike(replyTo.fromAddress)}"%`;
  const sentToSender = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.accountId, account.id),
        eq(messages.isFromOperator, true),
        sql`(${messages.toAddresses} LIKE ${pattern} ESCAPE '\\' OR ${messages.ccAddresses} LIKE ${pattern} ESCAPE '\\')`,
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(5)
    .all();

  const sentGlobal = db
    .select()
    .from(messages)
    .where(and(eq(messages.accountId, account.id), eq(messages.isFromOperator, true)))
    .orderBy(desc(messages.sentAt))
    .limit(10)
    .all();

  return { operatorEmail: account.email.toLowerCase(), mode, replyTo, thread, sentToSender, sentGlobal, channel: replyTo.folder === "messages" ? "text" : "mail" };
}

/**
 * Who a draft goes to. Answering someone puts them first and keeps everyone
 * the message was addressed to. Following up on the operator's own message
 * means writing to the people they wrote to, so their own addresses come out
 * and the sender line is not one of them (spec 6). `operators` is every
 * address that is the operator, aliases included.
 */
export function computeRecipients(
  replyTo: MessageRow,
  operatorEmail: string,
  opts: { mode?: DraftMode; operators?: Set<string>; fallbackTo?: string } = {},
): { to: string[]; cc: string[] } {
  const operators = opts.operators ?? new Set([operatorEmail.toLowerCase()]);
  const mine = (x: string) => operators.has(x) || x === operatorEmail.toLowerCase();
  const dedupe = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter((x) => x && !mine(x)))];

  // A follow-up answers nobody, so the sender of the message being followed
  // up is the operator and has no place in the recipients.
  const first = opts.mode === "follow-up" ? [] : [replyTo.fromAddress];
  let to = dedupe([...first, ...replyTo.toAddresses]);
  const cc = dedupe(replyTo.ccAddresses).filter((x) => !to.includes(x));
  // Their last message went to nobody but themselves: fall back to whoever
  // wrote to them last, which is who the thread is with.
  if (to.length === 0 && cc.length === 0 && opts.fallbackTo) to = dedupe([opts.fallbackTo]);
  return { to, cc };
}

function renderMessage(m: MessageRow, operatorEmail: string): string {
  const who = m.fromAddress === operatorEmail ? `[operator] ${m.fromAddress}` : `${m.fromName ?? ""} <${m.fromAddress}>`.trim();
  const att = m.attachmentNames.length ? `\nAttachments: ${m.attachmentNames.join(", ")}` : "";
  return `### ${who} on ${new Date(m.sentAt).toISOString()}${att}\n${m.bodyText.slice(0, 6000)}`;
}

export function renderDraftUserMessage(ctx: DraftContext): string {
  const parts: string[] = [];
  parts.push(`## Mode\n${ctx.mode}\n`);
  parts.push(ctx.channel === "text" ? `## Chat with ${ctx.replyTo.fromName ?? ctx.replyTo.subject} (oldest first)\n` : `## Thread (oldest first)\nSubject: ${ctx.replyTo.subject}\n`);
  parts.push(ctx.thread.map((m) => renderMessage(m, ctx.operatorEmail)).join("\n\n"));
  if (ctx.sentToSender.length) {
    parts.push(`\n## Replies the operator sent to this sender\n`);
    parts.push(ctx.sentToSender.map((m) => m.bodyText.slice(0, 1500)).join("\n---\n"));
  }
  if (ctx.sentGlobal.length) {
    parts.push(`\n## Recent replies the operator sent to anyone\n`);
    parts.push(ctx.sentGlobal.map((m) => m.bodyText.slice(0, 800)).join("\n---\n"));
  }
  parts.push(
    ctx.mode === "follow-up"
      ? `\n## Follow up on this message, which the operator sent and nobody answered\n${renderMessage(ctx.replyTo, ctx.operatorEmail)}`
      : `\n## Reply to this message\n${renderMessage(ctx.replyTo, ctx.operatorEmail)}`,
  );
  return parts.join("\n");
}
