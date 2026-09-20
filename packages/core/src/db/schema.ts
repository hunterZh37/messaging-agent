import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import type { Citation, ProposedAction } from "../chat/types";
import type { SortResult } from "../sort/types";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  provider: text("provider", { enum: ["imap", "outlook", "imessage", "whatsapp"] }).notNull(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  createdAt: integer("created_at").notNull(),
  status: text("status", { enum: ["ok", "needs_signin", "disconnected"] }).notNull().default("ok"),
  lastError: text("last_error"),
  // Set for imap accounts only; null for outlook, which goes over Graph.
  imapHost: text("imap_host"),
  imapPort: integer("imap_port"),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  /** Drives the label strategy (Gmail labels vs IMAP keywords) and the connect copy. */
  kind: text("kind", { enum: ["gmail", "generic"] }),
  /**
   * How far back this account has been synced, epoch ms of the oldest date
   * covered. `0` means the whole mailbox; null means nothing beyond the
   * initial window (spec 5, "Backfill and retention").
   */
  backfilledSince: integer("backfilled_since"),
});

/**
 * IMAP/SMTP app passwords. Never in .env, never exported by exportJsonl,
 * never returned to a browser.
 */
export const mailCredentials = sqliteTable("mail_credentials", {
  accountId: text("account_id").primaryKey().references(() => accounts.id),
  username: text("username").notNull(),
  password: text("password").notNull(),
});

export const oauthTokens = sqliteTable("oauth_tokens", {
  accountId: text("account_id").primaryKey().references(() => accounts.id),
  refreshToken: text("refresh_token").notNull(),
  accessToken: text("access_token"),
  expiryDate: integer("expiry_date"),
  scope: text("scope"),
});

/**
 * Which mailbox folder a message lives in (spec 10a, "Folder tree"). Trash
 * and Junk are the providers' own folders: synced under the same window
 * rules as the rest, never sorted.
 */
/** The four mail folders, plus the one texts live in (2026-09-11). */
export type MailFolder = "inbox" | "sent" | "trash" | "junk" | "messages";

export const MAIL_FOLDERS: MailFolder[] = ["inbox", "sent", "trash", "junk"];

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(), // `${accountId}:${providerMessageId}`
    accountId: text("account_id").notNull().references(() => accounts.id),
    providerMessageId: text("provider_message_id").notNull(),
    threadId: text("thread_id").notNull(), // `${accountId}:${providerThreadId}`
    rfcMessageId: text("rfc_message_id"),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    toAddresses: text("to_addresses", { mode: "json" }).$type<string[]>().notNull(),
    ccAddresses: text("cc_addresses", { mode: "json" }).$type<string[]>().notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    snippet: text("snippet"),
    attachmentNames: text("attachment_names", { mode: "json" }).$type<string[]>().notNull(),
    isFromOperator: integer("is_from_operator", { mode: "boolean" }).notNull(),
    /** A group chat's message that @mentions the operator (spec 10g, 2026-09-11): what makes a group need a reply. */
    mentionsOperator: integer("mentions_operator", { mode: "boolean" }).notNull().default(false),
    /** The provider folder this message came from (spec 10a). Defaults to inbox, which is what every row held before folders existed. */
    folder: text("folder", { enum: ["inbox", "sent", "trash", "junk", "messages"] }).notNull().default("inbox"),
    sentAt: integer("sent_at").notNull(), // epoch ms
    receivedAt: integer("received_at").notNull(), // epoch ms when we stored it
  },
  (t) => [
    index("messages_thread_idx").on(t.threadId),
    index("messages_sent_at_idx").on(t.sentAt),
    index("messages_folder_idx").on(t.folder),
    // "The newest message in its thread" is asked once per row by every list
    // and by the tree's Unopened count; with this it is one seek per thread
    // instead of a sort per row (operator, 2026-09-11: a click took seconds).
    index("messages_thread_sent_idx").on(t.threadId, t.sentAt, t.id),
  ],
);

