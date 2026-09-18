import { describe, it, expect } from "vitest";
import { testDb } from "./helpers/db";
import { accounts, actions, mailCredentials, messages, oauthTokens, watermarks } from "../src/db/schema";
import { exportJsonl } from "../src/export";

describe("exportJsonl", () => {
  it("writes one typed line per row across tables", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(messages).values({ id: "a1:m1", accountId: "a1", providerMessageId: "m1", threadId: "a1:t1", rfcMessageId: null, fromAddress: "b@x.com", fromName: null, toAddresses: [], ccAddresses: [], subject: "s", bodyText: "b", snippet: null, attachmentNames: [], isFromOperator: false, sentAt: 1, receivedAt: 1 }).run();
    db.insert(actions).values({ kind: "skip", draftId: null, messageId: "a1:m1", payload: { a: 1 }, createdAt: 2 }).run();
    const lines: string[] = [];
    const r = await exportJsonl(db, (l) => { lines.push(l); });
    expect(r.lines).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.table)).toEqual(["accounts", "messages", "actions"]);
    expect(parsed[2].row.payload).toEqual({ a: 1 });
  });

  it("never exports secrets: no oauth_tokens, mail_credentials, or watermarks rows", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(oauthTokens).values({ accountId: "a1", refreshToken: "refresh-secret", accessToken: "access-secret", expiryDate: 1, scope: null }).run();
    db.insert(mailCredentials).values({ accountId: "a1", username: "me@example.com", password: "app-password-secret" }).run();
    db.insert(watermarks).values({ accountId: "a1", historyId: "{}", lastSyncAt: 1 }).run();

    const lines: string[] = [];
    const r = await exportJsonl(db, (l) => { lines.push(l); });

    expect(r.lines).toBe(1); // the account row only
    const joined = lines.join("\n");
    expect(joined).not.toContain("app-password-secret");
    expect(joined).not.toContain("refresh-secret");
    expect(joined).not.toContain("access-secret");
    expect(lines.map((l) => JSON.parse(l).table)).toEqual(["accounts"]);
  });
});
