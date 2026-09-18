import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { FakeImapClient } from "../helpers/fakeImap";
import { AccountAuthError } from "../../src/connectors/types";
import { accounts, mailCredentials } from "../../src/db/schema";
import { imapForAccount, saveImapAccount, testImapLogin } from "../../src/imap/credentials";
import { GMAIL_SETTINGS, type ImapSettings } from "../../src/imap/types";

const generic: ImapSettings = { imapHost: "imap.fastmail.com", imapPort: 993, smtpHost: "smtp.fastmail.com", smtpPort: 465, kind: "generic" };

describe("saveImapAccount", () => {
  it("creates the account row with its hosts and kind, and stores the password out of .env", () => {
    const db = testDb();

    const account = saveImapAccount(db, { email: "Hunter@Gmail.com", settings: GMAIL_SETTINGS, username: "hunter@gmail.com", password: "app-pw" });

    expect(account.email).toBe("hunter@gmail.com");
    expect(account.provider).toBe("imap");
    expect(account.kind).toBe("gmail");
    expect(account.imapHost).toBe("imap.gmail.com");
    expect(account.imapPort).toBe(993);
    expect(account.smtpHost).toBe("smtp.gmail.com");
    expect(account.smtpPort).toBe(465);
    expect(account.status).toBe("ok");

    const creds = db.select().from(mailCredentials).where(eq(mailCredentials.accountId, account.id)).get();
    expect(creds).toEqual({ accountId: account.id, username: "hunter@gmail.com", password: "app-pw" });
  });

  it("reconnecting the same address updates the password and clears needs_signin, keeping the account id", () => {
    const db = testDb();
    const first = saveImapAccount(db, { email: "h@x.com", settings: generic, username: "h@x.com", password: "old" });
    db.update(accounts).set({ status: "needs_signin", lastError: "IMAP login failed" }).where(eq(accounts.id, first.id)).run();

    const second = saveImapAccount(db, { email: "h@x.com", settings: { ...generic, imapHost: "imap2.fastmail.com" }, username: "h@x.com", password: "new" });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("ok");
    expect(second.lastError).toBeNull();
    expect(second.imapHost).toBe("imap2.fastmail.com");
    expect(db.select().from(mailCredentials).all()).toHaveLength(1);
    expect(db.select().from(mailCredentials).get()?.password).toBe("new");
  });
});

describe("imapForAccount", () => {
  it("throws AccountAuthError when the account has no credentials row", () => {
    const db = testDb();
    const account = saveImapAccount(db, { email: "h@x.com", settings: generic, username: "h@x.com", password: "pw" });
    db.delete(mailCredentials).where(eq(mailCredentials.accountId, account.id)).run();

    expect(() => imapForAccount(db, account.id)).toThrow(AccountAuthError);
  });

  it("throws AccountAuthError for a disconnected account even with credentials still stored", () => {
    const db = testDb();
    const account = saveImapAccount(db, { email: "h@x.com", settings: generic, username: "h@x.com", password: "pw" });
    db.update(accounts).set({ status: "disconnected" }).where(eq(accounts.id, account.id)).run();

    expect(() => imapForAccount(db, account.id)).toThrow(AccountAuthError);
  });

  it("returns an imap and an smtp client for a connected account", () => {
    const db = testDb();
    const account = saveImapAccount(db, { email: "h@x.com", settings: generic, username: "h@x.com", password: "pw" });

    const { imap, smtp } = imapForAccount(db, account.id);

    expect(typeof imap.fetchNew).toBe("function");
    expect(typeof smtp.send).toBe("function");
  });
});

describe("testImapLogin", () => {
  it("connects, reads the folder list, and closes", async () => {
    const fake = new FakeImapClient();

    await testImapLogin(generic, { username: "h@x.com", password: "pw" }, () => fake);

    expect(fake.connects).toBe(1);
    expect(fake.closes).toBe(1);
  });

  it("rethrows a login failure with a readable message and still closes", async () => {
    const fake = new FakeImapClient();
    fake.connectError = new Error("Invalid credentials (Failure)");

    await expect(testImapLogin(generic, { username: "h@x.com", password: "pw" }, () => fake)).rejects.toThrow(
      /IMAP login failed: Invalid credentials/,
    );
    expect(fake.closes).toBe(1);
  });
});
