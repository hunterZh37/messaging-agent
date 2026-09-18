import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testConfig, testDb } from "./helpers/db";
import { FakeOutlookClient, fakeGraphMessage } from "./helpers/fakeOutlook";
import { FakeImapClient, FakeSmtpClient, fakeMessage } from "./helpers/fakeImap";
import { accounts, mailCredentials, messages, oauthTokens, sorts, type AccountRow } from "../src/db/schema";
import { saveImapAccount } from "../src/imap/credentials";
import { applyImapLabels } from "../src/imap/labels";
import { restoreImapMessages, trashImapMessages } from "../src/imap/trash";
import { imapSender } from "../src/imap/sender";
import { fetchImapAttachment, fetchOutlookAttachment } from "../src/attachments/fetch";
import { backfillImapAccount, syncImapAccount } from "../src/imap/sync";
import { GMAIL_SETTINGS, type ImapClient, type SmtpClient } from "../src/imap/types";
import { disconnectAccount, runPipeline, runPipelineForAccount } from "../src/pipeline";
import { applyOutlookCategories } from "../src/outlook/labels";
import { restoreOutlookMessages, trashOutlookMessages } from "../src/outlook/trash";
import { outlookSender } from "../src/outlook/sender";
import { backfillOutlookAccount, syncOutlookAccount } from "../src/outlook/sync";
import type { OutlookClient } from "../src/outlook/types";
import { AccountAuthError, type MailConnector } from "../src/connectors/types";
import type { Sorter } from "../src/sort/types";
import type { Drafter } from "../src/draft/types";

const testCfg = testConfig();

function scriptedSorter(): Sorter {
  return {
    model: "test-sorter",
    async sort() {
      return { important: true, needs_reply: true, scheduling: false, category: "Needs reply", finance: "none" as const, disposable: false, project: "None", reason: "test" };
    },
  };
}

function fakeDrafter(): Drafter {
  return {
    model: "test-drafter",
    async draft() {
      return "Thanks, got it.";
    },
    async revise(_voice, _ctx, current, instruction) {
      return `${current} (${instruction})`;
    },
  };
}

const notCalled = () => {
  throw new Error("should not be called for the failing account");
};

/** Wraps a fake provider client as a MailConnector, exactly how connectors/index.ts wires the real thing. */
function imapConnector(imap: ImapClient, smtp: SmtpClient): MailConnector {
  return {
    sync: (db, account, opts) => syncImapAccount(db, testCfg, imap, account, opts),
    backfill: (db, account, opts) => backfillImapAccount(db, testCfg, imap, account, opts),
    applyLabels: (db, accountId) => applyImapLabels(db, imap, accountId),
    fetchAttachment: (db, account, att) => fetchImapAttachment(imap, att.messageId, att),
    trash: (db, account, messageIds) => trashImapMessages(db, imap, messageIds),
    restore: (db, account, messageIds) => restoreImapMessages(db, imap, messageIds),
    sender: imapSender(smtp),
  };
}

function outlookConnector(client: OutlookClient): MailConnector {
  return {
    sync: (db, account, opts) => syncOutlookAccount(db, testCfg, client, account, opts),
    backfill: (db, account, opts) => backfillOutlookAccount(db, testCfg, client, account, opts),
    applyLabels: (db, accountId) => applyOutlookCategories(db, client, accountId),
    fetchAttachment: (db, account, att) => fetchOutlookAttachment(client, att.messageId, att),
    trash: (db, account, messageIds) => trashOutlookMessages(db, client, messageIds),
    restore: (db, account, messageIds) => restoreOutlookMessages(db, client, messageIds),
    sender: outlookSender(client),
  };
}

