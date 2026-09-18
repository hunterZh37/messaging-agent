import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, draftRevisions, drafts, messages, sorts, threads } from "../../src/db/schema";
import { declined, draftForThread, draftPending, recordDraftRevision, reviseDraft, selectDraftCandidates } from "../../src/draft/run";
import type { DraftContext, Drafter } from "../../src/draft/types";
import { saveAliases } from "../../src/accounts/aliases";

/** Every fake drafter in this file answers a revision the same, deterministic way. */
const revise: Drafter["revise"] = async (_voice, _ctx, current, instruction) => `${current} (${instruction})`;

const DAY = 86_400_000;
const NOW = 100 * DAY;

function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  db.insert(threads).values([
    { id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "A", lastMessageAt: NOW - DAY, lastFromOperator: false },
    { id: "a1:t2", accountId: "a1", providerThreadId: "t2", subject: "B", lastMessageAt: NOW - DAY, lastFromOperator: true },
    { id: "a1:t3", accountId: "a1", providerThreadId: "t3", subject: "C", lastMessageAt: NOW - 10 * DAY, lastFromOperator: false },
    { id: "a1:t4", accountId: "a1", providerThreadId: "t4", subject: "D", lastMessageAt: NOW - DAY, lastFromOperator: false },
  ]).run();
  const base = { accountId: "a1", rfcMessageId: null, fromName: null, toAddresses: ["me@example.com"], ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1, isFromOperator: false, bodyText: "b" };
  db.insert(messages).values([
    { ...base, id: "a1:m1", providerMessageId: "m1", threadId: "a1:t1", fromAddress: "bob@x.com", subject: "A", sentAt: NOW - DAY },
    { ...base, id: "a1:m2", providerMessageId: "m2", threadId: "a1:t2", fromAddress: "bob@x.com", subject: "B", sentAt: NOW - 2 * DAY },
    { ...base, id: "a1:m3", providerMessageId: "m3", threadId: "a1:t3", fromAddress: "bob@x.com", subject: "C", sentAt: NOW - 10 * DAY },
    { ...base, id: "a1:m4", providerMessageId: "m4", threadId: "a1:t4", fromAddress: "news@x.com", subject: "D", sentAt: NOW - DAY },
  ]).run();
  const s = { scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 };
  db.insert(sorts).values([
    { ...s, messageId: "a1:m1", important: true, needsReply: true },
    { ...s, messageId: "a1:m2", important: true, needsReply: true },
    { ...s, messageId: "a1:m3", important: true, needsReply: true },
    { ...s, messageId: "a1:m4", important: true, needsReply: false },
  ]).run();
}

describe("selectDraftCandidates", () => {
  it("picks important + needs_reply latest messages in unreplied threads within 7 days, without a draft", () => {
    const db = testDb();
    seed(db);
    expect(selectDraftCandidates(db, () => NOW).map((m) => m.id)).toEqual(["a1:m1"]);
    db.insert(drafts).values({ id: "d1", threadId: "a1:t1", replyToMessageId: "a1:m1", originalText: "x", finalText: null, toAddresses: [], ccAddresses: [], status: "pending", model: "x", sentProviderMessageId: null, error: null, createdAt: 1, updatedAt: 1 }).run();
    expect(selectDraftCandidates(db, () => NOW)).toEqual([]);
  });

  it("does not draft again a message whose draft the operator skipped", () => {
    const db = testDb();
    seed(db);
    db.insert(drafts).values({ id: "d1", threadId: "a1:t1", replyToMessageId: "a1:m1", originalText: "x", finalText: null, toAddresses: [], ccAddresses: [], status: "skipped", model: "x", sentProviderMessageId: null, error: null, createdAt: 1, updatedAt: 1 }).run();
    expect(selectDraftCandidates(db, () => NOW)).toEqual([]);
    // A newer message in the same thread is a new question, drafted afresh.
    db.insert(messages).values({ accountId: "a1", rfcMessageId: null, fromName: null, toAddresses: ["me@example.com"], ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1, isFromOperator: false, bodyText: "b", id: "a1:m5", providerMessageId: "m5", threadId: "a1:t1", fromAddress: "bob@x.com", subject: "A", sentAt: NOW - DAY / 2 }).run();
    db.update(threads).set({ lastMessageAt: NOW - DAY / 2 }).where(eq(threads.id, "a1:t1")).run();
    db.insert(sorts).values({ scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1, messageId: "a1:m5", important: true, needsReply: true }).run();
    expect(selectDraftCandidates(db, () => NOW).map((m) => m.id)).toEqual(["a1:m5"]);
  });
});

