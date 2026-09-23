"use server";

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  askCeleste,
  attachChatFileToDraft,
  conversationUsage,
  createChatClient,
  composeDraft,
  composeText,
  operatorNameFor,
  createDrafter,
  draftForThread,
  fileThreadsToProject,
  getThread,
  listChatFiles,
  listChatMessages,
  listChats,
  listDraftAttachments,
  loadPipelineInputs,
  providerForRole,
  openChatFor,
  schema,
  startNewChat,
  usageByConversation,
  type ChatMessageRow,
  type ChatRow,
  type ChatSummary,
  type ContextDraft,
  type ConversationUsage,
  deleteChat,
} from "@messaging-agent/core";
import { core } from "@/lib/core";
import { ACCOUNT_COOKIE, ACCOUNT_COOKIE_MAX_AGE, ASK_COOKIE, selectedAccountId } from "@/lib/selection";
import { markHandledAction } from "../inbox/actions";

type StepError = { error: string };

/** The inbox the operator has selected, so Celeste searches the mailbox they are looking at. */
async function selectedInbox(): Promise<string | undefined> {
  const jar = await cookies();
  const { db } = core();
  const accounts = db.select({ id: schema.accounts.id, email: schema.accounts.email, status: schema.accounts.status }).from(schema.accounts).all();
  return selectedAccountId(undefined, jar.get(ACCOUNT_COOKIE)?.value, accounts);
}

/** What the panel is looking at, and so which conversation it is having. */
export interface AskContext {
  threadId?: string | null;
}

/** A conversation and everything said in it, as the panel paints it. */
export interface OpenChat {
  chat: ChatRow;
  turns: ChatMessageRow[];
  /** What it has cost so far, for the line under the title (spec 13, 2026-09-11). */
  usage: ConversationUsage;
}

/** A History row, with what the conversation cost beside how much was said in it. */
export interface ChatHistoryRow extends ChatSummary {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

/**
 * The conversation for what the operator has open (spec 10c, 2026-09-10):
 * a thread's own, or General. Opening a thread the panel has never been used
 * on comes back empty, and opening it again comes back to what was said.
 */
export async function openChatAction(ctx: AskContext): Promise<OpenChat> {
  const { db } = core();
  const chat = openChatFor(db, ctx);
  return { chat, turns: listChatMessages(db, chat.id), usage: conversationUsage(db, chat.id) };
}

/** "New conversation": the one on screen is closed, and a blank one takes over. */
export async function startNewChatAction(ctx: AskContext): Promise<OpenChat> {
  const { db } = core();
  const chat = startNewChat(db, ctx);
  return { chat, turns: [], usage: conversationUsage(db, chat.id) };
}

/** History's ×: the conversation, its turns and its files are gone for good. */
export async function deleteChatAction(chatId: string): Promise<{ ok: true } | StepError> {
  const { db } = core();
  return deleteChat(db, chatId) ? { ok: true } : { error: "That conversation is already gone." };
}

/** History: every conversation anything was said in, spoken to last on top. */
export async function listChatsAction(): Promise<ChatHistoryRow[]> {
  const { db } = core();
  const spent = new Map(usageByConversation(db).map((u) => [u.chatId, u]));
  return listChats(db).map((chat) => {
    const u = spent.get(chat.id);
    return {
      ...chat,
      costUsd: u?.costUsd ?? 0,
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      estimated: u?.estimated ?? false,
    };
  });
}

/** One conversation from History, reopened where it left off. */
export async function readChatAction(chatId: string): Promise<OpenChat | StepError> {
  const { db } = core();
  const chat = db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).get();
  if (!chat) return { error: "That conversation is gone." };
  return { chat, turns: listChatMessages(db, chat.id), usage: conversationUsage(db, chat.id) };
}

/** One file in a conversation, as the chip beside the composer knows it. */
export interface ChatFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * The files the operator has given this conversation, for the chip row. Only
 * what a chip shows: the text read out of a PDF stays on this side, because
 * the browser has no use for it and Celeste reads it from here anyway.
 */
