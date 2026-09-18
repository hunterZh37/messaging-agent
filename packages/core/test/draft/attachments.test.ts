import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { blankPdf, linesPdf, textPdf } from "../fixtures/pdf";
import type { Config } from "../../src/config";
import type { Db } from "../../src/db/client";
import { accounts, draftAttachments, drafts, messages, threads } from "../../src/db/schema";
import {
  addDraftAttachment,
  DRAFT_ATTACHMENT_EXCERPT_LIMIT,
  getDraftAttachment,
  listDraftAttachments,
  MAX_DRAFT_ATTACHMENTS,
  MAX_DRAFT_ATTACHMENT_BYTES,
  removeDraftAttachment,
} from "../../src/draft/attachments";

let dir: string;
let cfg: Config;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "draft-att-test-"));
  cfg = { blobsDir: path.join(dir, "blobs") } as Config;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function seed(db: Db): void {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Invoice", lastMessageAt: 200, lastFromOperator: false }).run();
  db.insert(messages).values({
    id: "a1:m1", accountId: "a1", threadId: "a1:t1", providerMessageId: "m1", rfcMessageId: "<m1@x>",
    fromAddress: "jocelyn@x.com", fromName: "Jocelyn", toAddresses: ["me@example.com"], ccAddresses: [],
    subject: "Invoice", bodyText: "Can you send it over?", snippet: null, attachmentNames: [],
    isFromOperator: false, sentAt: 200, receivedAt: 1,
  }).run();
  db.insert(drafts).values({
    id: "d1", threadId: "a1:t1", replyToMessageId: "a1:m1", originalText: "Attached.", finalText: null,
    toAddresses: ["jocelyn@x.com"], ccAddresses: [], status: "pending", model: "x",
    sentProviderMessageId: null, error: null, createdAt: 1, updatedAt: 1,
  }).run();
}

const file = (over: Partial<{ filename: string; mimeType: string; bytes: Buffer }> = {}) => ({
  filename: "notes.txt",
  mimeType: "text/plain",
  bytes: Buffer.from("hello"),
  ...over,
});

describe("addDraftAttachment", () => {
  it("writes the bytes as a blob and a row pointing at it", async () => {
    const db = testDb();
    seed(db);

    const row = await addDraftAttachment(db, cfg, "d1", file({ filename: "invoice.pdf", mimeType: "application/pdf", bytes: textPdf("Invoice 42") }), () => 500);

    const bytes = textPdf("Invoice 42");
    expect(row).toMatchObject({
      draftId: "d1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: 500,
    });
    expect(row.path).toBe(path.join(cfg.blobsDir, row.sha256));
    expect(await readdir(cfg.blobsDir)).toEqual([row.sha256]);
    expect(db.select().from(draftAttachments).where(eq(draftAttachments.id, row.id)).get()?.filename).toBe("invoice.pdf");
  });

  it("reads a PDF's text layer into the excerpt", async () => {
    const db = testDb();
    seed(db);

    const row = await addDraftAttachment(db, cfg, "d1", file({ filename: "invoice.pdf", mimeType: "application/pdf", bytes: textPdf("Invoice 42 for Jocelyn") }));

    expect(row.textExcerpt).toContain("Invoice 42 for Jocelyn");
  });

  it("caps the excerpt so one long PDF cannot fill the prompt", async () => {
    const db = testDb();
    seed(db);
    const long = linesPdf(Array.from({ length: 300 }, (_, i) => `Line ${i}: ${"paragraph ".repeat(25)}`));

    const row = await addDraftAttachment(db, cfg, "d1", file({ filename: "long.pdf", mimeType: "application/pdf", bytes: long }));

    expect(row.textExcerpt).toHaveLength(DRAFT_ATTACHMENT_EXCERPT_LIMIT);
    expect(row.textExcerpt).toContain("Line 0:");
  });

  it("stores no excerpt for a PDF with no text layer", async () => {
    const db = testDb();
    seed(db);

    const row = await addDraftAttachment(db, cfg, "d1", file({ filename: "scan.pdf", mimeType: "application/pdf", bytes: blankPdf() }));

    expect(row.textExcerpt).toBeNull();
  });

  it("stores no excerpt for anything that is not a PDF", async () => {
    const db = testDb();
    seed(db);

    const row = await addDraftAttachment(db, cfg, "d1", file({ filename: "logo.png", mimeType: "image/png", bytes: Buffer.from("PNG-ish") }));

    expect(row.textExcerpt).toBeNull();
  });

  it("keeps the row even when the PDF cannot be read", async () => {
    const db = testDb();
    seed(db);

    const row = await addDraftAttachment(db, cfg, "d1", file({ filename: "broken.pdf", mimeType: "application/pdf", bytes: Buffer.from("not really a pdf") }));

    expect(row.textExcerpt).toBeNull();
    expect(listDraftAttachments(db, "d1")).toHaveLength(1);
  });

  it("refuses a file over the size limit, without writing anything", async () => {
    const db = testDb();
    seed(db);
    const big = Buffer.alloc(MAX_DRAFT_ATTACHMENT_BYTES + 1);

    await expect(addDraftAttachment(db, cfg, "d1", file({ filename: "huge.bin", bytes: big }))).rejects.toThrow(/25 MB/);
    expect(listDraftAttachments(db, "d1")).toEqual([]);
  });

  it("refuses more files than a draft may carry", async () => {
    const db = testDb();
    seed(db);
    for (let i = 0; i < MAX_DRAFT_ATTACHMENTS; i++) {
      await addDraftAttachment(db, cfg, "d1", file({ filename: `n${i}.txt`, bytes: Buffer.from(`file ${i}`) }));
    }

    await expect(addDraftAttachment(db, cfg, "d1", file({ filename: "one-too-many.txt", bytes: Buffer.from("x") }))).rejects.toThrow(/10 files/);
    expect(listDraftAttachments(db, "d1")).toHaveLength(MAX_DRAFT_ATTACHMENTS);
  });

  it("refuses a draft that is not pending, and one that is not there", async () => {
    const db = testDb();
    seed(db);
    db.update(drafts).set({ status: "sent" }).where(eq(drafts.id, "d1")).run();

    await expect(addDraftAttachment(db, cfg, "d1", file())).rejects.toThrow(/not pending/);
    await expect(addDraftAttachment(db, cfg, "nope", file())).rejects.toThrow(/draft not found/);
  });
});