describe("draftPending", () => {
  it("creates a pending draft with reply-all recipients", async () => {
    const db = testDb();
    seed(db);
    const drafter: Drafter = { model: "fake-drafter", draft: async () => "Sure, Friday works.", revise };
    const r = await draftPending(db, drafter, "voice", { clock: () => NOW });
    expect(r).toEqual({ drafted: 1, failed: 0, declined: 0 });
    const d = db.select().from(drafts).get();
    expect(d).toMatchObject({ threadId: "a1:t1", replyToMessageId: "a1:m1", originalText: "Sure, Friday works.", finalText: null, status: "pending", model: "fake-drafter", toAddresses: ["bob@x.com"], ccAddresses: [] });
  });

  it("records failures and continues", async () => {
    const db = testDb();
    seed(db);
    const drafter: Drafter = { model: "f", draft: async () => { throw new Error("nope"); }, revise };
    expect(await draftPending(db, drafter, "voice", { clock: () => NOW })).toEqual({ drafted: 0, failed: 1, declined: 0 });
    expect(db.select().from(drafts).all()).toEqual([]);
  });
});

function seedThread(db: ReturnType<typeof testDb>, opts: { lastFromOperator: boolean }) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Lunch", lastMessageAt: 200, lastFromOperator: opts.lastFromOperator }).run();
  const base = { accountId: "a1", threadId: "a1:t1", fromName: null, ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1, subject: "Lunch" };
  db.insert(messages)
    .values([
      { ...base, id: "a1:m1", providerMessageId: "m1", rfcMessageId: "<m1@x>", fromAddress: "me@example.com", toAddresses: ["bob@x.com"], bodyText: "When works?", isFromOperator: true, sentAt: 100 },
      opts.lastFromOperator
        ? { ...base, id: "a1:m2", providerMessageId: "m2", rfcMessageId: "<m2@x>", fromAddress: "me@example.com", toAddresses: ["bob@x.com"], bodyText: "Following up.", isFromOperator: true, sentAt: 200 }
        : { ...base, id: "a1:m2", providerMessageId: "m2", rfcMessageId: "<m2@x>", fromAddress: "bob@x.com", toAddresses: ["me@example.com"], bodyText: "Friday works.", isFromOperator: false, sentAt: 200 },
    ])
    .run();
}