/**
 * One kept attachment per row (spec 11a). Bytes live on disk under
 * `cfg.blobsDir/<sha256>`, never in SQLite. `sha256`/`path`/`fetchedAt` stay
 * null until the bytes are there: IMAP fills them at sync, Outlook on the
 * first open or download.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(), // `${messageId}:${index}`
    messageId: text("message_id").notNull().references(() => messages.id),
    /** Position among the message's kept attachments, 0-based. */
    index: integer("index").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    /** Graph attachment id for Outlook; null for IMAP, whose bytes come from the RFC822 source. */
    providerAttachmentId: text("provider_attachment_id"),
    sha256: text("sha256"),
    path: text("path"),
    fetchedAt: integer("fetched_at"),
  },
  (t) => [index("attachments_message_idx").on(t.messageId)],
);

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  providerThreadId: text("provider_thread_id").notNull(),
  subject: text("subject").notNull(),
  lastMessageAt: integer("last_message_at").notNull(),
  lastFromOperator: integer("last_from_operator", { mode: "boolean" }).notNull(),
  /** When the operator said this thread is not waiting on an answer after all (spec 10a); null while it may be. */
  waitingDismissedAt: integer("waiting_dismissed_at"),
  /**
   * When the operator hid the thread (2026-09-15): it stays in Inbox and
   * Messages and leaves Need to reply, Unopened, No need to reply and Safe to
   * delete, until they unhide it or the other side writes again. Null while
   * it is not hidden.
   */
  hiddenAt: integer("hidden_at"),
});

/**
 * The phones and browsers that asked for notifications (2026-09-14): one Web
 * Push subscription each, keyed by the push service's endpoint. A push the
 * service answers with "gone" deletes its row.
 */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: integer("created_at").notNull(),
});

/** Names for the handles Messages knows people by, from the address book on this Mac (2026-09-11). */
export const contacts = sqliteTable("contacts", {
  handle: text("handle").primaryKey(),
  name: text("name").notNull(),
  refreshedAt: integer("refreshed_at").notNull(),
});

export const watermarks = sqliteTable("watermarks", {
  accountId: text("account_id").primaryKey().references(() => accounts.id),
  historyId: text("history_id").notNull(),
  lastSyncAt: integer("last_sync_at").notNull(),
});

/**
 * The one thing a message wants from the operator (operator, 2026-09-19).
 *
 * In order, and the order is the precedence: a message that is owed a reply
 * is `reply` whatever else is also true of it. This replaced `important`,
 * `needs_reply` and `disposable`, which were three independent booleans and
 * could therefore contradict each other — owed a reply and safe to delete at
 * the same time — with which list the message appeared on decided by
 * whichever query asked first.
 */
export const WANTS = ["reply", "action", "knowing", "bin"] as const;
export type Wants = (typeof WANTS)[number];

export const sorts = sqliteTable("sorts", {
  messageId: text("message_id").primaryKey().references(() => messages.id),
  wants: text("wants", { enum: WANTS }).notNull(),
  /** A fact about the message, not a claim on the operator: it proposes, asks for or changes a time. */
  scheduling: integer("scheduling", { mode: "boolean" }).notNull(),
  /** Operator sub-category; null when the message is not worth surfacing (spec 7). */
  category: text("category"),
  /**
   * Which way money moves in this message, its own axis beside the rung
   * (spec 7): `income`, `expense`, or `none`. Judged for every message, so
   * a receipt is found whether or not it was worth surfacing.
   */
  finance: text("finance").notNull().default("none"),
  reason: text("reason").notNull(),
  model: text("model").notNull(),
  labeledAt: integer("labeled_at"),
  createdAt: integer("created_at").notNull(),
});

/**
 * Operator-defined sub-categories under Important (spec 7). Edited in the
 * app, ordered by `position` (order is priority). `sorts.category` stores
 * the name, not the id, so a sort keeps meaning even after a rename or
 * delete rewrites it.
 */
export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  position: integer("position").notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * Groups of projects in one inbox (operator, 2026-09-15: "categorize the 12
 * projects into 3 bigger projects… when I click on admin, I still want to see
 * the sub-projects"). A group files nothing itself: mail stays under its
 * project, and picking a group shows every project in it. So a group costs no
 * re-sort, and the sorter never sees one.
 */
export const projectGroups = sqliteTable("project_groups", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  name: text("name").notNull(),
  position: integer("position").notNull(),
  createdAt: integer("created_at").notNull(),
});

