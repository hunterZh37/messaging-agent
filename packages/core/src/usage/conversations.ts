import { and, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { firstQuestionByChat } from "../chat/store";
import { chatMessages, chats, modelCalls } from "../db/schema";
import { estimateCostUsd } from "../models/pricing";
import { parseModelRef } from "../models/types";
import type { UsageWindow } from "./summary";

/**
 * What a conversation with Celeste cost (spec 13, 2026-09-11). The operator
 * asked to see this per conversation, not only per role: one long afternoon
 * of questions is a different thing from a week of sorting.
 *
 * The ledger is the source of truth — `model_calls` rows whose `ref` is the
 * chat id, one per request the tool loop sent. Conversations that happened
 * before the ledger existed have no such rows, so their tokens are read back
 * off the assistant turns instead, which have carried a model and a token
 * count all along. Those are marked `estimated`, because a turn's row counts
 * what the answer came to and knows nothing about the prompt cache.
 */
export interface ConversationUsage {
  chatId: string;
  title: string | null;
  /** The first thing asked in it, which is what a General conversation is about. */
  firstQuestion: string | null;
  /** Assistant turns in the conversation: what the operator would call answers. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** When it was last spoken to, of whatever the numbers came from. */
  lastAt: number | null;
  /** True when the figures came from the stored turns rather than the ledger. */
  estimated: boolean;
}

function boundsOf(window: UsageWindow, column: typeof modelCalls.at | typeof chatMessages.createdAt): SQL | undefined {
  const parts = [
    ...(window.since === undefined ? [] : [gte(column, window.since)]),
    ...(window.until === undefined ? [] : [lt(column, window.until)]),
  ];
  return parts.length > 0 ? and(...parts) : undefined;
}

/** One conversation's ledger rows, added up. */
function fromLedger(db: Db, window: UsageWindow, chatId?: string) {
  const where = and(
    eq(modelCalls.role, "chat"),
    sql`${modelCalls.ref} is not null`,
    ...(chatId ? [eq(modelCalls.ref, chatId)] : []),
    ...(boundsOf(window, modelCalls.at) ? [boundsOf(window, modelCalls.at) as SQL] : []),
  );
  return db
    .select({
      chatId: sql<string>`${modelCalls.ref}`,
      inputTokens: sql<number>`coalesce(sum(${modelCalls.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${modelCalls.outputTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${modelCalls.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`coalesce(sum(${modelCalls.cacheWriteTokens}), 0)`,
      costUsd: sql<number>`coalesce(sum(${modelCalls.costUsd}), 0)`,
      lastAt: sql<number>`max(${modelCalls.at})`,
    })
    .from(modelCalls)
    .where(where)
    .groupBy(modelCalls.ref)
    .all();
}

/**
 * The assistant turns of every conversation: how many, when the last one
 * was, and what they said they cost. Read for the turn count always, and for
 * the tokens only when the ledger has nothing on that conversation.
 */
function fromTurns(db: Db, window: UsageWindow, chatId?: string) {
  const where = and(
    eq(chatMessages.role, "assistant"),
    ...(chatId ? [eq(chatMessages.chatId, chatId)] : []),
    ...(boundsOf(window, chatMessages.createdAt) ? [boundsOf(window, chatMessages.createdAt) as SQL] : []),
  );
  const rows = db
    .select({
      chatId: chatMessages.chatId,
      model: chatMessages.model,
      inputTokens: chatMessages.inputTokens,
      outputTokens: chatMessages.outputTokens,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(where)
    .all();

  const byChat = new Map<string, { turns: number; inputTokens: number; outputTokens: number; costUsd: number; lastAt: number }>();
  for (const row of rows) {
    const acc = byChat.get(row.chatId) ?? { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, lastAt: 0 };
    acc.turns += 1;
    acc.inputTokens += row.inputTokens ?? 0;
    acc.outputTokens += row.outputTokens ?? 0;
    // A turn stored before the seam named its provider says "claude-sonnet-5";
    // `parseModelRef` reads that as Anthropic's, which is what it was.
    const usage = { inputTokens: row.inputTokens ?? 0, outputTokens: row.outputTokens ?? 0 };
    acc.costUsd += (row.model ? estimateCostUsd(parseModelRef(row.model), usage) : null) ?? 0;
    acc.lastAt = Math.max(acc.lastAt, row.createdAt);
    byChat.set(row.chatId, acc);
  }
  return byChat;
}

/** Newest first: a conversation the operator finished this morning is the one they are looking for. */
function newestFirst(a: ConversationUsage, b: ConversationUsage): number {
  return (b.lastAt ?? 0) - (a.lastAt ?? 0);
}

/**
 * Every conversation with something to report inside the window, dearest
 * work first in time rather than in money: History is read by when.
 */
export function usageByConversation(db: Db, window: UsageWindow = {}): ConversationUsage[] {
  const ledger = new Map(fromLedger(db, window).map((r) => [r.chatId, r]));
  const turns = fromTurns(db, window);
  const titles = new Map(db.select({ id: chats.id, title: chats.title }).from(chats).all().map((c) => [c.id, c.title]));
  const asked = firstQuestionByChat(db);

  const ids = new Set<string>([...ledger.keys(), ...turns.keys()]);
  const out: ConversationUsage[] = [];
  for (const chatId of ids) {
    // A ledger row whose ref is not a conversation at all (nothing writes
    // one today) would otherwise invent a row in this table.
    if (!titles.has(chatId)) continue;
    out.push(merge(chatId, titles.get(chatId) ?? null, asked.get(chatId) ?? null, ledger.get(chatId), turns.get(chatId)));
  }
  return out.sort(newestFirst);
}

/** One conversation, over all of its life. Zeroes for one nothing has been asked of. */
export function conversationUsage(db: Db, chatId: string): ConversationUsage {
  const [ledger] = fromLedger(db, {}, chatId);
  const turns = fromTurns(db, {}, chatId).get(chatId);
  const title = db.select({ title: chats.title }).from(chats).where(eq(chats.id, chatId)).get()?.title ?? null;
  return merge(chatId, title, firstQuestionByChat(db).get(chatId) ?? null, ledger, turns);
}

function merge(
  chatId: string,
  title: string | null,
  firstQuestion: string | null,
  ledger: ReturnType<typeof fromLedger>[number] | undefined,
  turns: { turns: number; inputTokens: number; outputTokens: number; costUsd: number; lastAt: number } | undefined,
): ConversationUsage {
  const turnCount = turns?.turns ?? 0;
  if (ledger) {
    return {
      chatId,
      title,
      firstQuestion,
      turns: turnCount,
      inputTokens: ledger.inputTokens,
      outputTokens: ledger.outputTokens,
      cacheReadTokens: ledger.cacheReadTokens,
      cacheWriteTokens: ledger.cacheWriteTokens,
      costUsd: ledger.costUsd,
      lastAt: Math.max(ledger.lastAt ?? 0, turns?.lastAt ?? 0) || null,
      estimated: false,
    };
  }
  return {
    chatId,
    title,
    firstQuestion,
    turns: turnCount,
    inputTokens: turns?.inputTokens ?? 0,
    outputTokens: turns?.outputTokens ?? 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: turns?.costUsd ?? 0,
    lastAt: turns?.lastAt ?? null,
    // Nothing was asked at all, so there is nothing to be approximate about.
    estimated: turnCount > 0,
  };
}