describe("draftForThread", () => {
  it("creates a pending draft for the thread's latest inbound message, regardless of sorter flags", async () => {
    const db = testDb();
    seedThread(db, { lastFromOperator: false });
    const drafter: Drafter = { model: "fake-drafter", draft: async () => "Noon works for me.", revise };
    const r = await draftForThread(db, drafter, "voice", "a1:t1", { clock: () => 999 });
    expect(r).toMatchObject({ draftId: expect.any(String) });
    if (!("draftId" in r)) throw new Error("unexpected outcome");
    const d = db.select().from(drafts).where(eq(drafts.id, r.draftId)).get();
    expect(d).toMatchObject({
      threadId: "a1:t1",
      replyToMessageId: "a1:m2",
      originalText: "Noon works for me.",
      status: "pending",
      model: "fake-drafter",
      toAddresses: ["bob@x.com"],
      ccAddresses: [],
      createdAt: 999,
    });
  });

  it("hands the operator's instruction to the drafter and never reads the answer as a decline", async () => {
    const db = testDb();
    seedThread(db, { lastFromOperator: false });
    let seen: { force?: boolean; instruction?: string } | undefined;
    const drafter: Drafter = {
      model: "fake-drafter",
      draft: async (_voice, _ctx, opts) => {
        seen = opts;
        return "NO REPLY: I have reached out to Ryan.";
      },
      revise,
    };
    const r = await draftForThread(db, drafter, "voice", "a1:t1", { clock: () => 999, instruction: " say I have reached out to Ryan " });
    expect(seen).toEqual({ force: false, instruction: "say I have reached out to Ryan" });
    expect(r).toMatchObject({ draftId: expect.any(String) });
    if (!("draftId" in r)) throw new Error("unexpected outcome");
    expect(db.select().from(drafts).where(eq(drafts.id, r.draftId)).get()).toMatchObject({ status: "pending", originalText: "NO REPLY: I have reached out to Ryan." });
  });

  it("follows up when the operator sent the last message, to the people they wrote to", async () => {
    const db = testDb();
    seedThread(db, { lastFromOperator: true });
    let seen: DraftContext | null = null;
    const drafter: Drafter = {
      model: "fake-drafter",
      draft: async (_voice, ctx) => {
        seen = ctx;
        return "Just checking in on this.";
      },
      revise,
    };

    const r = await draftForThread(db, drafter, "voice", "a1:t1", { clock: () => 999 });
    expect(r).toMatchObject({ draftId: expect.any(String) });
    if (!("draftId" in r)) throw new Error("unexpected outcome");

    // The drafter is told this is a nudge, not an answer.
    expect(seen!.mode).toBe("follow-up");
    const d = db.select().from(drafts).where(eq(drafts.id, r.draftId)).get();
    expect(d).toMatchObject({
      // Threaded onto the operator's own last message, so it lands in place.
      replyToMessageId: "a1:m2",
      mode: "follow-up",
      status: "pending",
      // Their own message went to Bob, so the nudge goes to Bob, not to them.
      toAddresses: ["bob@x.com"],
      ccAddresses: [],
    });
  });

  it("leaves the operator's own addresses out of a follow-up, aliases included", async () => {
    const db = testDb();
    seedThread(db, { lastFromOperator: true });
    saveAliases(db, ["me@school.edu"]);
    // Their last message went to themselves under another address, and to Bob.
    db.update(messages).set({ toAddresses: ["me@school.edu", "Bob@X.com"], ccAddresses: ["me@example.com"] }).where(eq(messages.id, "a1:m2")).run();

    const drafter: Drafter = { model: "f", draft: async () => "Checking in.", revise };
    const r = await draftForThread(db, drafter, "voice", "a1:t1");
    if (!("draftId" in r)) throw new Error("unexpected outcome");
    const d = db.select().from(drafts).where(eq(drafts.id, r.draftId)).get()!;
    expect(d.toAddresses).toEqual(["bob@x.com"]);
    expect(d.ccAddresses).toEqual([]);
  });

  it("falls back to whoever wrote last when the operator wrote only to themselves", async () => {
    const db = testDb();
    seedThread(db, { lastFromOperator: true });
    db.update(messages).set({ toAddresses: ["me@example.com"], ccAddresses: [] }).where(eq(messages.id, "a1:m2")).run();
    // The thread still has an inbound message from Bob earlier on.
    db.insert(messages)
      .values({
        id: "a1:m0", accountId: "a1", providerMessageId: "m0", threadId: "a1:t1", rfcMessageId: "<m0@x>", fromAddress: "bob@x.com",
        fromName: null, toAddresses: ["me@example.com"], ccAddresses: [], subject: "Lunch", bodyText: "Any news?", bodyHtml: null,
        snippet: null, attachmentNames: [], isFromOperator: false, sentAt: 50, receivedAt: 1,
      })
      .run();

    const drafter: Drafter = { model: "f", draft: async () => "Checking in.", revise };
    const r = await draftForThread(db, drafter, "voice", "a1:t1");
    if (!("draftId" in r)) throw new Error("unexpected outcome");
    expect(db.select().from(drafts).where(eq(drafts.id, r.draftId)).get()!.toAddresses).toEqual(["bob@x.com"]);
  });

  it("still calls an answer an answer", async () => {
    const db = testDb();
    seedThread(db, { lastFromOperator: false });
    let seen: DraftContext | null = null;
    const drafter: Drafter = { model: "f", draft: async (_v, ctx) => { seen = ctx; return "Noon works."; }, revise };
    const r = await draftForThread(db, drafter, "voice", "a1:t1");
    if (!("draftId" in r)) throw new Error("unexpected outcome");
    expect(seen!.mode).toBe("reply");
    expect(db.select().from(drafts).where(eq(drafts.id, r.draftId)).get()!.mode).toBe("reply");
  });

  it("returns an error for an unknown thread", async () => {
    const db = testDb();
    seedThread(db, { lastFromOperator: false });
    const drafter: Drafter = { model: "fake-drafter", draft: async () => "x", revise };
    const r = await draftForThread(db, drafter, "voice", "nope");
    expect(r).toMatchObject({ error: expect.any(String) });
  });
});