/**
 * Operator-defined projects, one list per inbox (spec 10d, amended
 * 2026-09-08). Ordered by `position`. Unlike sub-categories, assignments
 * point at the id, so a rename never touches a single filed message.
 * `groupId` is the group it sits in, if any (2026-09-15).
 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  name: text("name").notNull(),
  description: text("description").notNull(),
  position: integer("position").notNull(),
  createdAt: integer("created_at").notNull(),
  groupId: text("group_id").references(() => projectGroups.id),
});

/**
 * Which project a message belongs to. A null `projectId` is Unfiled, stated
 * out loud so the automatic pass knows it has already looked at this
 * message. `source` guards the operator's own filings: the pass only ever
 * rewrites rows it wrote itself.
 */
export const projectAssignments = sqliteTable(
  "project_assignments",
  {
    messageId: text("message_id").primaryKey().references(() => messages.id),
    projectId: text("project_id").references(() => projects.id),
    source: text("source", { enum: ["auto", "manual", "sorter"] }).notNull(),
    /** Best cosine similarity behind an automatic filing; null for a manual one. */
    score: real("score"),
    assignedAt: integer("assigned_at").notNull(),
  },
  (t) => [index("project_assignments_project_idx").on(t.projectId)],
);

/**
 * Which messages already have a vector in `message_embeddings`. The vec0
 * virtual table is invisible to drizzle, so this is the table the pending
 * query can join against.
 */
export const embeddingState = sqliteTable("embedding_state", {
  messageId: text("message_id").primaryKey(),
  embeddedAt: integer("embedded_at").notNull(),
  /**
   * sha256 of the text the vector was made from (spec 10d). Null for a row
   * written before the text rules existed, which counts as stale: changing
   * how a message is reduced to text has to re-embed it, or old vectors and
   * new ones would be compared as if they said the same thing.
   */
  textHash: text("text_hash"),
});

/**
 * The operator's other addresses (spec 10a). Mail from one of these is theirs
 * however it arrived: it sits on the right of a thread, is never sorted, and
 * is never drafted a reply. One row per address, lowercased, so a list is a
 * set and matching is a lookup.
 */
