import type { GraphMessage, OutlookClient, OutlookFolder } from "../../src/outlook/types";

export function fakeGraphMessage(p: {
  id: string;
  conversationId?: string;
  from: string;
  fromName?: string;
  to?: string;
  subject?: string;
  body?: string;
  html?: boolean;
  date?: number;
  internetMessageId?: string;
  attachments?: string[];
  isDraft?: boolean;
  isRead?: boolean;
}): GraphMessage {
  const iso = new Date(p.date ?? 1_725_600_000_000).toISOString();
  return {
    id: p.id,
    conversationId: p.conversationId ?? p.id,
    internetMessageId: p.internetMessageId ?? `<${p.id}@example.com>`,
    subject: p.subject ?? "Subject",
    bodyPreview: (p.body ?? "").slice(0, 40),
    body: { contentType: p.html ? "html" : "text", content: p.body ?? "body" },
    from: { emailAddress: { address: p.from, name: p.fromName } },
    toRecipients: [{ emailAddress: { address: p.to ?? "me@example.com" } }],
    ccRecipients: [],
    receivedDateTime: iso,
    sentDateTime: iso,
    hasAttachments: Boolean(p.attachments?.length),
    attachments: (p.attachments ?? []).map((name) => ({ name })),
    categories: [],
    isDraft: p.isDraft ?? false,
    ...(p.isRead === undefined ? {} : { isRead: p.isRead }),
  };
}

interface DraftState {
  /** Null for a composed draft, which replies to nothing (2026-09-22). */
  forMessageId: string | null;
  subject?: string;
  body?: string;
  html?: string;
  to?: string[];
  cc?: string[];
  attachments: { filename: string; mimeType: string; bytes: Buffer }[];
  sent: boolean;
}

/** In-memory OutlookClient. Mirrors FakeGmailClient's shape: append pending messages, "delta" drains and clears them like history does. */
export class FakeOutlookClient implements OutlookClient {
  email = "me@example.com";
  pending: Record<OutlookFolder, GraphMessage[]> = { inbox: [], sent: [], trash: [], junk: [] };
  deltaLinks: Record<OutlookFolder, string> = { inbox: "delta-inbox-0", sent: "delta-sent-0", trash: "delta-trash-0", junk: "delta-junk-0" };
  expiredOnce: Record<OutlookFolder, boolean> = { inbox: false, sent: false, trash: false, junk: false };
  lastSinceIso: Record<OutlookFolder, string | null> = { inbox: null, sent: null, trash: null, junk: null };
  /** Everything the mailbox holds, whether or not delta has handed it over. */
  stored: Record<OutlookFolder, GraphMessage[]> = { inbox: [], sent: [], trash: [], junk: [] };
  listCalls: { folder: OutlookFolder; sinceIso: string | null }[] = [];
  categories = new Set<string>();
  messageCategories = new Map<string, string[]>();
  categoryFailures = new Set<string>();
  moveCalls: { messageId: string; destination: OutlookFolder }[] = [];
  moveFailures = new Set<string>();
  drafts = new Map<string, DraftState>();
  attachmentBytes = new Map<string, Buffer>();
  attachmentCalls: { messageId: string; attachmentId: string }[] = [];
  bodyCalls: string[] = [];
  private draftSeq = 0;

  addMessage(folder: OutlookFolder, m: GraphMessage): void {
    this.pending[folder].push(m);
    this.stored[folder].push(m);
  }

  /** Mail the mailbox holds but delta never handed over: only a listMessages backfill can reach it. */
  addOlderMessage(folder: OutlookFolder, m: GraphMessage): void {
    this.stored[folder].push(m);
  }

  expireFolder(folder: OutlookFolder): void {
    this.expiredOnce[folder] = true;
  }

  async getProfile() {
    return { email: this.email };
  }

  async delta(folder: OutlookFolder, _deltaLink: string | null, sinceIso: string | null) {
    if (this.expiredOnce[folder]) {
      this.expiredOnce[folder] = false;
      return "expired" as const;
    }
    this.lastSinceIso[folder] = sinceIso;
    const messages = this.pending[folder].filter((m) => !m.isDraft && !m["@removed"]);
    const removed = this.pending[folder].filter((m) => m["@removed"]).map((m) => m.id);
    this.pending[folder] = [];
    this.deltaLinks[folder] = `${this.deltaLinks[folder]}+`;
    return { messages, removed, deltaLink: this.deltaLinks[folder] };
  }