describe("runPipeline", () => {
  it("syncs each account through its own provider connector (isolating per-account failures), sorts, labels, drafts, and counts pending", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "one@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(accounts).values({ id: "a2", provider: "imap", email: "two@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(accounts).values({ id: "a3", provider: "outlook", email: "three@example.com", displayName: null, createdAt: 1 }).run();

    const imapA = new FakeImapClient();
    imapA.add("INBOX", fakeMessage({ uid: 1, from: "friend@example.com", to: "one@example.com", subject: "Hi", body: "Can we meet?", date: Date.now() }));
    imapA.add("INBOX", fakeMessage({ uid: 2, from: "other@example.com", to: "one@example.com", subject: "Question", body: "What do you think?", date: Date.now(), messageId: "<q1@x>" }));

    const imapB = new FakeImapClient();
    imapB.connectError = new Error("account suspended");

    const outlookC = new FakeOutlookClient();
    outlookC.email = "three@example.com";
    outlookC.addMessage("inbox", fakeGraphMessage({ id: "o1", conversationId: "ot1", from: "friend@example.com", subject: "Hi", body: "Lunch?", date: Date.now() }));

    const connectors = new Map<string, MailConnector>([
      ["a1", imapConnector(imapA, new FakeSmtpClient())],
      ["a2", imapConnector(imapB, new FakeSmtpClient())],
      ["a3", outlookConnector(outlookC)],
    ]);

    const result = await runPipeline(db, {
      connectorFor: (account: AccountRow) => connectors.get(account.id)!,
      sorter: scriptedSorter(),
      drafter: fakeDrafter(),
      backfillDays: 7,
      blocklist: new Set(),
      criteria: "criteria",
      voice: "voice",
    });

    const a1Result = result.accounts.find((a) => a.email === "one@example.com");
    const a2Result = result.accounts.find((a) => a.email === "two@example.com");
    const a3Result = result.accounts.find((a) => a.email === "three@example.com");

    expect(a1Result?.sync?.mode).toBe("backfill");
    expect(a1Result?.sync?.stored).toBe(2);
    expect(a1Result?.syncError).toBeUndefined();
    expect(a1Result?.labeled).toBe(2);
    expect(a1Result?.labelFailed).toBe(0);

    expect(a2Result?.syncError).toMatch(/account suspended/);
    expect(a2Result?.sync).toBeUndefined();

    expect(a3Result?.sync?.mode).toBe("backfill");
    expect(a3Result?.sync?.stored).toBe(1);
    expect(a3Result?.labeled).toBe(1);

    expect(result.sorted).toBe(3);
    expect(result.sortFailed).toBe(0);
    expect(result.drafted).toBe(3);
    expect(result.draftFailed).toBe(0);
    expect(result.pending).toBe(3);
  });

  it("skips drafting entirely when drafter is null", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "one@example.com", displayName: null, createdAt: 1 }).run();

    const imapA = new FakeImapClient();
    imapA.add("INBOX", fakeMessage({ uid: 1, from: "friend@example.com", to: "one@example.com", subject: "Hi", body: "Can we meet?", date: Date.now() }));

    const result = await runPipeline(db, {
      connectorFor: () => imapConnector(imapA, new FakeSmtpClient()),
      sorter: scriptedSorter(),
      drafter: null,
      backfillDays: 7,
      blocklist: new Set(),
      criteria: "criteria",
      voice: "voice",
    });

    expect(result.drafted).toBe(0);
    expect(result.draftFailed).toBe(0);
    expect(result.pending).toBe(0);
  });

  it("isolates an account whose connectorFor throws synchronously (e.g. missing credentials), without aborting the others", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "one@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(accounts).values({ id: "a2", provider: "outlook", email: "two@example.com", displayName: null, createdAt: 1 }).run();

    const imapA = new FakeImapClient();
    imapA.add("INBOX", fakeMessage({ uid: 1, from: "friend@example.com", to: "one@example.com", subject: "Hi", body: "Can we meet?", date: Date.now() }));

    const result = await runPipeline(db, {
      connectorFor: (account) => {
        if (account.provider === "outlook") throw new Error("MICROSOFT_CLIENT_ID must be set in .env");
        return imapConnector(imapA, new FakeSmtpClient());
      },
      sorter: scriptedSorter(),
      drafter: null,
      backfillDays: 7,
      blocklist: new Set(),
      criteria: "criteria",
      voice: "voice",
    });

    const a1Result = result.accounts.find((a) => a.email === "one@example.com");
    const a2Result = result.accounts.find((a) => a.email === "two@example.com");
    expect(a1Result?.sync?.stored).toBe(1);
    expect(a1Result?.syncError).toBeUndefined();
    expect(a2Result?.syncError).toMatch(/MICROSOFT_CLIENT_ID/);
    expect(a2Result?.labelError).toMatch(/MICROSOFT_CLIENT_ID/);
  });

  it("sets accounts.status to needs_signin and records lastError when a connector throws AccountAuthError during sync, without touching other accounts", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "one@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(accounts).values({ id: "a2", provider: "imap", email: "two@example.com", displayName: null, createdAt: 1 }).run();

    const imapA = new FakeImapClient();
    imapA.add("INBOX", fakeMessage({ uid: 1, from: "friend@example.com", to: "one@example.com", subject: "Hi", body: "Can we meet?", date: Date.now() }));

    const failingConnector: MailConnector = {
      sync: () => {
        throw new AccountAuthError("a2", "IMAP login failed for two@example.com: Invalid credentials");
      },
      backfill: notCalled,
      applyLabels: async () => ({ labeled: 0, failed: 0 }),
      fetchAttachment: notCalled,
      trash: notCalled,
      restore: notCalled,
      sender: { sendReply: notCalled },
    };

    const connectors = new Map<string, MailConnector>([
      ["a1", imapConnector(imapA, new FakeSmtpClient())],
      ["a2", failingConnector],
    ]);

    await runPipeline(db, {
      connectorFor: (account) => connectors.get(account.id)!,
      sorter: scriptedSorter(),
      drafter: null,
      backfillDays: 7,
      blocklist: new Set(),
      criteria: "criteria",
      voice: "voice",
    });

    const a1 = db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
    const a2 = db.select().from(accounts).where(eq(accounts.id, "a2")).get()!;
    expect(a1.status).toBe("ok");
    expect(a1.lastError).toBeNull();
    expect(a2.status).toBe("needs_signin");
    expect(a2.lastError).toMatch(/Invalid credentials/);
  });

  it("restores status ok and clears lastError on the next successful sync", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "one@example.com", displayName: null, createdAt: 1, status: "needs_signin", lastError: "IMAP login failed" }).run();

    const imapA = new FakeImapClient();
    imapA.add("INBOX", fakeMessage({ uid: 1, from: "friend@example.com", to: "one@example.com", subject: "Hi", body: "Can we meet?", date: Date.now() }));

    await runPipeline(db, {
      connectorFor: () => imapConnector(imapA, new FakeSmtpClient()),
      sorter: scriptedSorter(),
      drafter: null,
      backfillDays: 7,
      blocklist: new Set(),
      criteria: "criteria",
      voice: "voice",
    });

    const a1 = db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
    expect(a1.status).toBe("ok");
    expect(a1.lastError).toBeNull();
  });

  it("a plain (non-AccountAuthError) sync failure leaves accounts.status untouched", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "outlook", email: "one@example.com", displayName: null, createdAt: 1 }).run();

    await runPipeline(db, {
      connectorFor: () => {
        throw new Error("MICROSOFT_CLIENT_ID must be set in .env");
      },
      sorter: scriptedSorter(),
      drafter: null,
      backfillDays: 7,
      blocklist: new Set(),
      criteria: "criteria",
      voice: "voice",
    });

    const a1 = db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
    expect(a1.status).toBe("ok");
    expect(a1.lastError).toBeNull();
  });

  it("runPipelineForAccount syncs only the given account, but sort and draft still run over every pending message", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "one@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(accounts).values({ id: "a2", provider: "imap", email: "two@example.com", displayName: null, createdAt: 1 }).run();

    const imapA = new FakeImapClient();
    imapA.add("INBOX", fakeMessage({ uid: 1, from: "friend@example.com", to: "one@example.com", subject: "Hi", body: "Can we meet?", date: Date.now() }));

    const connectors = new Map<string, MailConnector>([
      ["a1", imapConnector(imapA, new FakeSmtpClient())],
      ["a2", { sync: notCalled, backfill: notCalled, applyLabels: async () => ({ labeled: 0, failed: 0 }), fetchAttachment: notCalled, trash: notCalled, restore: notCalled, sender: { sendReply: notCalled } }],
    ]);

    const result = await runPipelineForAccount(
      db,
      {
        connectorFor: (account) => connectors.get(account.id)!,
        sorter: scriptedSorter(),
        drafter: fakeDrafter(),
        backfillDays: 7,
        blocklist: new Set(),
        criteria: "criteria",
        voice: "voice",
      },
      "a1",
    );

    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.email).toBe("one@example.com");
    expect(result.sorted).toBe(1);
    expect(result.drafted).toBe(1);
  });
});

