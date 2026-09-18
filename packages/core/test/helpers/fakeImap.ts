import type { ImapClient, ImapMessage, SmtpClient } from "../../src/imap/types";

/** A fake message also carries the Message-ID it was built with, so findByMessageId has something to search (spec 10a, 2026-09-11). */
export interface FakeImapMessage extends ImapMessage {
  rfcMessageId?: string;
}

export interface FakeFolder {
  uidValidity: number;
  messages: FakeImapMessage[];
}

/** Builds one raw RFC822 message. Enough headers for the normalizer, nothing more. */
export function fakeSource(p: { from: string; to?: string; subject?: string; body?: string; date?: number; messageId?: string }): Buffer {
  const date = new Date(p.date ?? 1_725_600_000_000).toUTCString();
  return Buffer.from(
    [
      `From: ${p.from}`,
      `To: ${p.to ?? "me@example.com"}`,
      `Subject: ${p.subject ?? "Subject"}`,
      `Date: ${date}`,
      `Message-ID: ${p.messageId ?? `<${p.from}-${p.date ?? 0}@example.com>`}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      p.body ?? "body",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

export function fakeMessage(p: { uid: number; from: string; to?: string; subject?: string; body?: string; date?: number; messageId?: string; gmailThreadId?: string; seen?: boolean }): FakeImapMessage {
  const rfcMessageId = p.messageId ?? `<${p.from}-${p.date ?? 0}@example.com>`;
  return {
    uid: p.uid,
    source: fakeSource({ ...p, messageId: rfcMessageId }),
    rfcMessageId,
    ...(p.gmailThreadId ? { gmailThreadId: p.gmailThreadId } : {}),
    ...(p.seen === undefined ? {} : { seen: p.seen }),
  };
}

/** The Date header of a fake message, so the fake can answer date-bounded searches. */
function sentAtOf(m: ImapMessage): number {
  const header = /^Date: (.+)$/m.exec(m.source.toString("utf8"));
  return header ? new Date(header[1]!).getTime() : 0;
}

/**
 * In-memory IMAP server. Reproduces the two behaviours sync depends on: uids
 * are per-folder and monotonic, and `n:*` returns the newest message even when
 * nothing is newer than n.
 */
export class FakeImapClient implements ImapClient {
  inboxPath = "INBOX";
  sentPath: string | null = "[Gmail]/Sent Mail";
  trashPath: string | null = "[Gmail]/Trash";
  junkPath: string | null = "[Gmail]/Spam";
  folderState = new Map<string, FakeFolder>();
  connects = 0;
  closes = 0;
  labelCalls: { folder: string; uid: number; labels: string[] }[] = [];
  fetchCalls: { folder: string; afterUid: number | null; sinceDate: Date | null }[] = [];
  olderCalls: { folder: string; beforeUid: number | null; sinceDate: Date | null }[] = [];
  sourceCalls: { folder: string; uid: number }[] = [];
  moveCalls: { folder: string; uids: number[]; destination: string }[] = [];
  findByMessageIdCalls: { folder: string; rfcMessageId: string }[] = [];
  /** Folders whose MOVE refuses, so a failure can be tested one folder at a time. */
  moveErrors = new Map<string, Error>();
  /** Simulates a server with no UIDPLUS: the move still happens, but hands back no uid map. */
  moveReturnsUidMap = true;
  connectError: Error | null = null;

  constructor() {
    for (const path of [this.inboxPath, this.sentPath!, this.trashPath!, this.junkPath!]) {
      this.folderState.set(path, { uidValidity: 1, messages: [] });
    }
  }

  add(folder: string, ...messages: ImapMessage[]): void {
    const f = this.folderState.get(folder) ?? { uidValidity: 1, messages: [] };
    f.messages.push(...messages);
    this.folderState.set(folder, f);
  }

  /** Simulates a mailbox rebuild: uids restart and mean something else now. */
  resetUidValidity(folder: string, uidValidity: number): void {
    const f = this.folderState.get(folder)!;
    f.uidValidity = uidValidity;
  }

  async connect(): Promise<void> {
    this.connects++;
    if (this.connectError) throw this.connectError;
  }

  async close(): Promise<void> {
    this.closes++;
  }

  async folders(): Promise<{ inbox: string; sent: string | null; trash: string | null; junk: string | null }> {
    return { inbox: this.inboxPath, sent: this.sentPath, trash: this.trashPath, junk: this.junkPath };
  }

  async fetchNew(folder: string, afterUid: number | null, sinceDate: Date | null): Promise<{ uidValidity: number; messages: ImapMessage[] }> {
    this.fetchCalls.push({ folder, afterUid, sinceDate });
    const f = this.folderState.get(folder);
    if (!f) throw new Error(`no such mailbox: ${folder}`);
    if (afterUid === null) return { uidValidity: f.uidValidity, messages: [...f.messages] };
    const newer = f.messages.filter((m) => m.uid > afterUid);
    // The IMAP quirk: `n:*` yields the last message when nothing is newer.
    // A real client drops it; the fake hands it over so sync must not store it.
    const last = f.messages[f.messages.length - 1];
    return { uidValidity: f.uidValidity, messages: newer.length > 0 || !last ? newer : [last] };
  }

  async fetchOlder(folder: string, beforeUid: number | null, sinceDate: Date | null): Promise<{ uidValidity: number; messages: ImapMessage[] }> {
    this.olderCalls.push({ folder, beforeUid, sinceDate });
    const f = this.folderState.get(folder);
    if (!f) throw new Error(`no such mailbox: ${folder}`);
    const messages = f.messages.filter(
      (m) => (beforeUid === null || m.uid < beforeUid) && (sinceDate === null || sentAtOf(m) >= sinceDate.getTime()),
    );
    return { uidValidity: f.uidValidity, messages };
  }

  async fetchSource(folder: string, uid: number): Promise<Buffer | null> {
    this.sourceCalls.push({ folder, uid });
    const f = this.folderState.get(folder);
    if (!f) throw new Error(`no such mailbox: ${folder}`);
    return f.messages.find((m) => m.uid === uid)?.source ?? null;
  }

  flagCalls: { folder: string; uids: number[] }[] = [];

  /** Marks a stored message read, as the operator's phone would. */
  markSeen(folder: string, uid: number): void {
    const f = this.folderState.get(folder);
    const m = f?.messages.find((x) => x.uid === uid);
    if (m) m.seen = true;
  }

  async fetchFlags(folder: string, uids: number[]): Promise<Map<number, boolean>> {
    this.flagCalls.push({ folder, uids });
    const f = this.folderState.get(folder);
    if (!f) throw new Error(`no such mailbox: ${folder}`);
    const out = new Map<number, boolean>();
    for (const m of f.messages) if (uids.includes(m.uid)) out.set(m.uid, m.seen === true);
    return out;
  }

  async addLabels(folder: string, uid: number, labels: string[]): Promise<void> {
    this.labelCalls.push({ folder, uid, labels });
  }

  async move(folder: string, uids: number[], destination: string): Promise<Map<number, number>> {
    this.moveCalls.push({ folder, uids, destination });
    if (this.moveErrors.has(folder)) throw this.moveErrors.get(folder)!;
    const from = this.folderState.get(folder);
    const to = this.folderState.get(destination);
    if (!from || !to) throw new Error(`no such mailbox: ${from ? destination : folder}`);
    const going = from.messages.filter((m) => uids.includes(m.uid));
    from.messages = from.messages.filter((m) => !uids.includes(m.uid));
    // A real server hands out a fresh uid in the destination folder.
    let next = to.messages.reduce((n, m) => Math.max(n, m.uid), 0);
    const uidMap = new Map<number, number>();
    for (const m of going) {
      const newUid = ++next;
      uidMap.set(m.uid, newUid);
      to.messages.push({ ...m, uid: newUid });
    }
    return this.moveReturnsUidMap ? uidMap : new Map();
  }

  async findByMessageId(folder: string, rfcMessageId: string): Promise<number | null> {
    this.findByMessageIdCalls.push({ folder, rfcMessageId });
    const f = this.folderState.get(folder);
    if (!f) throw new Error(`no such mailbox: ${folder}`);
    return f.messages.find((m) => m.rfcMessageId === rfcMessageId)?.uid ?? null;
  }
}

export class FakeSmtpClient implements SmtpClient {
  sent: Parameters<SmtpClient["send"]>[0][] = [];
  error: Error | null = null;

  async send(msg: Parameters<SmtpClient["send"]>[0]): Promise<{ messageId: string }> {
    if (this.error) throw this.error;
    this.sent.push(msg);
    return { messageId: `<sent-${this.sent.length}@example.com>` };
  }
}
