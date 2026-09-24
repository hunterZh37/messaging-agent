import type { Blocklist } from "../blocklist";
import type { Db } from "../db/client";
import type { AccountRow, AttachmentRow, MailFolder } from "../db/schema";

/**
 * One kept attachment of a message, before it reaches the database.
 * `bytes` is set when the transport already delivered them (IMAP hands over
 * the whole RFC822 source at sync); null when they must be fetched later
 * (Outlook delivers metadata only).
 */
export interface NormalizedAttachment {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
  providerAttachmentId: string | null;
  bytes: Buffer | null;
}

/**
 * Tiny inline images (signatures, tracking pixels) are noise, so spec 11a
 * drops any inline part under 20 KB from both attachment lists.
 */
export const INLINE_SKIP_BYTES = 20480;

/**
 * Is this part a file the operator would recognise as an attachment?
 *
 * Two things are dropped. Inline parts under 20 KB are signatures and
 * tracking pixels (spec 11a). A nameless `text/*` part is a body
 * alternative, not a file: mailparser hands back Gmail's `text/x-amp-html`
 * copy of the message as an "attachment", and storing it produced a 139 KB
 * `attachment-0` chip on ordinary mail.
 */
export function keepAttachment(p: { filename: string | null; mimeType: string; inline: boolean; size: number }): boolean {
  if (!p.filename && p.mimeType.toLowerCase().startsWith("text/")) return false;
  return !(p.inline && p.size < INLINE_SKIP_BYTES);
}

/**
 * One mail message reduced to the shape the rest of core stores and reasons
 * about. Every connector's normalizer produces this, whatever the transport.
 */
export interface NormalizedMessage {
  providerMessageId: string;
  providerThreadId: string;
  rfcMessageId: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  bodyText: string;
  /** Sanitized HTML for display; null when the source had no HTML part. Never fed to the sorter or drafter. */
  bodyHtml: string | null;
  snippet: string | null;
  /** Filenames of `attachments`, derived from it so the two never disagree. */
  attachmentNames: string[];
  attachments: NormalizedAttachment[];
  /** Which provider folder it came from (spec 10a): inbox, sent, trash or junk. */
  folder: MailFolder;
  sentAt: number;
  labelIds: string[];
  /** Set by a channel that knows who wrote it (a text's is_from_me); mail leaves it to the operator's addresses. */
  isFromOperator?: boolean;
  /** A group message that @mentions the operator (spec 10g). */
  mentionsOperator?: boolean;
  /**
   * Already read where it came from (2026-09-14): IMAP's \\Seen, Graph's
   * isRead. Mail the operator read on their phone or years ago in Gmail is
   * not unopened here; storing it marks its thread opened up to it.
   */
  read?: boolean;
}

export interface SyncOptions {
  backfillDays: number;
  /**
   * How far back the first sync of an account should reach, epoch ms; null
   * for the whole mailbox. Overrides `backfillDays` when set.
   */
  backfillTo?: number | null;
  blocklist: Blocklist;
  clock?: () => number;
}

/** What a deliberate reach further back needs: the depth to reach, and the blocklist to apply on the way in. */
export interface BackfillOptions {
  /** Epoch ms of the oldest date to fetch; null for the whole mailbox. */
  to: number | null;
  blocklist: Blocklist;
  clock?: () => number;
}

export interface SyncResult {
  mode: "backfill" | "history";
  fetched: number;
  stored: number;
  blocked: number;
  failed: number;
}

/** One file going out with a reply: the bytes are in hand by the time a sender sees it. */
export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * A sender that can also begin a conversation. Mail can; a chat cannot yet
 * (spec 2026-09-22). Naming it separately is what makes a connector that
 * forwards only `sendReply` a compile error rather than a send that fails in
 * front of the operator: compose reached the wrapper in connectors/index.ts,
 * which passed on `sendReply` alone, and every composed mail was refused with
 * "this channel cannot start a new conversation yet" (2026-09-23).
 */
