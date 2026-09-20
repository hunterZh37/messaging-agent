import { describe, it, expect } from "vitest";
import { testDb } from "../helpers/db";
import { FakeOutlookClient } from "../helpers/fakeOutlook";
import { accounts, messages, sorts } from "../../src/db/schema";
import { applyOutlookCategories } from "../../src/outlook/labels";

describe("applyOutlookCategories", () => {
  it("adds agent/important and agent/needs-reply once per sorted message, never removing existing categories", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "outlook", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    const base = { accountId: "a1", threadId: "a1:t1", rfcMessageId: null, fromName: null, toAddresses: [], ccAddresses: [], snippet: null, attachmentNames: [], isFromOperator: false, receivedAt: 1, subject: "s", bodyText: "b" };
    db.insert(messages).values([
      { ...base, id: "a1:m1", providerMessageId: "m1", fromAddress: "a@x.com", sentAt: 1 },
      { ...base, id: "a1:m2", providerMessageId: "m2", fromAddress: "b@x.com", sentAt: 2 },
      { ...base, id: "a1:m3", providerMessageId: "m3", fromAddress: "c@x.com", sentAt: 3 },
    ]).run();
    db.insert(sorts).values([
      { messageId: "a1:m1", wants: "reply", scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 },
      { messageId: "a1:m2", wants: "knowing", scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 },
      { messageId: "a1:m3", wants: "bin", scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 },
    ]).run();
    const client = new FakeOutlookClient();
    client.messageCategories.set("m1", ["personal"]);

    const r = await applyOutlookCategories(db, client, "a1", () => 999);
    expect(r).toEqual({ labeled: 3, failed: 0 });
    expect(client.categories).toEqual(new Set(["agent/important", "agent/needs-reply"]));
    expect(client.messageCategories.get("m1")).toEqual(["personal", "agent/important", "agent/needs-reply"]);
    expect(client.messageCategories.get("m2")).toEqual(["agent/important"]);
    expect(client.messageCategories.has("m3")).toBe(false);
    expect(db.select().from(sorts).all().every((s) => s.labeledAt === 999)).toBe(true);

    const again = await applyOutlookCategories(db, client, "a1");
    expect(again).toEqual({ labeled: 0, failed: 0 });
  });

  it("isolates a per-message failure: others still get labeled, the failing row stays unlabeled", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "outlook", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    const base = { accountId: "a1", threadId: "a1:t1", rfcMessageId: null, fromName: null, toAddresses: [], ccAddresses: [], snippet: null, attachmentNames: [], isFromOperator: false, receivedAt: 1, subject: "s", bodyText: "b" };
    db.insert(messages).values([
      { ...base, id: "a1:m1", providerMessageId: "m1", fromAddress: "a@x.com", sentAt: 1 },
      { ...base, id: "a1:m2", providerMessageId: "m2", fromAddress: "b@x.com", sentAt: 2 },
      { ...base, id: "a1:m3", providerMessageId: "m3", fromAddress: "c@x.com", sentAt: 3 },
    ]).run();
    db.insert(sorts).values([
      { messageId: "a1:m1", wants: "knowing", scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 },
      { messageId: "a1:m2", wants: "knowing", scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 },
      { messageId: "a1:m3", wants: "bin", scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 },
    ]).run();
    const client = new FakeOutlookClient();
    client.categoryFailures.add("m2");

    const r = await applyOutlookCategories(db, client, "a1", () => 999);
    expect(r).toEqual({ labeled: 2, failed: 1 });
    const rows = db.select().from(sorts).all();
    expect(rows.find((s) => s.messageId === "a1:m1")!.labeledAt).toBe(999);
    expect(rows.find((s) => s.messageId === "a1:m2")!.labeledAt).toBeNull();
    expect(rows.find((s) => s.messageId === "a1:m3")!.labeledAt).toBe(999);
  });

  it("does nothing when there is nothing to label", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "outlook", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    const client = new FakeOutlookClient();
    const r = await applyOutlookCategories(db, client, "a1");
    expect(r).toEqual({ labeled: 0, failed: 0 });
    expect(client.categories.size).toBe(0);
  });
});
