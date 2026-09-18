import { describe, it, expect } from "vitest";
import { accountRow, testDb } from "../helpers/db";
import { FakeImapClient } from "../helpers/fakeImap";
import { accounts, messages, sorts } from "../../src/db/schema";
import { applyImapLabels } from "../../src/imap/labels";

const base = {
  accountId: "a1",
  threadId: "a1:t1",
  rfcMessageId: null,
  fromName: null,
  toAddresses: [],
  ccAddresses: [],
  snippet: null,
  attachmentNames: [],
  isFromOperator: false,
  receivedAt: 1,
  subject: "s",
  bodyText: "b",
};

function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values(accountRow({ id: "a1", provider: "imap", email: "me@example.com", kind: "gmail" })).run();
  db.insert(messages)
    .values([
      { ...base, id: "a1:INBOX:1", providerMessageId: "INBOX:1", fromAddress: "a@x.com", sentAt: 1 },
      { ...base, id: "a1:INBOX:2", providerMessageId: "INBOX:2", fromAddress: "b@x.com", sentAt: 2 },
      { ...base, id: "a1:[Gmail]/Sent Mail:3", providerMessageId: "[Gmail]/Sent Mail:3", fromAddress: "c@x.com", sentAt: 3 },
    ])
    .run();
  db.insert(sorts)
    .values([
      { messageId: "a1:INBOX:1", important: true, needsReply: true, scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 },
      { messageId: "a1:INBOX:2", important: true, needsReply: false, scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 },
      { messageId: "a1:[Gmail]/Sent Mail:3", important: false, needsReply: false, scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 },
    ])
    .run();
}

describe("applyImapLabels", () => {
  it("adds agent labels once per sorted message, addressing each by its own folder and uid", async () => {
    const db = testDb();
    seed(db);
    const imap = new FakeImapClient();

    const r = await applyImapLabels(db, imap, "a1", () => 999);

    expect(r).toEqual({ labeled: 3, failed: 0 });
    expect(imap.labelCalls).toEqual([
      { folder: "INBOX", uid: 1, labels: ["agent/important", "agent/needs-reply"] },
      { folder: "INBOX", uid: 2, labels: ["agent/important"] },
    ]);
    expect(db.select().from(sorts).all().every((s) => s.labeledAt === 999)).toBe(true);
    expect(imap.connects).toBe(1);
    expect(imap.closes).toBe(1);

    const again = await applyImapLabels(db, imap, "a1");
    expect(again).toEqual({ labeled: 0, failed: 0 });
    expect(imap.labelCalls).toHaveLength(2);
  });

  it("connects to nothing when there is no unlabeled row", async () => {
    const db = testDb();
    db.insert(accounts).values(accountRow({ id: "a1", provider: "imap", email: "me@example.com" })).run();
    const imap = new FakeImapClient();

    expect(await applyImapLabels(db, imap, "a1")).toEqual({ labeled: 0, failed: 0 });
    expect(imap.connects).toBe(0);
  });

  it("isolates a per-message failure: the others still get labeled and the failing row stays unlabeled", async () => {
    const db = testDb();
    seed(db);
    const imap = new FakeImapClient();
    imap.addLabels = async (folder, uid) => {
      if (uid === 2) throw new Error("mailbox gone");
      imap.labelCalls.push({ folder, uid, labels: [] });
    };

    const r = await applyImapLabels(db, imap, "a1", () => 999);

    expect(r).toEqual({ labeled: 2, failed: 1 });
    const rows = db.select().from(sorts).all();
    expect(rows.find((s) => s.messageId === "a1:INBOX:1")!.labeledAt).toBe(999);
    expect(rows.find((s) => s.messageId === "a1:INBOX:2")!.labeledAt).toBeNull();
    expect(rows.find((s) => s.messageId === "a1:[Gmail]/Sent Mail:3")!.labeledAt).toBe(999);
    expect(imap.closes).toBe(1);
  });
});
