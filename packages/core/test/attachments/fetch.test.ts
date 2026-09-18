import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountRow, testDb } from "../helpers/db";
import { FakeImapClient } from "../helpers/fakeImap";
import { FakeOutlookClient } from "../helpers/fakeOutlook";
import type { Config } from "../../src/config";
import type { Db } from "../../src/db/client";
import { accounts, attachments, messages, threads, type AccountRow, type AttachmentRow } from "../../src/db/schema";
import { ensureAttachmentBytes, fetchImapAttachment, fetchOutlookAttachment, NotFoundError } from "../../src/attachments/fetch";
import { writeBlob } from "../../src/attachments/blobs";
import type { MailConnector } from "../../src/connectors/types";

const CRLF = "\r\n";
const PDF = Buffer.from("%PDF-1.4 fake");

/** multipart/mixed: a tiny inline image (skipped) then a real attachment. */
function rawSource(filename = "menu.pdf"): Buffer {
  return Buffer.from(
    [
      "From: bob@example.com",
      "To: me@example.com",
      "Subject: Lunch?",
      "Message-ID: <m1@x>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="OUTER"',
      "",
      "--OUTER",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body",
      "--OUTER",
      'Content-Type: image/png; name="sig.png"',
      'Content-Disposition: inline; filename="sig.png"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.alloc(64, 1).toString("base64"),
      "--OUTER",
      `Content-Type: application/pdf; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      PDF.toString("base64"),
      "--OUTER--",
      "",
    ].join(CRLF),
    "utf8",
  );
}

let dir: string;
let cfg: Config;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fetch-test-"));
  cfg = { blobsDir: path.join(dir, "blobs") } as Config;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function seed(db: Db, p: { provider: "imap" | "outlook"; providerMessageId: string; att?: Partial<AttachmentRow> }): AccountRow {
  const acct = accountRow({ id: "a1", provider: p.provider, email: "me@example.com" });
  db.insert(accounts).values(acct).run();
  db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Lunch", lastMessageAt: 100, lastFromOperator: false }).run();
  db.insert(messages)
    .values({
      id: "a1:m1",
      accountId: "a1",
      providerMessageId: p.providerMessageId,
      threadId: "a1:t1",
      rfcMessageId: "<m1@x>",
      fromAddress: "bob@example.com",
      fromName: null,
      toAddresses: ["me@example.com"],
      ccAddresses: [],
      subject: "Lunch",
      bodyText: "Body",
      bodyHtml: null,
      snippet: null,
      attachmentNames: ["menu.pdf"],
      isFromOperator: false,
      sentAt: 100,
      receivedAt: 100,
    })
    .run();
  db.insert(attachments)
    .values({
      id: "a1:m1:0",
      messageId: "a1:m1",
      index: 0,
      filename: "menu.pdf",
      mimeType: "application/pdf",
      size: PDF.length,
      providerAttachmentId: null,
      sha256: null,
      path: null,
      fetchedAt: null,
      ...p.att,
    })
    .run();
  return acct;
}

function fakeConnector(bytes: Buffer): MailConnector & { calls: number } {
  const c = {
    calls: 0,
    sync: async () => ({ mode: "history" as const, fetched: 0, stored: 0, blocked: 0, failed: 0 }),
    backfill: async () => ({ mode: "backfill" as const, fetched: 0, stored: 0, blocked: 0, failed: 0 }),
    applyLabels: async () => ({ labeled: 0, failed: 0 }),
    fetchAttachment: async () => {
      c.calls++;
      return bytes;
    },
    trash: async () => ({ moved: 0, failed: 0 }),
    restore: async () => ({ moved: 0, failed: 0 }),
    sender: { sendReply: async () => ({ id: "x" }) },
  };
  return c;
}

describe("ensureAttachmentBytes", () => {
  it("serves a cached blob without touching the connector", async () => {
    const db = testDb();
    const blob = await writeBlob(cfg, PDF);
    seed(db, { provider: "imap", providerMessageId: "INBOX:42", att: { sha256: blob.sha256, path: blob.path, fetchedAt: 5 } });
    const connector = fakeConnector(PDF);

    const out = await ensureAttachmentBytes(db, cfg, () => connector, "a1:m1:0");
    expect(out.bytes).toEqual(PDF);
    expect(out.message.id).toBe("a1:m1");
    expect(out.row.path).toBe(blob.path);
    expect(connector.calls).toBe(0);
  });

  it("fetches once when the bytes are not on disk and persists sha256, path and fetchedAt", async () => {
    const db = testDb();
    seed(db, { provider: "imap", providerMessageId: "INBOX:42" });
    const connector = fakeConnector(PDF);

    const out = await ensureAttachmentBytes(db, cfg, () => connector, "a1:m1:0");
    expect(out.bytes).toEqual(PDF);
    expect(connector.calls).toBe(1);

    const row = db.select().from(attachments).where(eq(attachments.id, "a1:m1:0")).get()!;
    expect(row.sha256).toBe(createHash("sha256").update(PDF).digest("hex"));
    expect(row.path).toBe(path.join(cfg.blobsDir, row.sha256!));
    expect(row.fetchedAt).not.toBeNull();

    await ensureAttachmentBytes(db, cfg, () => connector, "a1:m1:0");
    expect(connector.calls).toBe(1);
  });

  it("re-fetches when the blob file has vanished", async () => {
    const db = testDb();
    const blob = await writeBlob(cfg, PDF);
    seed(db, { provider: "imap", providerMessageId: "INBOX:42", att: { sha256: blob.sha256, path: blob.path, fetchedAt: 5 } });
    await unlink(blob.path);
    const connector = fakeConnector(PDF);

    const out = await ensureAttachmentBytes(db, cfg, () => connector, "a1:m1:0");
    expect(out.bytes).toEqual(PDF);
    expect(connector.calls).toBe(1);
  });

  it("throws NotFoundError for an unknown attachment id", async () => {
    const db = testDb();
    seed(db, { provider: "imap", providerMessageId: "INBOX:42" });
    await expect(ensureAttachmentBytes(db, cfg, () => fakeConnector(PDF), "a1:m1:9")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("fetchImapAttachment", () => {
  it("re-parses the source and returns the bytes of the row's index", async () => {
    const imap = new FakeImapClient();
    imap.add("INBOX", { uid: 42, source: rawSource() });
    const row = { index: 0, filename: "menu.pdf" } as AttachmentRow;

    const bytes = await fetchImapAttachment(imap, "INBOX:42", row);
    expect(bytes).toEqual(PDF);
    expect(imap.sourceCalls).toEqual([{ folder: "INBOX", uid: 42 }]);
    expect(imap.connects).toBe(1);
    expect(imap.closes).toBe(1);
  });

  it("splits the provider message id on the last colon, so a folder with a colon still works", async () => {
    const imap = new FakeImapClient();
    imap.folderState.set("Archive:2024", { uidValidity: 1, messages: [{ uid: 7, source: rawSource() }] });
    const row = { index: 0, filename: "menu.pdf" } as AttachmentRow;

    await fetchImapAttachment(imap, "Archive:2024:7", row);
    expect(imap.sourceCalls).toEqual([{ folder: "Archive:2024", uid: 7 }]);
  });

  it("throws when the filename no longer matches the stored row", async () => {
    const imap = new FakeImapClient();
    imap.add("INBOX", { uid: 42, source: rawSource("other.pdf") });
    const row = { index: 0, filename: "menu.pdf" } as AttachmentRow;

    await expect(fetchImapAttachment(imap, "INBOX:42", row)).rejects.toThrow(/other\.pdf.*menu\.pdf/);
  });

  it("throws when the message is gone from the server", async () => {
    const imap = new FakeImapClient();
    const row = { index: 0, filename: "menu.pdf" } as AttachmentRow;
    await expect(fetchImapAttachment(imap, "INBOX:99", row)).rejects.toThrow(/INBOX:99/);
  });

  it("throws when the index is past the end of the kept attachments", async () => {
    const imap = new FakeImapClient();
    imap.add("INBOX", { uid: 42, source: rawSource() });
    const row = { index: 3, filename: "menu.pdf" } as AttachmentRow;
    await expect(fetchImapAttachment(imap, "INBOX:42", row)).rejects.toThrow(/index 3/);
  });
});

describe("fetchOutlookAttachment", () => {
  it("asks Graph for the bytes by provider attachment id", async () => {
    const client = new FakeOutlookClient();
    client.attachmentBytes.set("m1:att1", PDF);
    const row = { providerAttachmentId: "att1", filename: "menu.pdf" } as AttachmentRow;

    expect(await fetchOutlookAttachment(client, "m1", row)).toEqual(PDF);
    expect(client.attachmentCalls).toEqual([{ messageId: "m1", attachmentId: "att1" }]);
  });

  it("looks the attachment up again under the message when its stored id no longer answers", async () => {
    // Stress audit, 2026-09-11: a moved message's attachments get new Graph ids.
    const client = new FakeOutlookClient();
    client.attachmentBytes.set("m1@trash:att1-new", PDF);
    client.listedAttachments.set("m1@trash", [{ id: "att1-new", name: "menu.pdf", size: PDF.length }]);
    const row = { providerAttachmentId: "att1", filename: "menu.pdf", index: 0 } as AttachmentRow;
    const relocated: string[] = [];

    expect(await fetchOutlookAttachment(client, "m1@trash", row, (id) => relocated.push(id))).toEqual(PDF);
    expect(relocated).toEqual(["att1-new"]);
    expect(client.attachmentCalls.map((c) => c.attachmentId)).toEqual(["att1", "att1-new"]);
  });

  it("still fails when the message lists nothing that matches", async () => {
    const client = new FakeOutlookClient();
    client.listedAttachments.set("m1", [{ id: "other", name: "else.pdf", size: 1 }]);
    const row = { providerAttachmentId: "att1", filename: "menu.pdf", index: 0 } as AttachmentRow;
    await expect(fetchOutlookAttachment(client, "m1", row)).rejects.toThrow(/no such attachment/);
  });

  it("throws when the row has no provider attachment id", async () => {
    const client = new FakeOutlookClient();
    const row = { providerAttachmentId: null, filename: "menu.pdf" } as AttachmentRow;
    await expect(fetchOutlookAttachment(client, "m1", row)).rejects.toThrow(/menu\.pdf/);
  });
});

describe("fetchImapAttachment index alignment", () => {
  it("skips the same parts the normalizer skipped, so index 0 is still the file", async () => {
    // A nameless text/x-amp-html body alternative sits before the real
    // attachment. If the fetch counted it, index 0 would return the AMP body.
    const source = Buffer.from(
      [
        "From: bob@example.com",
        "To: me@example.com",
        "Subject: Amp with a file",
        "Message-ID: <amp2@x>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="OUTER"',
        "",
        "--OUTER",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Body",
        "--OUTER",
        "Content-Type: text/x-amp-html; charset=utf-8",
        "",
        "<html amp4email>" + "x".repeat(2000) + "</html>",
        "--OUTER",
        'Content-Type: application/pdf; name="menu.pdf"',
        'Content-Disposition: attachment; filename="menu.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        PDF.toString("base64"),
        "--OUTER--",
        "",
      ].join(CRLF),
      "utf8",
    );
    const imap = new FakeImapClient();
    imap.add("INBOX", { uid: 42, source });
    const row = { index: 0, filename: "menu.pdf" } as AttachmentRow;

    expect(await fetchImapAttachment(imap, "INBOX:42", row)).toEqual(PDF);
  });
});
