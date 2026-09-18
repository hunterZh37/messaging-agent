import { and, asc, count, desc, eq, isNull, max, min } from "drizzle-orm";
import { now, type Db } from "../db/client";
import { chatFiles, chatMessages, chats, type ChatMessageRow, type ChatRow } from "../db/schema";
import type { Citation, ProposedAction } from "./types";
import { describeThreads } from "./context";

/** How much of the conversation the panel paints on load. */
const DEFAULT_LIMIT = 200;

/** How many conversations History lists before the operator has to search. */
const HISTORY_LIMIT = 50;

/**
 * Ids sort the way the turns happened. Two messages written inside the same
 * millisecond are ordered by this counter, so a question never renders under
 * its own answer.
 */
let sequence = 0;

/** What a conversation is about: one thread, or nothing in particular. */
export interface ChatContext {
  threadId?: string | null;
}

/** A row of History: the conversation, plus how much was said and when last. */
export interface ChatSummary extends ChatRow {
  messageCount: number;
  lastAt: number | null;
  /**
   * The first thing the operator asked in it (spec 13, 2026-09-11). A thread's
   * conversation is named by its mail, but every General one is called
   * "General", and the question is what tells them apart.
   */
  firstQuestion: string | null;
}

function newChatId(at: number): string {
  return `chat-${String(at).padStart(14, "0")}-${String(sequence++).padStart(6, "0")}`;
}

/** The thread of a context, or null when the question belongs to no thread. */
function contextThread(ctx: ChatContext): string | null {
  return ctx.threadId ?? null;
}

/**
 * What History calls a thread's conversation: the subject and whoever the
 * thread is with, which is what the operator would call it themselves. The
 * counterpart comes from the same lookup a proposal's chips use, so the two
 * never disagree about who a thread is with.
 */
export function chatTitleFor(db: Db, ctx: ChatContext): string {
  const threadId = contextThread(ctx);
  if (!threadId) return "General";
  const [described] = describeThreads(db, [threadId]);
  if (!described) return "Conversation";
  const counterpart = described.from.replace(/\s*<[^>]*>\s*$/, "").trim() || described.from;
  return counterpart ? `${described.subject} · ${counterpart}` : described.subject;
}

/**
 * The conversation a context is currently on, or nothing when it has never
 * had one. Reading without making: a page that merely renders a thread should
 * not leave a conversation behind for a panel nobody opened.
 */
export function findChatFor(db: Db, ctx: ChatContext): ChatRow | undefined {
  const threadId = contextThread(ctx);
  return db
    .select()
    .from(chats)
    .where(and(isNull(chats.closedAt), threadId ? eq(chats.threadId, threadId) : eq(chats.kind, "general")))
    .orderBy(desc(chats.updatedAt), desc(chats.createdAt))
    .get();
}

function createChat(db: Db, ctx: ChatContext, clock: () => number): ChatRow {
  const at = clock();
  const threadId = contextThread(ctx);
  const id = newChatId(at);
  db.insert(chats)
    .values({
      id,
      kind: threadId ? "thread" : "general",
      threadId,
      title: chatTitleFor(db, ctx),
      createdAt: at,
      updatedAt: at,
    })
    .run();
  return db.select().from(chats).where(eq(chats.id, id)).get()!;
}

/**
 * The conversation the panel opens to for what the operator is looking at
 * (spec 10c, 2026-09-10): a thread's own, or General when the question
 * belongs to no thread. Made on first use, and come back to after that, so
 * opening a thread twice reads back what was said the first time.
 */
export function openChatFor(db: Db, ctx: ChatContext, clock: () => number = now): ChatRow {
  return findChatFor(db, ctx) ?? createChat(db, ctx, clock);
}

/**
 * "New conversation": the one on screen is closed and a fresh one takes its
 * place in the same context. Closing is not deleting — the old one is still
 * in History, it is just no longer what this thread opens to.
 */
export function startNewChat(db: Db, ctx: ChatContext, clock: () => number = now): ChatRow {
  const current = findChatFor(db, ctx);
  if (current) db.update(chats).set({ closedAt: clock() }).where(eq(chats.id, current.id)).run();
  return createChat(db, ctx, clock);
}

/**
 * History: every conversation, the one spoken to last on top, closed ones
 * included. One nobody has said anything in yet is left out — merely opening
 * a thread with the panel up should not fill the list with rows there is
 * nothing to go back to.
 */