export const operatorAliases = sqliteTable("operator_aliases", {
  address: text("address").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

/**
 * When the operator last opened a thread (spec 10a). A thread is unread when
 * something inbound has arrived since — or when it has no row here at all,
 * which is every thread until they open it. Nothing is written at sync time:
 * "opened" is a fact about the operator, not about the mail.
 */
export const threadOpens = sqliteTable("thread_opens", {
  threadId: text("thread_id").primaryKey().references(() => threads.id),
  openedAt: integer("opened_at").notNull(),
});

export const drafts = sqliteTable("drafts", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => threads.id),
  replyToMessageId: text("reply_to_message_id").notNull().references(() => messages.id),
  originalText: text("original_text").notNull(),
  finalText: text("final_text"),
  toAddresses: text("to_addresses", { mode: "json" }).$type<string[]>().notNull(),
  ccAddresses: text("cc_addresses", { mode: "json" }).$type<string[]>().notNull(),
  // "declined": the drafter said the mail asks nothing (2026-09-11); the
  // reason sits in original_text and the message is not drafted again.
  status: text("status", { enum: ["pending", "sent", "skipped", "failed", "declined"] }).notNull(),
  /**
   * What this draft is: an answer to something inbound, or a nudge after the
   * operator's own last message went unanswered (spec 6). The queue says
   * which, because they are read differently.
   */
  mode: text("mode", { enum: ["reply", "follow-up"] }).notNull().default("reply"),
  model: text("model").notNull(),
  sentProviderMessageId: text("sent_provider_message_id"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * "Revise with Celeste" (spec 8, 2026-09-10): one row per instruction the
 * operator gave a draft, with the text before and after. Append-only, and
 * beside the draft rather than in it: the card's text is still whatever the
 * operator sends, so a revision is history, not the draft itself.
 */
export const draftRevisions = sqliteTable(
  "draft_revisions",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").notNull().references(() => drafts.id),
    instruction: text("instruction").notNull(),
    before: text("before").notNull(),
    after: text("after").notNull(),
    model: text("model").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("draft_revisions_draft_idx").on(t.draftId, t.createdAt)],
);

/**
 * A file the operator put on an outgoing draft (spec 8, 2026-09-10): dropped
 * on the Ask panel or the card, sent with the reply when they press Send, and
 * nowhere near a provider before that. The bytes live where every other
 * attachment's do, content-addressed under `cfg.blobsDir` (spec 11a), so the
 * same PDF on three drafts is one file on disk. `textExcerpt` is what Celeste
 * reads: the PDF's text layer, and null for anything else or for a scan with
 * no text in it.
 */
export const draftAttachments = sqliteTable(
  "draft_attachments",
  {
    id: text("id").primaryKey(),
    draftId: text("draft_id").notNull().references(() => drafts.id),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    path: text("path").notNull(),
    textExcerpt: text("text_excerpt"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("draft_attachments_draft_idx").on(t.draftId, t.createdAt)],
);

// Append-only. Nothing in this codebase updates or deletes rows here.
export const actions = sqliteTable(
  "actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["send", "edit_send", "skip", "send_failed", "handled", "trash", "hide", "restore"] }).notNull(),
    draftId: text("draft_id"),
    messageId: text("message_id"),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  // Every folder query joins the handled actions by message (stress loop,
  // 2026-09-11: without this, a count over 50,000 texts scanned the whole
  // table once per message).
  (t) => [index("actions_message_kind_idx").on(t.messageId, t.kind)],
);

/**
 * One Ask Celeste conversation (spec 10c, 2026-09-10). A thread gets its own,
 * drafts included — a draft is a reply in its thread — and everything asked
 * outside one lands in General. `closedAt` is set when the operator starts a
 * fresh conversation in the same context: the old one stays in History but is
 * no longer the one that thread opens to.
 */
export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["general", "thread"] }).notNull().default("general"),
  threadId: text("thread_id"),
  /** What History calls it: "General", or "<subject> · <counterpart>". */
  title: text("title").notNull().default("General"),
  createdAt: integer("created_at").notNull(),
  /** Bumped by every turn, so History reads newest-spoken-to first. */
  updatedAt: integer("updated_at").notNull().default(0),
  closedAt: integer("closed_at"),
});

/**
 * One turn. `contextThreadId` is the thread that was open when the operator
 * asked, `citations` the messages Celeste leaned on, `actions` what she
 * offered to do — offered, never done: every one of them waits for a click.
 */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => chats.id),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    contextThreadId: text("context_thread_id"),
    /**
     * The draft that was open on the card when the turn happened (spec 10c,
     * 2026-09-10), so an "Apply to draft" button offered a week ago knows
     * which draft it was about and greys out when that is not the one on
     * screen any more.
     */
    contextDraftId: text("context_draft_id"),
    citations: text("citations", { mode: "json" }).$type<Citation[]>(),
    actions: text("actions", { mode: "json" }).$type<ProposedAction[]>(),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("chat_messages_chat_idx").on(t.chatId, t.createdAt)],
);

/**
 * A file the operator gave a conversation (spec 10c, 2026-09-10): dropped on
 * the Ask panel, or picked with the +, whether or not a draft is open. The
 * bytes go where every other attachment's do, content-addressed under
 * `cfg.blobsDir` (spec 11a), so the same PDF given to Celeste and then
 * attached to a draft is one file on disk. `textExcerpt` is what she reads.
 */
export const chatFiles = sqliteTable(
  "chat_files",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull().references(() => chats.id),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    path: text("path").notNull(),
    textExcerpt: text("text_excerpt"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("chat_files_chat_idx").on(t.chatId, t.createdAt)],
);

/**
 * One comparison of two or more models on the same stored mail (spec 13).
 * An eval never touches `sorts`: the verdict the operator lives with stays
 * exactly where it is, and everything a candidate model said lands here.
 */
