import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { blankPdf, textPdf } from "../fixtures/pdf";
import type { Config } from "../../src/config";
import type { Db } from "../../src/db/client";
import { accounts, chatFiles, drafts, messages, threads } from "../../src/db/schema";
import { ATTACHMENT_EXCERPT_LIMIT, ingestFile } from "../../src/attachments/ingest";
import { DRAFT_ATTACHMENT_EXCERPT_LIMIT, listDraftAttachments } from "../../src/draft/attachments";
import { openChatFor } from "../../src/chat/store";
import { addChatFile, attachChatFileToDraft, getChatFile, listChatFiles, MAX_CHAT_FILES, MAX_CHAT_FILE_BYTES, removeChatFile } from "../../src/chat/files";

let dir: string;
let cfg: Config;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "chat-files-test-"));
  cfg = { blobsDir: path.join(dir, "blobs") } as Config;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One thread with one message, and a pending draft answering it. */
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

describe("ingestFile", () => {
  it("writes the bytes once, content-addressed, and reads a PDF's text", async () => {
    const bytes = textPdf("Invoice 42 for Jocelyn");

    const first = await ingestFile(cfg, { mimeType: "application/pdf", bytes });
    const second = await ingestFile(cfg, { mimeType: "application/pdf", bytes });

    expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(first.path).toBe(path.join(cfg.blobsDir, first.sha256));
    expect(second.path).toBe(first.path);
    expect(await readdir(cfg.blobsDir)).toEqual([first.sha256]);
    expect(first.textExcerpt).toContain("Invoice 42 for Jocelyn");
  });

  it("reads no text out of anything that is not a PDF, or a PDF with no text layer", async () => {
    expect((await ingestFile(cfg, { mimeType: "image/png", bytes: Buffer.from("PNG-ish") })).textExcerpt).toBeNull();
    expect((await ingestFile(cfg, { mimeType: "application/pdf", bytes: blankPdf() })).textExcerpt).toBeNull();
    expect((await ingestFile(cfg, { mimeType: "application/pdf", bytes: Buffer.from("not really a pdf") })).textExcerpt).toBeNull();
  });

  it("is the same limit the draft code has always had", () => {
    expect(DRAFT_ATTACHMENT_EXCERPT_LIMIT).toBe(ATTACHMENT_EXCERPT_LIMIT);
  });
});

describe("addChatFile", () => {
  it("writes the bytes as a blob and a row on the conversation", async () => {
    const db = testDb();
    seed(db);
    const chat = openChatFor(db, {});

    const row = await addChatFile(db, cfg, chat.id, file({ filename: "invoice.pdf", mimeType: "application/pdf", bytes: textPdf("Invoice 42") }), () => 500);

    const bytes = textPdf("Invoice 42");
    expect(row).toMatchObject({
      chatId: chat.id,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: 500,
    });
    expect(row.textExcerpt).toContain("Invoice 42");
    expect(await readdir(cfg.blobsDir)).toEqual([row.sha256]);
    expect(db.select().from(chatFiles).where(eq(chatFiles.id, row.id)).get()?.filename).toBe("invoice.pdf");
  });

  it("refuses a file over the size limit, without writing anything", async () => {
    const db = testDb();
    const chat = openChatFor(db, {});

    await expect(addChatFile(db, cfg, chat.id, file({ filename: "huge.bin", bytes: Buffer.alloc(MAX_CHAT_FILE_BYTES + 1) }))).rejects.toThrow(/25 MB/);
    expect(listChatFiles(db, chat.id)).toEqual([]);
  });

  it("refuses more files than a conversation holds", async () => {
    const db = testDb();
    const chat = openChatFor(db, {});
    for (let i = 0; i < MAX_CHAT_FILES; i++) await addChatFile(db, cfg, chat.id, file({ filename: `n${i}.txt`, bytes: Buffer.from(`file ${i}`) }));

    await expect(addChatFile(db, cfg, chat.id, file({ filename: "one-too-many.txt" }))).rejects.toThrow(/20 files/);
    expect(listChatFiles(db, chat.id)).toHaveLength(MAX_CHAT_FILES);
  });

  it("refuses a conversation that is not there", async () => {
    const db = testDb();

    await expect(addChatFile(db, cfg, "nope", file())).rejects.toThrow(/chat not found/);
  });
});

