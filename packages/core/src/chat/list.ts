import { listInboxMessages, type FolderStatus } from "../queue/inbox";
import { listProjects } from "../projects/projects";
import { projects } from "../db/schema";
import { now as nowMs, type Db } from "../db/client";

/** The windows the operator's own chips offer, and so the ones Celeste can ask for. */
export type ChatWindow = "today" | "7d" | "30d" | "all";

/** What Celeste can ask a list for, mirroring the folder tree's child rows (spec 10a). */
export type ChatStatus = "unopened" | "needs_reply" | "waiting" | "no_reply";

/** The most rows one list returns. Past this it is a mailbox, not an answer. */
export const MAX_LIST_LIMIT = 50;

const DEFAULT_LIMIT = 20;

/**
 * Epoch ms a window starts at, or null for "all". Today is local midnight, so
 * it means the day the operator is having — the same reading the window chip
 * has in the app (spec 5).
 */
export function windowStartFor(window: ChatWindow, now: number = nowMs()): number | null {
  if (window === "all") return null;
  if (window === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - (window === "7d" ? 7 : 30) * 86_400_000;
}

export interface ListMailOptions {
  accountId?: string;
  since?: ChatWindow;
  status?: ChatStatus;
  /** inbox, sent, or messages: the Messages folder holds iMessage and WhatsApp chats (2026-09-11). */
  folder?: "inbox" | "sent" | "messages";
  /** A project by the operator's name for it, resolved against the scoped inbox. */
  project?: string;
  finance?: "income" | "expense";
  limit?: number;
  now?: number;
}

/** One row of a list, as the model reads it. */
export interface MailListRow {
  threadId: string;
  messageId: string;
  subject: string;
  channel: "mail" | "imessage" | "whatsapp";
  from: string;
  sentAt: string;
  unread: boolean;
  project: string | null;
}

/** A project the operator named that no inbox has, so the tool can say so instead of listing everything. */
export interface UnknownProject {
  unknownProject: string;
}

function resolveProject(db: Db, name: string, accountId: string | undefined): string | null {
  const wanted = name.trim().toLowerCase();
  const rows = accountId ? listProjects(db, accountId) : db.select().from(projects).all();
  return rows.find((p) => p.name.trim().toLowerCase() === wanted)?.id ?? null;
}

/**
 * What is in the mailbox right now (spec 10c): the answer to "anything new?",
 * "what have I not opened?", "what am I still waiting on?". It runs the same
 * query the folder pages run, so what Celeste says is what the operator would
 * see if they clicked the row themselves — not a second opinion built out of
 * search results.
 */
export function listMailForChat(db: Db, opts: ListMailOptions = {}): MailListRow[] | UnknownProject {
  const window = opts.since ?? "7d";
  // "Waiting for a reply" is a fact about sent mail, so asking for it asks
  // for the Sent folder whether or not the caller said so.
  const folder = opts.folder ?? (opts.status === "waiting" ? "sent" : "inbox");
  const since = windowStartFor(window, opts.now);

  let projectId: string | undefined;
  if (opts.project) {
    const found = resolveProject(db, opts.project, opts.accountId);
    if (!found) return { unknownProject: opts.project };
    projectId = found;
  }

  const status: FolderStatus | undefined = opts.status;
  // Chats belong to no inbox: the Messages folder ignores the selected
  // inbox here as it does on the page (2026-09-14).
  const rows = listInboxMessages(db, {
    folder,
    ...(opts.accountId && folder !== "messages" ? { accountId: opts.accountId } : {}),
    ...(status ? { status } : {}),
    ...(projectId ? { projectId } : {}),
    ...(opts.finance ? { finance: opts.finance } : {}),
    ...(since === null ? {} : { since }),
    limit: Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIST_LIMIT),
  });

  return rows.map((r) => ({
    threadId: r.thread.id,
    messageId: r.message.id,
    subject: r.message.subject || "(no subject)",
    channel: r.account.provider === "imessage" ? "imessage" : r.account.provider === "whatsapp" ? "whatsapp" : "mail",
    from: r.message.fromName ? `${r.message.fromName} <${r.message.fromAddress}>` : r.message.fromAddress,
    sentAt: new Date(r.message.sentAt).toISOString(),
    unread: r.unread,
    project: r.project?.name ?? null,
  }));
}
