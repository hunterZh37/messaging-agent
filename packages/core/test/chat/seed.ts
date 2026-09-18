import type { Db } from "../../src/db/client";
import { accounts, messages, threads } from "../../src/db/schema";
import { indexMessageForSearch } from "../../src/chat/search";

export interface SeedMessage {
  folder?: "inbox" | "sent" | "trash" | "junk";
  id: string;
  accountId?: string;
  threadId?: string;
  subject?: string;
  fromName?: string | null;
  fromAddress?: string;
  toAddresses?: string[];
  bodyText?: string;
  attachmentNames?: string[];
  isFromOperator?: boolean;
  sentAt?: number;
}

/** Two accounts, and whatever messages the test names, indexed for search. */
export function seedMail(db: Db, list: SeedMessage[]): void {
  db.insert(accounts)
    .values([
      { id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 },
      { id: "a2", provider: "imap", email: "other@example.com", displayName: null, createdAt: 1 },
    ])
    .onConflictDoNothing()
    .run();

  for (const m of list) {
    const accountId = m.accountId ?? "a1";
    const threadId = m.threadId ?? `${accountId}:t-${m.id}`;
    const subject = m.subject ?? "Subject";
    const sentAt = m.sentAt ?? 1000;
    db.insert(threads)
      .values({ id: threadId, accountId, providerThreadId: threadId, subject, lastMessageAt: sentAt, lastFromOperator: m.isFromOperator ?? false })
      .onConflictDoNothing()
      .run();
    const row = {
      id: `${accountId}:${m.id}`,
      accountId,
      providerMessageId: m.id,
      threadId,
      rfcMessageId: null,
      fromAddress: m.fromAddress ?? "bob@example.com",
      fromName: m.fromName === undefined ? "Bob" : m.fromName,
      toAddresses: m.toAddresses ?? ["me@example.com"],
      ccAddresses: [],
      subject,
      bodyText: m.bodyText ?? "body",
      bodyHtml: null,
      snippet: null,
      attachmentNames: m.attachmentNames ?? [],
      isFromOperator: m.isFromOperator ?? false,
      folder: m.folder ?? (m.isFromOperator ? "sent" : "inbox"),
      sentAt,
      receivedAt: sentAt,
    };
    db.insert(messages).values(row).run();
    indexMessageForSearch(db, row);
  }
}
