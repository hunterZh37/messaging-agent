import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accountRow, testConfig, testDb } from "../helpers/db";
import { FakeOutlookClient, fakeGraphMessage } from "../helpers/fakeOutlook";
import { syncOutlookAccount } from "../../src/outlook/sync";
import { refreshOutlookBodies } from "../../src/outlook/bodies";
import { accounts, messages } from "../../src/db/schema";

const testCfg = testConfig();

describe("refreshOutlookBodies", () => {
  // Operator, 2026-09-11: Outlook mail synced as text showed "[Amazon logo]"
  // placeholders and blank gaps where the images were.
  it("puts the HTML back on mail that was stored as text, and derives the text from it", async () => {
    const db = testDb();
    const acct = accountRow({ id: "a1", provider: "outlook", email: "me@example.com" });
    db.insert(accounts).values(acct).run();
    const client = new FakeOutlookClient();
    client.addMessage("inbox", fakeGraphMessage({ id: "i1", conversationId: "t1", from: "bob@example.com", date: 100, body: "Ordered 2 items" }));
    await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });
    expect(db.select().from(messages).where(eq(messages.id, "a1:i1")).get()?.bodyHtml).toBeNull();

    // The mailbox has always held HTML; only the earlier sync asked for text.
    client.stored.inbox[0]!.body = { contentType: "html", content: '<p>Ordered <b>2</b> items</p><img src="https://x/logo.png" alt="Amazon logo">' };

    const result = await refreshOutlookBodies(db, client, "a1");
    expect(result).toEqual({ checked: 1, updated: 1, failed: 0 });
    const row = db.select().from(messages).where(eq(messages.id, "a1:i1")).get()!;
    expect(row.bodyHtml).toContain('<img src="https://x/logo.png"');
    expect(row.bodyText).toContain("Ordered 2 items");
    expect(row.bodyText).not.toContain("<b>");
  });

  it("leaves text mail alone, skips mail that already has HTML, and counts what Graph no longer has", async () => {
    const db = testDb();
    const acct = accountRow({ id: "a1", provider: "outlook", email: "me@example.com" });
    db.insert(accounts).values(acct).run();
    const client = new FakeOutlookClient();
    client.addMessage("inbox", fakeGraphMessage({ id: "plain", conversationId: "t1", from: "bob@example.com", date: 100, body: "just words" }));
    client.addMessage("inbox", fakeGraphMessage({ id: "rich", conversationId: "t2", from: "bob@example.com", date: 101, body: "<p>rich</p>", html: true }));
    client.addMessage("inbox", fakeGraphMessage({ id: "gone", conversationId: "t3", from: "bob@example.com", date: 102, body: "gone" }));
    await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });
    client.stored.inbox = client.stored.inbox.filter((m) => m.id !== "gone");

    const result = await refreshOutlookBodies(db, client, "a1");
    expect(result).toEqual({ checked: 2, updated: 0, failed: 1 });
    expect(client.bodyCalls.sort()).toEqual(["gone", "plain"]);
    expect(db.select().from(messages).where(eq(messages.id, "a1:plain")).get()?.bodyText).toBe("just words");
    expect(db.select().from(messages).where(eq(messages.id, "a1:gone")).get()?.bodyText).toBe("gone");
  });
});
