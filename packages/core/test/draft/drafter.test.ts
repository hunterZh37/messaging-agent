import { describe, it, expect } from "vitest";
import { testDb } from "../helpers/db";
import { FakeProvider } from "../helpers/provider";
import { accounts, messages, threads } from "../../src/db/schema";
import { buildDraftContext } from "../../src/draft/context";
import { createDrafterFor } from "../../src/draft/drafter";

function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Lunch", lastMessageAt: 200, lastFromOperator: false }).run();
  const base = { accountId: "a1", rfcMessageId: null, ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1, subject: "Lunch", threadId: "a1:t1" };
  db.insert(messages)
    .values([
      { ...base, id: "a1:m1", providerMessageId: "m1", fromAddress: "bob@example.com", fromName: "Bob", toAddresses: ["me@example.com"], bodyText: "Does Friday work?", isFromOperator: false, sentAt: 200 },
    ])
    .run();
}

describe("revise", () => {
  it("asks for a rewrite of the current draft, with the thread and the operator's instruction", async () => {
    const db = testDb();
    seed(db);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: "Friday it is." });
    const drafter = createDrafterFor(provider);

    const out = await drafter.revise("my voice", buildDraftContext(db, "a1:m1"), "Friday works for me, thanks.", "shorter, and say I am out Monday");

    expect(out).toBe("Friday it is.");
    const req = provider.textRequests.at(-1)!;
    // Same cached system blocks as a draft: the rules and the voice file.
    expect(req.system.map((b) => b.cache)).toEqual([true, true]);
    expect(req.system[1]?.text).toContain("my voice");
    const user = req.messages.at(-1)!.content;
    expect(user).toContain("## Thread (oldest first)");
    expect(user).toContain("Does Friday work?");
    expect(user).toContain("# Current draft");
    expect(user).toContain("Friday works for me, thanks.");
    expect(user).toContain("# Instruction from the operator");
    expect(user).toContain("shorter, and say I am out Monday");
  });
});

describe("draft", () => {
  it("tells the model it may decline a reply, unless the operator asked for one anyway", async () => {
    const db = testDb();
    seed(db);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: "Friday works." });
    const drafter = createDrafterFor(provider);

    await drafter.draft("my voice", buildDraftContext(db, "a1:m1"));
    expect(provider.textRequests.at(-1)!.messages.at(-1)!.content).toContain("NO REPLY:");

    await drafter.draft("my voice", buildDraftContext(db, "a1:m1"), { force: true });
    const forced = provider.textRequests.at(-1)!.messages.at(-1)!.content;
    expect(forced).not.toContain("NO REPLY:");
    expect(forced).toContain("regardless");

    // A follow-up is the operator's own nudge: nothing to decline.
    await drafter.draft("my voice", buildDraftContext(db, "a1:m1", "follow-up"));
    expect(provider.textRequests.at(-1)!.messages.at(-1)!.content).not.toContain("NO REPLY:");
  });
});

/**
 * Asked to say something in particular (Ask Celeste, 2026-09-14), the
 * drafter is handed the operator's words after the thread and told every
 * point goes in; nothing is left to decline.
 */
describe("draft with an instruction", () => {
  it("puts the operator's words in the request and drops the decline rule", async () => {
    const db = testDb();
    seed(db);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: "Friday works, and I have reached out to Ryan." });
    const drafter = createDrafterFor(provider);

    await drafter.draft("my voice", buildDraftContext(db, "a1:m1"), { instruction: "say I have reached out to Ryan and ask for a final look" });
    const user = provider.textRequests.at(-1)!.messages.at(-1)!.content;
    expect(user).toContain("# What the operator asked this draft to say");
    expect(user).toContain("say I have reached out to Ryan and ask for a final look");
    expect(user).toContain("Every point in it goes into the draft");
    expect(user).not.toContain("NO REPLY:");
    // The thread comes first, the instruction after it.
    expect(user.indexOf("Does Friday work?")).toBeLessThan(user.indexOf("# What the operator asked"));
  });

  it("is the plain request again when the instruction is blank", async () => {
    const db = testDb();
    seed(db);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: "Friday works." });
    const drafter = createDrafterFor(provider);
    await drafter.draft("my voice", buildDraftContext(db, "a1:m1"), { instruction: "   " });
    const user = provider.textRequests.at(-1)!.messages.at(-1)!.content;
    expect(user).not.toContain("# What the operator asked");
    expect(user).toContain("NO REPLY:");
  });
});
