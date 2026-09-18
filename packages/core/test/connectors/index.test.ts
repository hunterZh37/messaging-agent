import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, mailCredentials, oauthTokens } from "../../src/db/schema";
import { saveImapAccount } from "../../src/imap/credentials";
import { GMAIL_SETTINGS } from "../../src/imap/types";
import { loadConfig } from "../../src/config";
import { AccountAuthError } from "../../src/connectors/types";
import { connectorForAccount } from "../../src/connectors/index";

function seedOutlookWithTokens(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values({ id: "a1", provider: "outlook", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  db.insert(oauthTokens).values({ accountId: "a1", refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 60_000, scope: null }).run();
  return db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
}

describe("connectorForAccount", () => {
  it("wires the imap connector from the stored password, with no .env credentials at all", () => {
    const db = testDb();
    const account = saveImapAccount(db, { email: "me@gmail.com", settings: GMAIL_SETTINGS, username: "me@gmail.com", password: "app-pw" });
    const cfg = loadConfig({}, "/unused");

    const connector = connectorForAccount(cfg, db, account);

    expect(typeof connector.sync).toBe("function");
    expect(typeof connector.applyLabels).toBe("function");
    expect(typeof connector.sender.sendReply).toBe("function");
  });

  it("throws AccountAuthError for an imap account whose password row is gone", () => {
    const db = testDb();
    const account = saveImapAccount(db, { email: "me@gmail.com", settings: GMAIL_SETTINGS, username: "me@gmail.com", password: "app-pw" });
    db.delete(mailCredentials).where(eq(mailCredentials.accountId, account.id)).run();
    const cfg = loadConfig({}, "/unused");

    expect(() => connectorForAccount(cfg, db, account)).toThrow(AccountAuthError);
  });

  it("throws AccountAuthError for a disconnected imap account", () => {
    const db = testDb();
    const account = saveImapAccount(db, { email: "me@gmail.com", settings: GMAIL_SETTINGS, username: "me@gmail.com", password: "app-pw" });
    db.update(accounts).set({ status: "disconnected" }).where(eq(accounts.id, account.id)).run();
    const disconnected = db.select().from(accounts).where(eq(accounts.id, account.id)).get()!;
    const cfg = loadConfig({}, "/unused");

    expect(() => connectorForAccount(cfg, db, disconnected)).toThrow(AccountAuthError);
  });

  it("wires the outlook connector for an outlook account, needing only microsoft credentials", () => {
    const db = testDb();
    const account = seedOutlookWithTokens(db);
    const cfg = loadConfig({ MICROSOFT_CLIENT_ID: "ms-id" }, "/unused");
    const connector = connectorForAccount(cfg, db, account);
    expect(typeof connector.sync).toBe("function");
    expect(typeof connector.applyLabels).toBe("function");
    expect(typeof connector.sender.sendReply).toBe("function");
  });

  it("an outlook account without MICROSOFT_CLIENT_ID fails to get an access token when used", async () => {
    const db = testDb();
    const account = seedOutlookWithTokens(db);
    const cfg = loadConfig({}, "/unused");
    const connector = connectorForAccount(cfg, db, account);
    await expect(
      connector.sender.sendReply({
        replyToProviderMessageId: "m1",
        providerThreadId: "t1",
        from: "me@example.com",
        to: ["bob@x.com"],
        cc: [],
        subject: "Re: X",
        inReplyTo: null,
        body: "hi",
      }),
    ).rejects.toThrow(/MICROSOFT_CLIENT_ID/);
  });

  it("throws AccountAuthError when the account has no oauth_tokens row", () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "outlook", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    const account = db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
    const cfg = loadConfig({ MICROSOFT_CLIENT_ID: "ms-id" }, "/unused");
    try {
      connectorForAccount(cfg, db, account);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AccountAuthError);
      expect((err as AccountAuthError).accountId).toBe("a1");
    }
  });

  it("throws AccountAuthError when the account is disconnected, even with a stale token row", () => {
    const db = testDb();
    seedOutlookWithTokens(db);
    db.update(accounts).set({ status: "disconnected" }).where(eq(accounts.id, "a1")).run();
    const disconnected = db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
    const cfg = loadConfig({ MICROSOFT_CLIENT_ID: "ms-id" }, "/unused");
    expect(() => connectorForAccount(cfg, db, disconnected)).toThrow(AccountAuthError);
  });
});