  async listMessages(folder: OutlookFolder, sinceIso: string | null) {
    this.listCalls.push({ folder, sinceIso });
    const floor = sinceIso === null ? null : new Date(sinceIso).getTime();
    return this.stored[folder].filter(
      (m) => !m.isDraft && (floor === null || new Date(m.receivedDateTime ?? m.sentDateTime ?? 0).getTime() >= floor),
    );
  }

  async moveMessage(messageId: string, destination: OutlookFolder) {
    this.moveCalls.push({ messageId, destination });
    if (this.moveFailures.has(messageId)) throw new Error(`message ${messageId} cannot be moved`);
    for (const folder of ["inbox", "sent", "trash", "junk"] as const) {
      const at = this.stored[folder].findIndex((m) => m.id === messageId);
      if (at === -1) continue;
      const [moved] = this.stored[folder].splice(at, 1);
      // Graph hands the moved message a fresh id; the fake does the same, and
      // keeps `stored` under that new id so a second move by it still works.
      const newId = `${messageId}@${destination}`;
      moved!.id = newId;
      this.stored[destination].push(moved!);
      return { id: newId };
    }
    // What Graph says for an id that no longer names anything (2026-09-14).
    throw new Error(`Graph request failed: 404 The specified object was not found in the store. (${messageId})`);
  }

  async findMessage(rfcMessageId: string) {
    for (const folder of ["trash", "inbox", "sent", "junk"] as const) {
      const hit = this.stored[folder].find((m) => m.internetMessageId === rfcMessageId);
      if (hit) return { id: hit.id, folder: folder === "trash" || folder === "inbox" ? folder : ("other" as const) };
    }
    return null;
  }

  async ensureCategory(name: string) {
    this.categories.add(name);
  }

  async addCategories(messageId: string, names: string[]) {
    if (this.categoryFailures.has(messageId)) {
      throw Object.assign(new Error("message not found"), { code: 404 });
    }
    const existing = this.messageCategories.get(messageId) ?? [];
    this.messageCategories.set(messageId, [...new Set([...existing, ...names])]);
  }

  async getBody(messageId: string) {
    this.bodyCalls.push(messageId);
    for (const folder of Object.keys(this.stored) as OutlookFolder[]) {
      const m = this.stored[folder].find((x) => x.id === messageId);
      if (m) return { contentType: m.body?.contentType ?? "text", content: m.body?.content ?? "" };
    }
    throw Object.assign(new Error(`no such message ${messageId}`), { code: 404 });
  }

  /** What `listAttachments` answers per message id; set by a test that moves a message. */
  listedAttachments = new Map<string, { id: string; name: string; size: number }[]>();

  async listAttachments(messageId: string) {
    return this.listedAttachments.get(messageId) ?? [];
  }

  async getAttachmentBytes(messageId: string, attachmentId: string) {
    this.attachmentCalls.push({ messageId, attachmentId });
    const bytes = this.attachmentBytes.get(`${messageId}:${attachmentId}`);
    if (!bytes) throw new Error(`no such attachment ${attachmentId} on ${messageId}`);
    return bytes;
  }

  /** A draft with nothing above it (compose, 2026-09-22): no message it replies to. */
  async createMessage(p: { subject: string; to: string[]; cc: string[] }) {
    this.draftSeq++;
    const draftId = `draft_${this.draftSeq}`;
    this.drafts.set(draftId, { forMessageId: null, subject: p.subject, to: p.to, cc: p.cc, attachments: [], sent: false });
    return { draftId };
  }

  async createReply(messageId: string) {
    this.draftSeq++;
    const draftId = `draft_${this.draftSeq}`;
    this.drafts.set(draftId, { forMessageId: messageId, attachments: [], sent: false });
    return { draftId };
  }

  async updateDraft(draftId: string, p: { body: string; html?: string; to: string[]; cc: string[] }) {
    const d = this.drafts.get(draftId);
    if (!d) throw new Error(`unknown draft ${draftId}`);
    d.body = p.body;
    d.html = p.html;
    d.to = p.to;
    d.cc = p.cc;
  }

  async addAttachment(draftId: string, file: { filename: string; mimeType: string; bytes: Buffer }) {
    const d = this.drafts.get(draftId);
    if (!d) throw new Error(`unknown draft ${draftId}`);
    if (d.sent) throw new Error(`draft ${draftId} has already gone`);
    d.attachments.push(file);
  }

  async sendDraft(draftId: string) {
    const d = this.drafts.get(draftId);
    if (!d) throw new Error(`unknown draft ${draftId}`);
    d.sent = true;
  }
}
