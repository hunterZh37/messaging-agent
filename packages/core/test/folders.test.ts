import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accountRow, testDb } from "./helpers/db";
import { backfillFolders } from "../src/db/folders";
import { accounts, messages, type NewMessageRow } from "../src/db/schema";

function seed(db: ReturnType<typeof testDb>, rows: Partial<NewMessageRow>[]): void {
  db.insert(accounts).values(accountRow({ id: "a1", provider: "imap", email: "me@example.com" })).run();
  rows.forEach((r, i) => {
    db.insert(messages)
      .values({
        id: `a1:m${i}`,
        accountId: "a1",
        providerMessageId: `m${i}`,
        threadId: `a1:t${i}`,
        rfcMessageId: null,
        fromAddress: "bob@example.com",
        fromName: null,
        toAddresses: [],
        ccAddresses: [],
        subject: "s",
        bodyText: "b",
        bodyHtml: null,
        snippet: null,
        attachmentNames: [],
        isFromOperator: false,
        sentAt: 1,
        receivedAt: 1,
        ...r,
      })
      .run();
  });
}

const folderOf = (db: ReturnType<typeof testDb>, id: string) =>
  db.select().from(messages).where(eq(messages.id, id)).get()?.folder;

describe("backfillFolders", () => {
  it("moves the operator's own mail out of the default inbox folder, and nothing else", () => {
    const db = testDb();
    seed(db, [
      { providerMessageId: "INBOX:1", isFromOperator: false },
      { providerMessageId: "[Gmail]/Sent Mail:9", isFromOperator: true },
      { providerMessageId: "graph-id-1", isFromOperator: true },
      // The operator's own message that arrived in INBOX stays where it is.
      { providerMessageId: "INBOX:2", isFromOperator: true },
    ]);

    expect(backfillFolders(db)).toEqual({ moved: 2 });
    expect(folderOf(db, "a1:m0")).toBe("inbox");
    expect(folderOf(db, "a1:m1")).toBe("sent");
    expect(folderOf(db, "a1:m2")).toBe("sent");
    expect(folderOf(db, "a1:m3")).toBe("inbox");
  });

  it("leaves mail a folder-aware sync already filed alone, and is idempotent", () => {
    const db = testDb();
    seed(db, [
      { providerMessageId: "[Gmail]/Trash:4", isFromOperator: true, folder: "trash" },
      { providerMessageId: "[Gmail]/Sent Mail:9", isFromOperator: true, folder: "sent" },
    ]);

    expect(backfillFolders(db)).toEqual({ moved: 0 });
    expect(backfillFolders(db)).toEqual({ moved: 0 });
    expect(folderOf(db, "a1:m0")).toBe("trash");
    expect(folderOf(db, "a1:m1")).toBe("sent");
  });
});