describe("listChatFiles and getChatFile", () => {
  it("returns one conversation's files, oldest first", async () => {
    const db = testDb();
    const chat = openChatFor(db, {});
    await addChatFile(db, cfg, chat.id, file({ filename: "first.txt", bytes: Buffer.from("1") }), () => 10);
    await addChatFile(db, cfg, chat.id, file({ filename: "second.txt", bytes: Buffer.from("2") }), () => 20);

    expect(listChatFiles(db, chat.id).map((f) => f.filename)).toEqual(["first.txt", "second.txt"]);
    expect(listChatFiles(db, "other")).toEqual([]);
  });

  it("gives back nothing for a file in another conversation, or an id nobody has", async () => {
    const db = testDb();
    const chat = openChatFor(db, {});
    const row = await addChatFile(db, cfg, chat.id, file());

    expect(getChatFile(db, chat.id, row.id)).toMatchObject({ id: row.id, filename: "notes.txt" });
    expect(getChatFile(db, "another-chat", row.id)).toBeNull();
    expect(getChatFile(db, chat.id, "made-up")).toBeNull();
  });
});

describe("removeChatFile", () => {
  it("takes the row off the conversation and leaves the blob alone", async () => {
    const db = testDb();
    const chat = openChatFor(db, {});
    const row = await addChatFile(db, cfg, chat.id, file({ filename: "gone.txt", bytes: Buffer.from("bye") }));

    removeChatFile(db, chat.id, row.id);

    expect(listChatFiles(db, chat.id)).toEqual([]);
    expect(await readdir(cfg.blobsDir)).toEqual([row.sha256]);
  });

  it("refuses to take a file out of another conversation", async () => {
    const db = testDb();
    const chat = openChatFor(db, {});
    const row = await addChatFile(db, cfg, chat.id, file());

    expect(() => removeChatFile(db, "another-chat", row.id)).toThrow(/not found/);
    expect(listChatFiles(db, chat.id)).toHaveLength(1);
  });
});

describe("attachChatFileToDraft", () => {
  it("copies the row onto the draft, same blob and same excerpt, without re-reading the file", async () => {
    const db = testDb();
    seed(db);
    const chat = openChatFor(db, {});
    const given = await addChatFile(db, cfg, chat.id, file({ filename: "invoice.pdf", mimeType: "application/pdf", bytes: textPdf("Invoice 42") }));
    // The bytes go missing off this Mac between the two: a copy that had to
    // read them would fail here, and the operator's click would do nothing.
    await rm(cfg.blobsDir, { recursive: true, force: true });

    const row = attachChatFileToDraft(db, cfg, chat.id, given.id, "d1", () => 900);

    expect(row).toMatchObject({
      draftId: "d1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      size: given.size,
      sha256: given.sha256,
      path: given.path,
      textExcerpt: given.textExcerpt,
      createdAt: 900,
    });
    expect(listDraftAttachments(db, "d1").map((a) => a.filename)).toEqual(["invoice.pdf"]);
    // Giving Celeste a file and sending it are two acts: the chip stays.
    expect(listChatFiles(db, chat.id)).toHaveLength(1);
    expect(row.id).not.toBe(given.id);
  });

  it("refuses a file from another conversation, a draft that is gone, and one already sent", async () => {
    const db = testDb();
    seed(db);
    const chat = openChatFor(db, {});
    const given = await addChatFile(db, cfg, chat.id, file());

    expect(() => attachChatFileToDraft(db, cfg, "another-chat", given.id, "d1")).toThrow(/not found/);
    expect(() => attachChatFileToDraft(db, cfg, chat.id, given.id, "nope")).toThrow(/draft not found/);
    db.update(drafts).set({ status: "sent" }).where(eq(drafts.id, "d1")).run();
    expect(() => attachChatFileToDraft(db, cfg, chat.id, given.id, "d1")).toThrow(/not pending/);
    expect(listDraftAttachments(db, "d1")).toEqual([]);
  });
});