export function listChats(db: Db, opts: { limit?: number } = {}): ChatSummary[] {
  const counts = db
    .select({ chatId: chatMessages.chatId, messageCount: count(), lastAt: max(chatMessages.createdAt) })
    .from(chatMessages)
    .groupBy(chatMessages.chatId)
    .all();
  const byChat = new Map(counts.map((c) => [c.chatId, c]));
  const asked = firstQuestionByChat(db);
  return db
    .select()
    .from(chats)
    .orderBy(desc(chats.updatedAt), desc(chats.createdAt))
    .all()
    .flatMap((chat) => {
      const said = byChat.get(chat.id);
      if (!said) return [];
      return [{ ...chat, messageCount: said.messageCount, lastAt: said.lastAt, firstQuestion: asked.get(chat.id) ?? null }];
    })
    .slice(0, opts.limit ?? HISTORY_LIMIT);
}

/**
 * The opening question of every conversation, by conversation. SQLite hands
 * back the row that `min` picked, so this is the earliest turn's own words
 * rather than some other turn's.
 */
export function firstQuestionByChat(db: Db): Map<string, string> {
  const rows = db
    .select({ chatId: chatMessages.chatId, content: chatMessages.content, at: min(chatMessages.createdAt) })
    .from(chatMessages)
    .where(eq(chatMessages.role, "user"))
    .groupBy(chatMessages.chatId)
    .all();
  return new Map(rows.map((r) => [r.chatId, r.content]));
}

/**
 * The general conversation, created on first use. Kept under its old name
 * because most of the app only ever wants "the one that is not about a
 * thread" (spec 10c).
 */
export function getOrCreateChat(db: Db, clock: () => number = now): ChatRow {
  return openChatFor(db, {}, clock);
}

/** The conversation, oldest first, capped at the newest `limit` turns. */
export function listChatMessages(db: Db, chatId: string, limit = DEFAULT_LIMIT): ChatMessageRow[] {
  const rows = db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .all();
  // Turns stored before proposals carried names are named on the way out,
  // so the panel never shows "Thread 1" for a thread it could look up.
  return rows.slice(-limit).map((row) => {
    if (!row.actions || !row.actions.some((a) => !a.threads)) return row;
    const actions = row.actions.map((a) => (a.threads ? a : { ...a, threads: describeThreads(db, actionThreadIds(a)) }));
    return { ...row, actions };
  });
}

/** The threads a proposal covers, whichever field a row of its age used. */
function actionThreadIds(a: ProposedAction): string[] {
  if (a.threadIds && a.threadIds.length > 0) return a.threadIds;
  return a.threadId ? [a.threadId] : [];
}

export interface NewChatMessage {
  chatId: string;
  role: "user" | "assistant";
  content: string;
  contextThreadId?: string | null;
  /** The draft the operator had open, when the question was asked over one. */
  contextDraftId?: string | null;
  citations?: Citation[] | null;
  actions?: ProposedAction[] | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/** Appends one turn and returns the stored row. */
export function appendChatMessage(db: Db, message: NewChatMessage, clock: () => number = now): ChatMessageRow {
  const at = clock();
  const id = `${String(at).padStart(14, "0")}-${String(sequence++).padStart(6, "0")}`;
  db.insert(chatMessages)
    .values({
      id,
      chatId: message.chatId,
      role: message.role,
      content: message.content,
      contextThreadId: message.contextThreadId ?? null,
      contextDraftId: message.contextDraftId ?? null,
      citations: message.citations ?? null,
      actions: message.actions ?? null,
      model: message.model ?? null,
      inputTokens: message.inputTokens ?? null,
      outputTokens: message.outputTokens ?? null,
      createdAt: at,
    })
    .run();
  // History reads newest-spoken-to first, so the turn is what moves a
  // conversation up the list, not the moment it was opened.
  db.update(chats).set({ updatedAt: at }).where(eq(chats.id, message.chatId)).run();
  return db.select().from(chatMessages).where(eq(chatMessages.id, id)).get()!;
}

/**
 * The operator deletes a conversation (2026-09-10): its turns, the files it
 * held and the row itself go; the blobs stay, since they are shared by
 * content. `true` when there was one to delete. A context whose conversation
 * is gone gets a fresh one the next time it is opened.
 */
export function deleteChat(db: Db, chatId: string): boolean {
  const existing = db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).get();
  if (!existing) return false;
  db.transaction((tx) => {
    tx.delete(chatFiles).where(eq(chatFiles.chatId, chatId)).run();
    tx.delete(chatMessages).where(eq(chatMessages.chatId, chatId)).run();
    tx.delete(chats).where(eq(chats.id, chatId)).run();
  });
  return true;
}