describe("listDraftAttachments", () => {
  it("returns one draft's files, oldest first", async () => {
    const db = testDb();
    seed(db);
    await addDraftAttachment(db, cfg, "d1", file({ filename: "first.txt", bytes: Buffer.from("1") }), () => 10);
    await addDraftAttachment(db, cfg, "d1", file({ filename: "second.txt", bytes: Buffer.from("2") }), () => 20);

    expect(listDraftAttachments(db, "d1").map((a) => a.filename)).toEqual(["first.txt", "second.txt"]);
    expect(listDraftAttachments(db, "other")).toEqual([]);
  });
});

describe("removeDraftAttachment", () => {
  it("takes the row off the draft and leaves the blob alone", async () => {
    const db = testDb();
    seed(db);
    const row = await addDraftAttachment(db, cfg, "d1", file({ filename: "gone.txt", bytes: Buffer.from("bye") }));

    removeDraftAttachment(db, "d1", row.id);

    expect(listDraftAttachments(db, "d1")).toEqual([]);
    // Blobs are shared by sha256, so removing one draft's file never deletes bytes.
    expect(await readdir(cfg.blobsDir)).toEqual([row.sha256]);
  });

  it("refuses to take a file off another draft", async () => {
    const db = testDb();
    seed(db);
    const row = await addDraftAttachment(db, cfg, "d1", file({ filename: "mine.txt", bytes: Buffer.from("mine") }));

    expect(() => removeDraftAttachment(db, "d2", row.id)).toThrow(/not found/);
    expect(listDraftAttachments(db, "d1")).toHaveLength(1);
  });
});

describe("getDraftAttachment", () => {
  it("gives back the row when it is on that draft", async () => {
    const db = testDb();
    seed(db);
    const row = await addDraftAttachment(db, cfg, "d1", file({ filename: "menu.pdf", mimeType: "application/pdf", bytes: textPdf("Soup") }));

    expect(getDraftAttachment(db, "d1", row.id)).toMatchObject({ id: row.id, filename: "menu.pdf", path: row.path });
  });

  it("gives back nothing for a file on another draft, or an id nobody has", async () => {
    const db = testDb();
    seed(db);
    const row = await addDraftAttachment(db, cfg, "d1", file({ filename: "mine.txt" }));

    expect(getDraftAttachment(db, "d2", row.id)).toBeNull();
    expect(getDraftAttachment(db, "d1", "made-up")).toBeNull();
  });
});