export const evalRuns = sqliteTable("eval_runs", {
  id: text("id").primaryKey(),
  /** Which seam was compared. Only "sorter" so far. */
  role: text("role").notNull(),
  /** The model refs that ran, formatted, in the order they were asked for. */
  models: text("models", { mode: "json" }).$type<string[]>().notNull(),
  sampleSize: integer("sample_size").notNull(),
  /** Null when the sample was drawn across every inbox. */
  accountId: text("account_id").references(() => accounts.id),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
});

/**
 * What one model said about one message. The verdict already in `sorts` is
 * stored here too, under the model name "baseline", so a later re-sort
 * cannot quietly change what a finished run was measured against.
 */
export const evalResults = sqliteTable(
  "eval_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => evalRuns.id),
    messageId: text("message_id").notNull().references(() => messages.id),
    model: text("model").notNull(),
    /** Null when the call failed; `error` says why. */
    output: text("output", { mode: "json" }).$type<SortResult>(),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    error: text("error"),
  },
  (t) => [index("eval_results_run_idx").on(t.runId, t.model)],
);

/**
 * Every call any role made to any model (spec 13, 2026-09-11). One row per
 * request the seam actually sent, tool loop included, so the totals on the
 * Usage page are the model bill and not an estimate of it. `chat_messages`
 * and `eval_results` keep their own tokens for their own screens; this is
 * the one place that adds them all up.
 *
 * A failed call is a row too, with `error` set and no tokens: what was
 * attempted is part of what happened.
 */
export const modelCalls = sqliteTable(
  "model_calls",
  {
    id: text("id").primaryKey(),
    at: integer("at").notNull(),
    /** sorter, sorter_backlog, drafter, chat, rules, propose, eval, embed. */
    role: text("role").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    kind: text("kind", { enum: ["structured", "text", "chat", "embed"] }).notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    /** Anthropic only, and only when the prompt cache was used. */
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    latencyMs: integer("latency_ms").notNull(),
    /** Null when nothing knows what this model costs; 0 for a local one. */
    costUsd: real("cost_usd"),
    /** Which inbox the work was for, when the caller knows. No foreign key: a
     * disconnected inbox must not take its history of spending with it. */
    accountId: text("account_id"),
    /** Whatever the call was about: a message id, a draft id, a chat id, an eval run id. */
    ref: text("ref"),
    error: text("error"),
  },
  (t) => [index("model_calls_at_idx").on(t.at), index("model_calls_role_idx").on(t.role, t.at)],
);

/**
 * What Celeste has handed to Alex off a thread (spec 10e): one row per attempt,
 * so a write that failed is on the thread with its reason and can be tried
 * again, and one that worked carries Alex's own id for reading the status back.
 */
export const alexItems = sqliteTable(
  "alex_items",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull().references(() => threads.id),
    kind: text("kind", { enum: ["actionable", "event"] }).notNull(),
    /** What the operator typed, shown on the thread whether or not the write landed. */
    title: text("title").notNull(),
    /** The day or instant the item is for, ISO 8601, as it was sent. */
    whenISO: text("when_iso").notNull(),
    /** The end of a timed item; null for an untimed actionable. */
    endISO: text("end_iso"),
    status: text("status", { enum: ["added", "failed"] }).notNull(),
    /** Alex's own id (`todoId` or `eventId`); null while it has not landed. */
    alexId: text("alex_id"),
    /** Why it did not land, in Alex's words, for the retry button to sit beside. */
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("alex_items_thread_idx").on(t.threadId, t.createdAt)],
);

/**
 * How the operator's own writing read, one row per month (spec 14, added
 * 2026-09-17). Written by a local model over a sample of the operator's own
 * messages, and stored rather than recomputed: the reading costs minutes and
 * the months behind the current one never change.
 *
 * Only ever about the operator. Nothing here describes a correspondent, and
 * the sample the reading came from is the operator's own words with the
 * quoted thread stripped out.
 */