function seedPendingDraft(db: ReturnType<typeof testDb>, status: "pending" | "sent" = "pending") {
  seedThread(db, { lastFromOperator: false });
  db.insert(drafts)
    .values({
      id: "d1", threadId: "a1:t1", replyToMessageId: "a1:m2", originalText: "Friday works.", finalText: null,
      toAddresses: ["bob@x.com"], ccAddresses: [], status, model: "x", sentProviderMessageId: null, error: null,
      createdAt: 1, updatedAt: 1,
    })
    .run();
}

describe("reviseDraft", () => {
  it("returns the rewritten text and remembers the revision", async () => {
    const db = testDb();
    seedPendingDraft(db);
    let seen: { current: string; instruction: string } | null = null;
    const drafter: Drafter = {
      model: "fake-drafter",
      draft: async () => "x",
      revise: async (_voice, _ctx, current, instruction) => {
        seen = { current, instruction };
        return "Friday works. I am out Monday.";
      },
    };

    const r = await reviseDraft(db, drafter, "voice", "d1", "Friday works.", "add that I am out Monday", () => 555);
    expect(r.text).toBe("Friday works. I am out Monday.");
    expect(seen!).toEqual({ current: "Friday works.", instruction: "add that I am out Monday" });

    const rev = db.select().from(draftRevisions).where(eq(draftRevisions.id, r.revisionId)).get()!;
    expect(rev).toMatchObject({
      draftId: "d1",
      instruction: "add that I am out Monday",
      before: "Friday works.",
      after: "Friday works. I am out Monday.",
      model: "fake-drafter",
      createdAt: 555,
    });
  });

  it("leaves the draft's own text alone: what the operator sends is theirs to decide", async () => {
    const db = testDb();
    seedPendingDraft(db);
    const drafter: Drafter = { model: "f", draft: async () => "x", revise: async () => "Something else entirely." };
    await reviseDraft(db, drafter, "voice", "d1", "Friday works.", "rewrite it");
    const d = db.select().from(drafts).where(eq(drafts.id, "d1")).get()!;
    expect(d.originalText).toBe("Friday works.");
    expect(d.finalText).toBe(null);
  });

  it("refuses a draft that is no longer pending", async () => {
    const db = testDb();
    seedPendingDraft(db, "sent");
    const drafter: Drafter = { model: "f", draft: async () => "x", revise: async () => "y" };
    await expect(reviseDraft(db, drafter, "voice", "d1", "t", "shorter")).rejects.toThrow(/not pending/);
    expect(db.select().from(draftRevisions).all()).toEqual([]);
  });

  it("refuses a draft it cannot find", async () => {
    const db = testDb();
    seedPendingDraft(db);
    const drafter: Drafter = { model: "f", draft: async () => "x", revise: async () => "y" };
    await expect(reviseDraft(db, drafter, "voice", "nope", "t", "shorter")).rejects.toThrow(/not found/);
  });
});

