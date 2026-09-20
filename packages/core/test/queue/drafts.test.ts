import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { FakeSmtpClient } from "../helpers/fakeImap";
import { accounts, actions, draftAttachments, drafts, messages, sorts, threads } from "../../src/db/schema";
import { listPendingDrafts, getDraftView, restoreDraft, retireAnsweredDrafts, sendDraft, skipDraft } from "../../src/queue/drafts";
import { recordAction } from "../../src/queue/actions";
import { imapSender } from "../../src/imap/sender";

function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Lunch", lastMessageAt: 200, lastFromOperator: false }).run();
  const base = { accountId: "a1", threadId: "a1:t1", fromName: null, ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1, subject: "Lunch" };
  db.insert(messages).values([
    { ...base, id: "a1:m1", providerMessageId: "m1", rfcMessageId: "<m1@x>", fromAddress: "me@example.com", toAddresses: ["bob@x.com"], bodyText: "first", isFromOperator: true, sentAt: 100 },
    { ...base, id: "a1:m2", providerMessageId: "m2", rfcMessageId: "<m2@x>", fromAddress: "bob@x.com", toAddresses: ["me@example.com"], bodyText: "Friday?", isFromOperator: false, sentAt: 200 },
  ]).run();
  db.insert(sorts).values({ messageId: "a1:m2", wants: "reply", scheduling: true, reason: "asks for a date", model: "x", labeledAt: null, createdAt: 1 }).run();
  db.insert(drafts).values({ id: "d1", threadId: "a1:t1", replyToMessageId: "a1:m2", originalText: "Yes, Friday.", finalText: null, toAddresses: ["bob@x.com"], ccAddresses: [], status: "pending", model: "x", sentProviderMessageId: null, error: null, createdAt: 1, updatedAt: 1 }).run();
}

describe("retireAnsweredDrafts", () => {
  // Operator, 2026-09-11: no Celeste drafts for sent mail. A reply written in
  // the mailbox itself retires the draft that was waiting for it.
  it("skips a pending draft once the operator has answered the thread after it", () => {
    const db = testDb();
    seed(db);
    db.insert(messages).values({ accountId: "a1", threadId: "a1:t1", id: "a1:m3", providerMessageId: "m3", rfcMessageId: "<m3@x>", fromName: null, fromAddress: "me@example.com", toAddresses: ["bob@x.com"], ccAddresses: [], subject: "Lunch", bodyText: "Friday works.", snippet: null, attachmentNames: [], isFromOperator: true, sentAt: 300, receivedAt: 300 }).run();
    db.update(threads).set({ lastFromOperator: true, lastMessageAt: 300 }).where(eq(threads.id, "a1:t1")).run();

    expect(retireAnsweredDrafts(db, () => 400)).toBe(1);
    const row = db.select().from(drafts).where(eq(drafts.id, "d1")).get();
    expect(row?.status).toBe("skipped");
    expect(row?.error).toBe("answered by the operator");
    expect(row?.updatedAt).toBe(400);
    expect(listPendingDrafts(db)).toEqual([]);
  });

  it("leaves a draft alone when the operator's last word came before it", () => {
    const db = testDb();
    seed(db);
    // The thread's last message is the operator's, but from before the draft.
    db.update(threads).set({ lastFromOperator: true, lastMessageAt: 0 }).where(eq(threads.id, "a1:t1")).run();
    expect(retireAnsweredDrafts(db)).toBe(0);
    expect(listPendingDrafts(db).map((v) => v.draft.id)).toEqual(["d1"]);
  });
});