export async function listChatFilesAction(chatId: string): Promise<ChatFile[]> {
  return listChatFiles(core().db, chatId).map((f) => ({ id: f.id, filename: f.filename, mimeType: f.mimeType, size: f.size }));
}

/**
 * "Attach to draft" on one of those chips (spec 10c, 2026-09-10). The file the
 * operator already gave Celeste goes onto the card they have open: the same
 * blob and the same excerpt, copied rather than read again. This is the click
 * she cannot make for them — she can say a file belongs on the draft, and
 * nothing puts it there but this.
 */
export async function attachChatFileToDraftAction(chatId: string, fileId: string, draftId: string): Promise<{ file: ChatFile } | StepError> {
  try {
    const { cfg, db } = core();
    const row = attachChatFileToDraft(db, cfg, chatId, fileId, draftId);
    return { file: { id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size } };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * One question and the answer that comes back (spec 10c). The panel adds the
 * question to the transcript itself; what it needs back is Celeste's turn,
 * with the messages she cited and the actions she is offering. Which
 * conversation it joins is the panel's to say: it is already on the one the
 * open thread or draft belongs to.
 */
export async function askAction(
  chatId: string,
  question: string,
  contextThreadId: string | null,
  contextDraft?: ContextDraft,
): Promise<{ assistant: ChatMessageRow; usage: ConversationUsage } | StepError> {
  const trimmed = question.trim();
  if (!trimmed) return { error: "Ask something first." };
  try {
    const { cfg, db } = core();
    if (!cfg.anthropicApiKey) return { error: "No Anthropic API key is set, so Celeste cannot answer." };
    const accountId = await selectedInbox();
    // The files on the draft are read here rather than shipped up with the
    // question: the panel knows the card's text, but what is attached to it
    // is the database's to say, and a PDF's text never belongs in a browser.
    const draft = contextDraft
      ? {
          ...contextDraft,
          attachments: listDraftAttachments(db, contextDraft.draftId).map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
            textExcerpt: a.textExcerpt,
          })),
        }
      : undefined;
    // The conversation's own files, read here for the same reason the draft's
    // are: the panel knows their names, and what is inside them is the
    // database's to say.
    const contextFiles = listChatFiles(db, chatId).map((f) => ({
      filename: f.filename,
      mimeType: f.mimeType,
      size: f.size,
      textExcerpt: f.textExcerpt,
    }));
    const turn = await askCeleste(
      db,
      { client: createChatClient(cfg, db, { ref: chatId, ...(accountId ? { accountId } : {}) }), operatorName: cfg.operatorName },
      { chatId, question: trimmed, contextThreadId, contextFiles, ...(accountId ? { accountId } : {}), ...(draft ? { contextDraft: draft } : {}) },
    );
    // The running total rides back with the answer: the line under the title
    // is right again without the panel asking a second time.
    return { assistant: turn.assistant, usage: conversationUsage(db, chatId) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** The sidebar row and ⌘/: remembers the panel open across navigation and reloads. */
export async function setAskOpenAction(open: boolean): Promise<void> {
  const jar = await cookies();
  if (open) jar.set(ASK_COOKIE, "1", { httpOnly: false, sameSite: "lax", path: "/", maxAge: ACCOUNT_COOKIE_MAX_AGE });
  else jar.delete(ASK_COOKIE);
}

/**
 * A proposed "Draft a reply" or "Follow up", clicked. The thread view's own
 * button sends the operator to the queue; here the answer stays on screen and
 * the drafts become a link under it, so one question can leave several
 * behind. Which of the two each one writes is the thread's to say, not
 * Celeste's: a nudge when the operator sent last, an answer when they did not.
 *
 * Several threads are drafted one after another, because each is a model call
 * and the queue they land in is read in order anyway.
 */
export async function askDraftAction(threadIds: string[], instruction?: string): Promise<{ draftIds: string[]; failed: number; error?: string } | StepError> {
  try {
    const { cfg, db } = core();
    const { voice } = await loadPipelineInputs(cfg);
    const drafter = createDrafter(cfg, db);
    const draftIds: string[] = [];
    let failed = 0;
    let firstError: string | undefined;
    for (const threadId of threadIds) {
      // Asked for in so many words, so the drafter is not offered the way
      // out it has on an automated notice (2026-09-11).
      // What they said the draft should say rides along (2026-09-14): the
      // drafter used to see the thread alone and wrote its own reply.
      const result = await draftForThread(db, drafter, voice, threadId, { force: true, ...(instruction ? { instruction } : {}) });
      if (!("draftId" in result)) {
        failed++;
        firstError ??= "error" in result ? result.error : result.declined;
        continue;
      }
      draftIds.push(result.draftId);
    }
    if (draftIds.length === 0) return { error: firstError ?? "Nothing to draft." };
    revalidatePath("/drafts");
    return { draftIds, failed, ...(firstError ? { error: firstError } : {}) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}


/**
 * A proposed "Draft mail to <someone>", clicked (operator, 2026-09-22).
 *
 * The refusal this replaces was Celeste's own: asked to write to two people it
 * had no thread with, it explained that its action tool needed one. A composed
 * draft needs no thread. The words are written here and the draft lands in the
 * queue; nothing reaches anybody until the operator sends it from there.
 */
export async function askComposeAction(p: {
  to: string[];
  cc?: string[];
  subject: string;
  instruction?: string;
}): Promise<{ draftIds: string[]; failed: number; error?: string } | StepError> {
  try {
    const { cfg, db } = core();
    // Mail only: a chat cannot be composed into yet (spec 2026-09-22), and a
    // composed draft on a chat account would queue a message that can never go.
    const mail = db
      .select({ id: schema.accounts.id, provider: schema.accounts.provider, email: schema.accounts.email, status: schema.accounts.status })
      .from(schema.accounts)
      .all()
      .filter((a) => a.provider !== "imessage" && a.provider !== "whatsapp");
    if (mail.length === 0) return { error: "No mail account to send from." };
    const selected = await selectedInbox();
    const account = mail.find((a) => a.id === selected) ?? mail[0]!;

    const { voice } = await loadPipelineInputs(cfg);
    const text = p.instruction?.trim()
      ? await composeText(providerForRole("drafter", cfg, db, { accountId: account.id }), voice, {
          instruction: p.instruction,
          // Without this the mail signs off with a name nobody has: the
          // model invents one when the thread cannot tell it (2026-09-22).
          fromName: operatorNameFor(db, account.id),
          subject: p.subject,
          to: p.to,
          ...(p.cc ? { cc: p.cc } : {}),
        })
      : "";
    const draft = composeDraft(db, {
      accountId: account.id,
      to: p.to,
      ...(p.cc ? { cc: p.cc } : {}),
      subject: p.subject,
      text,
      model: cfg.models.drafter.model,
    });
    revalidatePath("/drafts");
    return { draftIds: [draft.id], failed: 0 };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * A proposed "File to <project>", clicked. Celeste proposes the operator's
 * word for a project, not an id, so it is resolved per inbox here; when she
 * proposed one that does not exist, the click is what makes it.
 */
export async function askFileAction(threadIds: string[], projectName: string, create: boolean): Promise<{ filed: number; created: number } | StepError> {
  try {
    const { db } = core();
    const result = fileThreadsToProject(db, threadIds, projectName, { create });
    if ("error" in result) return result;
    revalidatePath("/inbox");
    return result;
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** A proposed "Mark handled", clicked: each thread's newest inbound message is what gets marked. */
export async function askMarkHandledAction(threadIds: string[]): Promise<{ marked: number; failed: number } | StepError> {
  const { db } = core();
  let marked = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const threadId of threadIds) {
    const view = getThread(db, threadId);
    const latestInbound = view ? [...view.messages].reverse().find((m) => !m.isFromOperator) : undefined;
    if (!latestInbound) {
      // Nothing of anyone else's in it, so there is nothing to mark handled.
      failed++;
      firstError ??= view ? "That thread is only your own mail." : "Thread not found.";
      continue;
    }
    const result = await markHandledAction(latestInbound.id);
    if ("error" in result) {
      failed++;
      firstError ??= result.error;
      continue;
    }
    marked++;
  }
  if (marked === 0) return { error: firstError ?? "Nothing to mark." };
  return { marked, failed };
}