describe("runPipeline over an imap inbox", () => {
  it("syncs, sorts, labels and drafts one imap account end to end", async () => {
    const db = testDb();
    const account = saveImapAccount(db, { email: "one@example.com", settings: GMAIL_SETTINGS, username: "one@example.com", password: "pw" });
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 1, from: "friend@example.com", to: "one@example.com", subject: "Hi", body: "Can we meet?", date: Date.now() }));

    const result = await runPipeline(db, {
      connectorFor: () => imapConnector(imap, new FakeSmtpClient()),
      sorter: scriptedSorter(),
      drafter: fakeDrafter(),
      backfillDays: 7,
      blocklist: new Set(),
      criteria: "criteria",
      voice: "voice",
    });

    expect(result.accounts[0]?.sync).toMatchObject({ mode: "backfill", stored: 1 });
    expect(result.sorted).toBe(1);
    expect(result.accounts[0]?.labeled).toBe(1);
    expect(result.drafted).toBe(1);
    expect(result.pending).toBe(1);
    expect(imap.labelCalls).toEqual([{ folder: "INBOX", uid: 1, labels: ["agent/important", "agent/needs-reply"] }]);
    expect(db.select().from(sorts).all().every((s) => s.labeledAt !== null)).toBe(true);
    expect(db.select().from(accounts).where(eq(accounts.id, account.id)).get()?.status).toBe("ok");
  });
});