export const toneMonths = sqliteTable("tone_months", {
  /** `YYYY-MM` in the operator's own timezone, which is how the page groups. */
  month: text("month").primaryKey(),
  /** Two to four words for how the month reads. */
  tone: text("tone").notNull(),
  energy: text("energy", { enum: ["low", "steady", "high"] }).notNull(),
  warmth: text("warmth", { enum: ["guarded", "neutral", "warm"] }).notNull(),
  /** One sentence, the only free text the model is asked for. */
  note: text("note").notNull(),
  /** How many of the operator's messages the reading was drawn from. */
  sampled: integer("sampled").notNull(),
  /** Which model said it, so a reading from a swapped-out model is legible. */
  model: text("model").notNull(),
  readAt: integer("read_at").notNull(),
});

/**
 * One MBTI axis as a local model read it from the operator's own messages
 * (spec 14, added 2026-09-17), one row per axis.
 *
 * `agreement` is the point of the table. The read is taken several times over
 * different samples, and an axis the runs disagreed about is worth less than
 * one they all landed on; the model calls every axis "high" confidence either
 * way, so its own word for it cannot be the thing shown.
 */
export const psychAxes = sqliteTable("psych_axes", {
  /** "E/I", "S/N", "T/F", "J/P". */
  axis: text("axis").primaryKey(),
  /** The letter the operator claims for themselves on this axis. */
  letter: text("letter").notNull(),
  /** Whether their own messages bear that claim out. */
  verdict: text("verdict", { enum: ["supported", "mixed", "against"] }).notNull().default("mixed"),
  /** How many of the runs chose this letter, and how many there were. */
  agreement: integer("agreement").notNull(),
  runs: integer("runs").notNull(),
  confidence: text("confidence", { enum: ["low", "medium", "high"] }).notNull(),
  reasoning: text("reasoning").notNull(),
  model: text("model").notNull(),
  readAt: integer("read_at").notNull(),
});

/**
 * The messages an axis was decided on. The model cites them by their number
 * in the sample it was shown and never writes the text itself, so what
 * appears under a verdict is the operator's own message as it was sent, not
 * the model's memory of it.
 */
export const psychEvidence = sqliteTable(
  "psych_evidence",
  {
    id: text("id").primaryKey(),
    axis: text("axis").notNull(),
    messageId: text("message_id").notNull().references(() => messages.id),
    /** Whether this message argues for the operator's claim or against it. */
    side: text("side", { enum: ["for", "against"] }).notNull().default("for"),
    /** The message as it read once the quoted thread was stripped off it. */
    quote: text("quote").notNull(),
    sentAt: integer("sent_at").notNull(),
  },
  (t) => [index("psych_evidence_axis_idx").on(t.axis, t.sentAt)],
);

export type AccountRow = typeof accounts.$inferSelect;
export type MailCredentialsRow = typeof mailCredentials.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type AttachmentRow = typeof attachments.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type SortRow = typeof sorts.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectGroupRow = typeof projectGroups.$inferSelect;
export type ProjectAssignmentRow = typeof projectAssignments.$inferSelect;
export type DraftRow = typeof drafts.$inferSelect;
export type DraftRevisionRow = typeof draftRevisions.$inferSelect;
export type DraftAttachmentRow = typeof draftAttachments.$inferSelect;
export type ActionRow = typeof actions.$inferSelect;
export type OperatorAliasRow = typeof operatorAliases.$inferSelect;
export type ThreadOpenRow = typeof threadOpens.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatFileRow = typeof chatFiles.$inferSelect;
export type EvalRunRow = typeof evalRuns.$inferSelect;
export type EvalResultRow = typeof evalResults.$inferSelect;
export type ModelCallRow = typeof modelCalls.$inferSelect;
export type AlexItemRow = typeof alexItems.$inferSelect;
export type ToneMonthRow = typeof toneMonths.$inferSelect;
export type NewToneMonthRow = typeof toneMonths.$inferInsert;
/**
 * The type the operator says they are. Declared, not inferred: four readings
 * of the same archive produced four different types, so the letters are the
 * operator's claim and the app's job is to test it rather than to guess it
 * (operator, 2026-09-17).
 */
export const psychDeclared = sqliteTable("psych_declared", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  setAt: integer("set_at").notNull(),
});

export type PsychAxisRow = typeof psychAxes.$inferSelect;
export type PsychEvidenceRow = typeof psychEvidence.$inferSelect;
export type PsychDeclaredRow = typeof psychDeclared.$inferSelect;