export interface MailSender extends Sender {
  sendNew(p: {
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    html?: string;
    attachments?: OutgoingAttachment[];
  }): Promise<{ id: string }>;
}

export interface Sender {
  /**
   * Starts a conversation: a message with nothing above it, so no In-Reply-To,
   * no References and no provider thread (compose, 2026-09-22). Absent on a
   * channel that cannot begin one yet — iMessage and WhatsApp, whose compose
   * lands in its own change — and the send refuses rather than guessing a
   * conversation to put it in.
   */
  sendNew?(p: {
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    /** The same words as HTML, when the operator marked any (see sendReply). */
    html?: string;
    attachments?: OutgoingAttachment[];
  }): Promise<{ id: string }>;

  /** Sends an in-thread reply. Returns the provider message id of the sent message. */
  sendReply(p: {
    replyToProviderMessageId: string;
    providerThreadId: string;
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    inReplyTo: string | null;
    body: string;
    /**
     * The same reply as HTML, when it carries emphasis (operator, 2026-09-20).
     * Absent when the draft is plain, so a reply with nothing marked goes out
     * exactly as it always did rather than as HTML that happens to look plain.
     * `body` is always the readable text, marks stripped, and both parts are
     * sent: nobody is ever shown the asterisks.
     */
    html?: string;
    /** Files the operator put on the draft (spec 8, 2026-09-10). Empty, or absent, for a reply that carries none. */
    attachments?: OutgoingAttachment[];
  }): Promise<{ id: string }>;
}

export interface MailConnector {
  sync(db: Db, account: AccountRow, opts: SyncOptions): Promise<SyncResult>;
  /**
   * Reaches back past what this account has already synced, down to
   * `opts.to`. Never advances the incremental watermark: new mail is still
   * the sync path's job.
   */
  backfill(db: Db, account: AccountRow, opts: BackfillOptions): Promise<SyncResult & { mode: "backfill" }>;
  applyLabels(db: Db, accountId: string): Promise<{ labeled: number; failed: number }>;
  /** The bytes of one attachment, straight from the provider. Callers cache them; this does not. */
  fetchAttachment(db: Db, account: AccountRow, att: AttachmentRow): Promise<Buffer>;
  /**
   * Moves these stored messages to the provider's own Trash (spec 10a,
   * 2026-09-11). The second write that reaches the world, and gated exactly
   * as a send is: nothing calls this until the operator has clicked and the
   * six seconds have run out. Nothing is destroyed — Gmail and Outlook keep
   * a deleted message for about thirty days — and each message that moves
   * has its row filed under Trash and an action recorded for it. A message
   * the provider refuses is counted in `failed` and left where it is.
   */
  trash(db: Db, account: AccountRow, messageIds: string[]): Promise<{ moved: number; failed: number }>;
  /**
   * Moves these stored messages back out of the provider's Trash, to Inbox
   * (spec 10a, 2026-09-11): undo delete. The mirror of `trash`, gated the
   * same way — nothing calls this before the operator's own Cmd-Z. A
   * message the provider refuses is counted in `failed` and left in Trash.
   */
  restore(db: Db, account: AccountRow, messageIds: string[]): Promise<{ moved: number; failed: number }>;
  sender: Sender;
}

/**
 * Thrown when an account's own credentials are the problem: no stored token,
 * an explicitly disconnected account, or a refresh that failed with
 * `invalid_grant` / 400 / 401. The pipeline catches this (and only this) to
 * flip `accounts.status` to `needs_signin` — every other error (missing
 * developer credentials in `.env`, a transient network failure) is left as a
 * plain Error so it doesn't wrongly tell the operator to re-sign-in.
 */
export class AccountAuthError extends Error {
  accountId: string;

  constructor(accountId: string, message: string) {
    super(message);
    this.name = "AccountAuthError";
    this.accountId = accountId;
  }
}
