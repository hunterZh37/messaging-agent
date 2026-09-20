export interface GraphEmailAddress {
  emailAddress?: { address?: string; name?: string };
}

export interface GraphAttachment {
  id?: string;
  name?: string;
  size?: number;
  contentType?: string;
  isInline?: boolean;
}

export interface GraphMessage {
  /** A delta tombstone: the message left this folder (deleted or moved). No other field is set. */
  "@removed"?: { reason?: string };
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
  from?: GraphEmailAddress;
  toRecipients?: GraphEmailAddress[];
  ccRecipients?: GraphEmailAddress[];
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  attachments?: GraphAttachment[];
  categories?: string[];
  isDraft?: boolean;
  /** Read already in Outlook (2026-09-14); a delta carries the change when the operator reads it on their phone. */
  isRead?: boolean;
}

/** The four mailboxes a sync walks (spec 10a); the same set as core's `MailFolder`. */
export type OutlookFolder = "inbox" | "sent" | "trash" | "junk";

/**
 * The only surface the rest of core uses to talk to Microsoft Graph.
 * Tests substitute FakeOutlookClient. Production uses createOutlookClient.
 */
export interface OutlookClient {
  getProfile(): Promise<{ email: string }>;
  /** "expired" when Graph returns 410 Gone for a stale delta link. */
  delta(folder: OutlookFolder, deltaLink: string | null, sinceIso: string | null): Promise<{ messages: GraphMessage[]; removed?: string[]; deltaLink: string } | "expired">;
  /**
   * Every message in a folder no earlier than `sinceIso` (null for the whole
   * folder), newest first, following `@odata.nextLink` to the end. Used to
   * reach back past what delta already covers.
   */
  listMessages(folder: OutlookFolder, sinceIso: string | null): Promise<GraphMessage[]>;
  /**
   * Moves one message to another well-known folder (spec 10a, 2026-09-11):
   * `trash` is Graph's `deleteditems`, where a deleted message waits about
   * thirty days. Graph gives the moved message a new id in its new folder;
   * that id is returned so a restore later knows where to look.
   */
  moveMessage(messageId: string, destination: OutlookFolder): Promise<{ id: string }>;
  /**
   * Where a message is now, by its Message-ID header (2026-09-14): Graph gives
   * a message a new id whenever it changes folder, so an id stored before a
   * move made in Outlook itself answers 404. `trash` and `inbox` are named;
   * any other folder is `other`. Null when the mailbox no longer has it.
   */
  findMessage(rfcMessageId: string): Promise<{ id: string; folder: OutlookFolder | "other" } | null>;
  ensureCategory(name: string): Promise<void>;
  addCategories(messageId: string, names: string[]): Promise<void>;
  /**
   * One message's body as Graph holds it, HTML when the sender wrote HTML.
   * Used to re-pull bodies that an earlier sync stored as text only.
   */
  getBody(messageId: string): Promise<{ contentType: string; content: string }>;
  /** Raw bytes of one attachment ($value). Goes through the same auth/refresh path as everything else. */
  getAttachmentBytes(messageId: string, attachmentId: string): Promise<Buffer>;
  /**
   * The attachments Graph lists on one message now, in Graph's order. A move
   * gives a message a new id and its attachments new ids with it (stress
   * audit, 2026-09-11: a receipt's PDF answered 404 from Deleted items), so
   * a fetch that is refused looks the attachment up again here.
   */
  listAttachments(messageId: string): Promise<{ id: string; name: string; size: number }[]>;
  createReply(messageId: string): Promise<{ draftId: string }>;
  updateDraft(draftId: string, p: { body: string; html?: string; to: string[]; cc: string[] }): Promise<void>;
  /**
   * One outgoing file onto a draft that has not been sent yet (spec 8,
   * 2026-09-10). Small files go inline as base64; larger ones go through an
   * upload session, which is Graph's only way past its own request limit.
   */
  addAttachment(draftId: string, file: { filename: string; mimeType: string; bytes: Buffer }): Promise<void>;
  sendDraft(draftId: string): Promise<void>;
}