describe("recordDraftRevision", () => {
  it("remembers a revision the operator applied from elsewhere, with no model call", () => {
    const db = testDb();
    seedPendingDraft(db);

    const revisionId = recordDraftRevision(
      db,
      { draftId: "d1", instruction: "from Ask Celeste: make it shorter", before: "Friday works.", after: "Friday works. Ten?", model: "claude-sonnet-5" },
      () => 777,
    );

    expect(db.select().from(draftRevisions).where(eq(draftRevisions.id, revisionId)).get()).toMatchObject({
      draftId: "d1",
      instruction: "from Ask Celeste: make it shorter",
      before: "Friday works.",
      after: "Friday works. Ten?",
      model: "claude-sonnet-5",
      createdAt: 777,
    });
    // The draft itself is untouched, exactly as after a revision in the card.
    const d = db.select().from(drafts).where(eq(drafts.id, "d1")).get()!;
    expect(d.originalText).toBe("Friday works.");
    expect(d.finalText).toBe(null);
  });

  it("refuses a draft that is gone or no longer pending", () => {
    const db = testDb();
    seedPendingDraft(db, "sent");
    const row = { instruction: "i", before: "a", after: "b", model: "m" };
    expect(() => recordDraftRevision(db, { draftId: "d1", ...row })).toThrow(/not pending/);
    expect(() => recordDraftRevision(db, { draftId: "nope", ...row })).toThrow(/not found/);
    expect(db.select().from(draftRevisions).all()).toEqual([]);
  });
});

describe("a drafter that sees nothing to answer", () => {
  // Seen live, 2026-09-11: an automated invoice notice came back as a
  // "reply" reading "this doesn't need a reply", ready to send.
  it("reads the one NO REPLY line and nothing else", () => {
    expect(declined("NO REPLY: an automated invoice notice")).toBe("an automated invoice notice");
    expect(declined("  no reply:  ")).toBe("Nothing here asks for an answer.");
    expect(declined("Sure, Friday works.")).toBeNull();
    expect(declined("NO REPLY: x\n\nBut here is a draft anyway")).toBeNull();
  });

  it("keeps a declined row instead of a pending draft, and does not ask again", async () => {
    const db = testDb();
    seedThread(db, { lastFromOperator: false });
    let calls = 0;
    const drafter: Drafter = { model: "f", draft: async () => { calls++; return "NO REPLY: a receipt"; }, revise };
    const r = await draftForThread(db, drafter, "voice", "a1:t1", { clock: () => 999 });
    expect(r).toEqual({ declined: "a receipt" });
    const rows = db.select().from(drafts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "declined", originalText: "a receipt", replyToMessageId: "a1:m2" });
    // The pipeline leaves a declined message alone.
    db.insert(sorts).values({ messageId: "a1:m2", important: true, needsReply: true, scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 }).run();
    const p = await draftPending(db, drafter, "voice", { clock: () => 999 });
    expect(p).toEqual({ drafted: 0, failed: 0, declined: 0 });
    expect(calls).toBe(1);
  });

  it("writes the draft when the operator says to draft anyway", async () => {
    const db = testDb();
    seedThread(db, { lastFromOperator: false });
    let forced: boolean | undefined;
    const drafter: Drafter = {
      model: "f",
      draft: async (_voice, _ctx, opts) => {
        forced = opts?.force;
        return "Thanks, received.";
      },
      revise,
    };
    const r = await draftForThread(db, drafter, "voice", "a1:t1", { clock: () => 999, force: true });
    expect(forced).toBe(true);
    expect(r).toMatchObject({ draftId: expect.any(String) });
    expect(db.select().from(drafts).all()[0]).toMatchObject({ status: "pending", originalText: "Thanks, received." });
  });

  it("counts a decline in the pipeline as neither drafted nor failed", async () => {
    const db = testDb();
    seed(db);
    const drafter: Drafter = { model: "f", draft: async () => "NO REPLY: a newsletter", revise };
    const r = await draftPending(db, drafter, "voice", { clock: () => NOW });
    expect(r).toEqual({ drafted: 0, failed: 0, declined: 1 });
    expect(db.select().from(drafts).all().map((d) => d.status)).toEqual(["declined"]);
  });
});
