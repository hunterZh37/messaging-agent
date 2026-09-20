import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, messages, senderRules, sorts, threads } from "../../src/db/schema";
import { OPERATOR, clearSenderRule, correctThread, listSenderRules, senderRuleFor, sendersOf, setSenderRule, withSenderRules } from "../../src/sort/corrections";
import { resortWindow } from "../../src/sort/run";
import { NO_PROJECT, type Sorter, type SortResult } from "../../src/sort/types";

/**
 * Corrections (operator, 2026-09-20). Two things make one worth making: it
 * survives the next re-sort, and it can reach forward to the sender.
 */
function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "s", lastMessageAt: 1, lastFromOperator: false }).run();
  const base = { accountId: "a1", threadId: "a1:t1", rfcMessageId: null, toAddresses: ["me@example.com"], ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1 };
  db.insert(messages)
    .values([
      { ...base, id: "a1:m1", providerMessageId: "m1", fromAddress: "alerts@zillow.test", fromName: "Zillow", subject: "New rental", bodyText: "A house", isFromOperator: false, sentAt: 100 },
      { ...base, id: "a1:m2", providerMessageId: "m2", fromAddress: "me@example.com", fromName: null, subject: "Re", bodyText: "ok", isFromOperator: true, sentAt: 200 },
    ])
    .run();
  const v = { scheduling: false, category: "FYI", finance: "none" as const, reason: "a model said so", model: "some:model", labeledAt: null, createdAt: 1 };
  db.insert(sorts).values([{ ...v, messageId: "a1:m1", wants: "reply" as const }, { ...v, messageId: "a1:m2", wants: "reply" as const }]).run();
  return db;
}

const verdicts = (db: ReturnType<typeof testDb>) => db.select().from(sorts).all();

describe("correcting a thread", () => {
  it("moves every message of the thread, and stamps them as the operator's", () => {
    const db = seed(testDb());
    expect(correctThread(db, "a1:t1", "bin")).toBe(2);
    expect(verdicts(db).every((v) => v.wants === "bin")).toBe(true);
    expect(verdicts(db).every((v) => v.model === OPERATOR)).toBe(true);
  });

  it("says so in the reason, where a model's guess used to be", () => {
    const db = seed(testDb());
    correctThread(db, "a1:t1", "knowing");
    expect(verdicts(db)[0]?.reason).toBe("You put this here.");
  });

  it("drops the sub-category on the way to the bin, as the sorter does", () => {
    const db = seed(testDb());
    correctThread(db, "a1:t1", "bin");
    expect(verdicts(db).every((v) => v.category === null)).toBe(true);
  });

  it("keeps the sub-category on any other rung", () => {
    const db = seed(testDb());
    correctThread(db, "a1:t1", "action");
    expect(verdicts(db).every((v) => v.category === "FYI")).toBe(true);
  });

  it("says nothing changed for a thread that does not exist", () => {
    expect(correctThread(seed(testDb()), "a1:nope", "bin")).toBe(0);
  });

  it("names who a rule would be about, leaving the operator out of it", () => {
    expect(sendersOf(seed(testDb()), "a1:t1")).toEqual(["alerts@zillow.test"]);
  });
});

/** The half that makes it worth doing: a re-sort must not undo it. */
describe("a correction against a re-sort", () => {
  const always = (wants: SortResult["wants"]): Sorter => ({
    model: "some:model",
    async sort() {
      return { wants, scheduling: false, category: "FYI", finance: "none", project: NO_PROJECT, reason: "the model again" };
    },
  });

  it("is left alone by resortWindow, whatever the model now says", async () => {
    const db = seed(testDb());
    correctThread(db, "a1:t1", "bin");
    const r = await resortWindow(db, always("reply"), "criteria", { since: 0 });
    expect(r.resorted).toBe(0);
    expect(verdicts(db).every((v) => v.wants === "bin")).toBe(true);
    expect(verdicts(db)[0]?.reason).toBe("You put this here.");
  });

  it("still re-sorts everything the operator has not touched", async () => {
    const db = seed(testDb());
    const r = await resortWindow(db, always("knowing"), "criteria", { since: 0 });
    expect(r.resorted).toBeGreaterThan(0);
  });
});

describe("a standing rule about a sender", () => {
  it("is written, read and cleared, whatever the case of the address", () => {
    const db = seed(testDb());
    setSenderRule(db, "Alerts@Zillow.test", "bin", () => 5);
    expect(senderRuleFor(db, "alerts@zillow.test")?.wants).toBe("bin");
    expect(senderRuleFor(db, "ALERTS@ZILLOW.TEST")?.wants).toBe("bin");
    clearSenderRule(db, "alerts@zillow.test");
    expect(senderRuleFor(db, "alerts@zillow.test")).toBeUndefined();
  });

  it("reads an address out of a display name", () => {
    const db = seed(testDb());
    setSenderRule(db, '"Zillow" <alerts@zillow.test>', "bin", () => 5);
    expect(senderRuleFor(db, "alerts@zillow.test")?.wants).toBe("bin");
  });

  it("replaces rather than duplicates when the operator changes their mind", () => {
    const db = seed(testDb());
    setSenderRule(db, "alerts@zillow.test", "bin", () => 5);
    setSenderRule(db, "alerts@zillow.test", "knowing", () => 6);
    expect(listSenderRules(db)).toHaveLength(1);
    expect(senderRuleFor(db, "alerts@zillow.test")?.wants).toBe("knowing");
  });
});

describe("the sorter that reads the rules first", () => {
  let asked = 0;
  const counting: Sorter = {
    model: "some:model",
    async sort() {
      asked++;
      return { wants: "reply", scheduling: true, category: "Needs reply", finance: "expense", project: NO_PROJECT, reason: "the model" };
    },
  };
  const input = {
    id: "a1:m1",
    fromAddress: "alerts@zillow.test",
    fromName: "Zillow",
    subject: "New rental",
    bodyText: "A house",
    attachmentNames: [],
    sentAt: 100,
  };

  it("never asks the model about a sender the operator has ruled on", async () => {
    const db = seed(testDb());
    setSenderRule(db, "alerts@zillow.test", "bin", () => 5);
    asked = 0;
    const r = await withSenderRules(db, counting).sort("c", [], [], input);
    expect(asked).toBe(0);
    expect(r.wants).toBe("bin");
    expect(r.reason).toContain("everything from alerts@zillow.test");
  });

  it("asks the model about everybody else", async () => {
    const db = seed(testDb());
    asked = 0;
    const r = await withSenderRules(db, counting).sort("c", [], [], input);
    expect(asked).toBe(1);
    expect(r.wants).toBe("reply");
  });

  /**
   * A rule decides the rung and nothing else. Unfiling a client's mail as a
   * side effect of "always bin Zillow" would be a decision nobody asked for.
   */
  it("leaves what was already judged about the message alone", async () => {
    const db = seed(testDb());
    db.update(sorts).set({ category: "Money", finance: "income", scheduling: true }).where(eq(sorts.messageId, "a1:m1")).run();
    setSenderRule(db, "alerts@zillow.test", "knowing", () => 5);
    const r = await withSenderRules(db, counting).sort("c", [], [], input);
    expect(r).toMatchObject({ wants: "knowing", category: "Money", finance: "income", scheduling: true });
  });

  it("keeps the model's name, because the rule says where, not who judged", () => {
    expect(withSenderRules(seed(testDb()), counting).model).toBe("some:model");
  });
});