describe("disconnectAccount", () => {
  it("deletes the stored imap password and marks the inbox disconnected, keeping its mail", async () => {
    const db = testDb();
    const account = saveImapAccount(db, { email: "one@example.com", settings: GMAIL_SETTINGS, username: "one@example.com", password: "pw" });
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 1, from: "friend@example.com" }));
    await syncImapAccount(db, testCfg, imap, account, { backfillDays: 7, blocklist: new Set() });

    disconnectAccount(db, account.id);

    expect(db.select().from(mailCredentials).all()).toHaveLength(0);
    expect(db.select().from(accounts).where(eq(accounts.id, account.id)).get()?.status).toBe("disconnected");
    expect(db.select().from(messages).all()).toHaveLength(1);
  });

  it("removes the token row, marks the account disconnected, and keeps messages", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "one@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(oauthTokens).values({ accountId: "a1", refreshToken: "r", accessToken: "a", expiryDate: Date.now() + 60_000, scope: null }).run();

    const imapA = new FakeImapClient();
    imapA.add("INBOX", fakeMessage({ uid: 1, from: "friend@example.com", to: "one@example.com", subject: "Hi", body: "Can we meet?", date: Date.now() }));
    await syncImapAccount(db, testCfg, imapA, db.select().from(accounts).where(eq(accounts.id, "a1")).get()!, { backfillDays: 7, blocklist: new Set() });

    disconnectAccount(db, "a1");

    const tok = db.select().from(oauthTokens).where(eq(oauthTokens.accountId, "a1")).get();
    expect(tok).toBeUndefined();
    const account = db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
    expect(account.status).toBe("disconnected");

    expect(db.select().from(messages).all()).toHaveLength(1);
  });
});
