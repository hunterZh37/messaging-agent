/** Host, port and flavour of one mailbox. Stored on the account row, never in .env. */
export interface ImapSettings {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** "gmail" uses Gmail's label extension; "generic" uses plain IMAP keywords. */
  kind: "gmail" | "generic";
}

export interface ImapCredentials {
  username: string;
  /** An app password, or nothing when the account signs in with Google. */
  password?: string;
  /** A fresh OAuth access token, asked for at connect time (Sign in with Google, 2026-09-11). */
  accessToken?: () => Promise<string>;
}

export interface ImapMessage {
  uid: number;
  source: Buffer;
  gmailThreadId?: string;
  gmailLabels?: string[];
  /** The \\Seen flag as the server holds it (2026-09-14): read already, somewhere else. */
  seen?: boolean;
}

/**
 * The only surface the rest of core uses to talk to an IMAP server.
 * Tests substitute FakeImapClient. Production uses createImapClient.
 */
export interface ImapClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  /**
   * Resolves the special-use folder paths for Inbox, Sent, Trash and Junk
   * (spec 10a). Everything but Inbox is null on a server that reports no such
   * folder; Gmail exposes `[Gmail]/Trash` and `[Gmail]/Spam` with the flags.
   */
  folders(): Promise<{ inbox: string; sent: string | null; trash: string | null; junk: string | null }>;
  /**
   * Messages with uid > afterUid, or every message since sinceDate when
   * afterUid is null. Fetches with BODY.PEEK, so nothing is marked read.
   */
  fetchNew(folder: string, afterUid: number | null, sinceDate: Date | null): Promise<{ uidValidity: number; messages: ImapMessage[] }>;
  /**
   * Messages older than what is already stored: uid < beforeUid (null for no
   * floor), and no earlier than sinceDate (null for the whole mailbox).
   * BODY.PEEK like fetchNew.
   */
  fetchOlder(folder: string, beforeUid: number | null, sinceDate: Date | null): Promise<{ uidValidity: number; messages: ImapMessage[] }>;
  /**
   * The whole RFC822 source of one message, or null when the uid is gone.
   * BODY.PEEK like fetchNew, so reading an attachment never marks mail read.
   */
  fetchSource(folder: string, uid: number): Promise<Buffer | null>;
  /** Gmail: X-GM-LABELS. Generic servers: IMAP keywords. Adds only, never removes. */
  addLabels(folder: string, uid: number, labels: string[]): Promise<void>;
  /**
   * The \\Seen flag of each uid, for mail already stored (2026-09-14): what
   * the operator read on their phone since the last sync. Uids the server no
   * longer has are left out.
   */
  fetchFlags(folder: string, uids: number[]): Promise<Map<number, boolean>>;
  /**
   * Moves uids out of `folder` and into `destination` (spec 10a,
   * 2026-09-11). MOVE where the server has it; COPY, `\Deleted` and an
   * EXPUNGE of just those uids where it does not, which is the same journey
   * in three steps. Answers with old uid -> new uid in `destination`, from
   * the server's UIDPLUS response; an empty map when the server has no
   * UIDPLUS, so the id is left as it was and a restore falls back to
   * findByMessageId to learn where the message actually landed.
   */
  move(folder: string, uids: number[], destination: string): Promise<Map<number, number>>;
  /**
   * The uid of the message carrying this Message-ID header in `folder`, or
   * null when there is none (spec 10a, 2026-09-11). The fallback a restore
   * uses when the stored id gives no working uid to move.
   */
  findByMessageId(folder: string, rfcMessageId: string): Promise<number | null>;
}

export interface SmtpClient {
  send(msg: {
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    text: string;
    /** The HTML half of a multipart reply, absent when the draft is plain (operator, 2026-09-20). */
    html?: string;
    inReplyTo: string | null;
    references: string | null;
    /** nodemailer's own shape, absent when the draft carried no files (spec 8, 2026-09-10). */
    attachments?: { filename: string; content: Buffer; contentType: string }[];
  }): Promise<{ messageId: string }>;
}

export const GMAIL_SETTINGS: ImapSettings = {
  imapHost: "imap.gmail.com",
  imapPort: 993,
  smtpHost: "smtp.gmail.com",
  smtpPort: 465,
  kind: "gmail",
};