describe("queue reads", () => {
  it("lists pending drafts with thread and account", () => {
    const db = testDb();
    seed(db);
    const views = listPendingDrafts(db);
    expect(views).toHaveLength(1);
    expect(views[0]?.draft.id).toBe("d1");
    expect(views[0]?.replyTo.fromAddress).toBe("bob@x.com");
    expect(views[0]?.thread.map((m) => m.id)).toEqual(["a1:m1", "a1:m2"]);
    expect(views[0]?.account.email).toBe("me@example.com");
    expect(views[0]?.sort?.reason).toBe("asks for a date");
    expect(views[0]?.attachments).toEqual([]);
    expect(getDraftView(db, "nope")).toBeNull();
  });

  it("carries the subject the send will set, so a preview can show it", () => {
    const db = testDb();
    seed(db);

    expect(getDraftView(db, "d1")?.replySubject).toBe("Re: Lunch");

    db.update(messages).set({ subject: "Re: Lunch" }).where(eq(messages.id, "a1:m2")).run();
    expect(getDraftView(db, "d1")?.replySubject).toBe("Re: Lunch");
  });

  it("carries the files the operator put on the draft, oldest first", () => {
    const db = testDb();
    seed(db);
    db.insert(draftAttachments).values([
      { id: "att2", draftId: "d1", filename: "second.pdf", mimeType: "application/pdf", size: 20, sha256: "b", path: "/blobs/b", textExcerpt: null, createdAt: 20 },
      { id: "att1", draftId: "d1", filename: "first.pdf", mimeType: "application/pdf", size: 10, sha256: "a", path: "/blobs/a", textExcerpt: "Invoice 42", createdAt: 10 },
    ]).run();

    expect(getDraftView(db, "d1")?.attachments.map((a) => a.filename)).toEqual(["first.pdf", "second.pdf"]);
  });

  it("scopes pending drafts to one inbox when the switcher names it", () => {
    const db = testDb();
    seed(db);
    db.insert(accounts).values({ id: "a2", provider: "imap", email: "work@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(threads).values({ id: "a2:t1", accountId: "a2", providerThreadId: "t1", subject: "Standup", lastMessageAt: 300, lastFromOperator: false }).run();
    db.insert(messages).values({
      id: "a2:m1", accountId: "a2", threadId: "a2:t1", providerMessageId: "m1", rfcMessageId: "<m1@y>",
      fromAddress: "carol@work.com", fromName: null, toAddresses: ["work@example.com"], ccAddresses: [],
      subject: "Standup", bodyText: "Lead standup?", snippet: null, attachmentNames: [],
      isFromOperator: false, sentAt: 300, receivedAt: 1,
    }).run();
    db.insert(drafts).values({
      id: "d2", threadId: "a2:t1", replyToMessageId: "a2:m1", originalText: "Sure.", finalText: null,
      toAddresses: ["carol@work.com"], ccAddresses: [], status: "pending", model: "x",
      sentProviderMessageId: null, error: null, createdAt: 2, updatedAt: 2,
    }).run();

    expect(listPendingDrafts(db).map((v) => v.draft.id)).toEqual(["d1", "d2"]);
    expect(listPendingDrafts(db, { accountId: "a1" }).map((v) => v.draft.id)).toEqual(["d1"]);
    expect(listPendingDrafts(db, { accountId: "a2" }).map((v) => v.draft.id)).toEqual(["d2"]);
    expect(listPendingDrafts(db, { accountId: "gone" })).toEqual([]);
  });
});

describe("recordAction", () => {
  it("appends rows and returns the id", () => {
    const db = testDb();
    expect(recordAction(db, { kind: "skip", draftId: "d1", payload: {} }, () => 5)).toBe(1);
    expect(recordAction(db, { kind: "skip", draftId: "d1", payload: {} }, () => 6)).toBe(2);
    expect(db.select().from(actions).all()).toHaveLength(2);
  });
});

describe("sendDraft", () => {
  it("sends in-thread, marks sent, stores final text, logs send when unedited", async () => {
    const db = testDb();
    seed(db);
    const smtp = new FakeSmtpClient();
    const r = await sendDraft(db, imapSender(smtp), { draftId: "d1", finalText: "Yes, Friday.", to: ["bob@x.com"], cc: [] }, () => 999);
    expect(r.providerMessageId).toBe("<sent-1@example.com>");
    expect(smtp.sent[0]).toMatchObject({
      from: "me@example.com",
      to: ["bob@x.com"],
      subject: "Re: Lunch",
      text: "Yes, Friday.",
      inReplyTo: "<m2@x>",
      references: "<m2@x>",
    });
    const d = db.select().from(drafts).where(eq(drafts.id, "d1")).get();
    expect(d).toMatchObject({ status: "sent", finalText: "Yes, Friday.", sentProviderMessageId: "<sent-1@example.com>", updatedAt: 999 });
    const a = db.select().from(actions).all();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "send", draftId: "d1", messageId: "a1:m2" });
  });

  it("logs edit_send with the diff payload when text or recipients changed", async () => {
    const db = testDb();
    seed(db);
    const smtp = new FakeSmtpClient();
    await sendDraft(db, imapSender(smtp), { draftId: "d1", finalText: "Yes, Friday at noon.", to: ["bob@x.com"], cc: ["carol@x.com"] });
    const a = db.select().from(actions).get();
    expect(a?.kind).toBe("edit_send");
    expect(a?.payload).toMatchObject({
      originalText: "Yes, Friday.",
      originalTo: ["bob@x.com"],
      originalCc: [],
      finalText: "Yes, Friday at noon.",
      to: ["bob@x.com"],
      cc: ["carol@x.com"],
    });
    expect(db.select().from(drafts).get()?.ccAddresses).toEqual(["carol@x.com"]);
  });

  it("sends the files on the draft, reading their bytes off disk", async () => {
    const db = testDb();
    seed(db);
    const dir = mkdtempSync(path.join(tmpdir(), "send-att-test-"));
    try {
      const blob = path.join(dir, "invoice");
      writeFileSync(blob, "%PDF-1.4 invoice");
      db.insert(draftAttachments).values({
        id: "att1", draftId: "d1", filename: "invoice.pdf", mimeType: "application/pdf",
        size: 16, sha256: "abc", path: blob, textExcerpt: "Invoice 42", createdAt: 10,
      }).run();
      const smtp = new FakeSmtpClient();

      await sendDraft(db, imapSender(smtp), { draftId: "d1", finalText: "Yes, Friday.", to: ["bob@x.com"], cc: [] });

      expect(smtp.sent[0]?.attachments).toEqual([
        { filename: "invoice.pdf", content: Buffer.from("%PDF-1.4 invoice"), contentType: "application/pdf" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to send a non-pending draft", async () => {
    const db = testDb();
    seed(db);
    skipDraft(db, "d1");
    await expect(sendDraft(db, imapSender(new FakeSmtpClient()), { draftId: "d1", finalText: "x", to: ["bob@x.com"], cc: [] })).rejects.toThrow(/not pending/);
  });

  it("marks failed and logs send_failed when the server throws", async () => {
    const db = testDb();
    seed(db);
    const smtp = new FakeSmtpClient();
    smtp.error = new Error("quota");
    await expect(sendDraft(db, imapSender(smtp), { draftId: "d1", finalText: "x", to: ["bob@x.com"], cc: [] })).rejects.toThrow("quota");
    expect(db.select().from(drafts).get()).toMatchObject({ status: "failed", error: "quota" });
    expect(db.select().from(actions).get()?.kind).toBe("send_failed");
  });

  it("still surfaces the original error when recording the failure itself fails", async () => {
    const db = testDb();
    seed(db);
    const smtp = new FakeSmtpClient();
    smtp.error = new Error("quota");
    db.run(sql`drop table actions`);
    await expect(sendDraft(db, imapSender(smtp), { draftId: "d1", finalText: "x", to: ["bob@x.com"], cc: [] })).rejects.toThrow("quota");
    expect(db.select().from(drafts).get()).toMatchObject({ status: "failed", error: "quota" });
  });
});

describe("skipDraft", () => {
  it("marks skipped and logs", () => {
    const db = testDb();
    seed(db);
    skipDraft(db, "d1", () => 7);
    expect(db.select().from(drafts).get()).toMatchObject({ status: "skipped", updatedAt: 7 });
    expect(db.select().from(actions).get()).toMatchObject({ kind: "skip", draftId: "d1", messageId: "a1:m2", createdAt: 7 });
    expect(listPendingDrafts(db)).toEqual([]);
  });
});

/** Delete a draft, and take the delete back (2026-09-14). */
describe("restoreDraft", () => {
  it("puts a deleted draft back in the queue and logs it", () => {
    const db = testDb();
    seed(db);
    skipDraft(db, "d1", () => 7);
    const view = restoreDraft(db, "d1", () => 9);
    expect(view.draft).toMatchObject({ id: "d1", status: "pending", updatedAt: 9 });
    expect(listPendingDrafts(db).map((d) => d.draft.id)).toEqual(["d1"]);
    expect(db.select().from(actions).all().map((a) => [a.kind, a.draftId])).toEqual([["skip", "d1"], ["restore", "d1"]]);
  });

  it("refuses a draft that was never deleted, and one whose thread has a newer draft", () => {
    const db = testDb();
    seed(db);
    expect(() => restoreDraft(db, "d1")).toThrow("not deleted");
    skipDraft(db, "d1");
    const d = db.select().from(drafts).get()!;
    db.insert(drafts).values({ ...d, id: "d2", status: "pending" }).run();
    expect(() => restoreDraft(db, "d1")).toThrow("newer draft");
  });
});

/**
 * Emphasis on the way out (operator, 2026-09-20). The one thing that must
 * hold: nobody is ever shown the asterisks. A reader on HTML gets the mark,
 * a reader on plain text gets the words, and a chat gets the words.
 */
describe("a marked draft on the way out", () => {
  it("sends the words as text and the marks as HTML, in one mail", async () => {
    const db = testDb();
    seed(db);
    const smtp = new FakeSmtpClient();
    await sendDraft(db, imapSender(smtp), { draftId: "d1", finalText: "Send the **signed** copy.", to: ["bob@x.com"], cc: [] });
    expect(smtp.sent[0]?.text).toBe("Send the signed copy.");
    expect(smtp.sent[0]?.html).toBe("<p>Send the <strong>signed</strong> copy.</p>");
  });

  it("sends no HTML at all when nothing is marked", async () => {
    const db = testDb();
    seed(db);
    const smtp = new FakeSmtpClient();
    await sendDraft(db, imapSender(smtp), { draftId: "d1", finalText: "Yes, Friday.", to: ["bob@x.com"], cc: [] });
    expect(smtp.sent[0]?.html).toBeUndefined();
  });

  /** The card draws the marks and a revise reads them, so the row keeps them. */
  it("keeps the marks on the draft row, which is what the card draws", async () => {
    const db = testDb();
    seed(db);
    await sendDraft(db, imapSender(new FakeSmtpClient()), { draftId: "d1", finalText: "The **signed** copy.", to: ["bob@x.com"], cc: [] });
    expect(db.select().from(drafts).where(eq(drafts.id, "d1")).get()?.finalText).toBe("The **signed** copy.");
  });
});
