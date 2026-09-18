import { describe, it, expect } from "vitest";
import { accountRow, testDb } from "../helpers/db";
import { accounts, messages, threads, type NewMessageRow } from "../../src/db/schema";
import { declareType, declaredType, psychRead, psychSample, readPsych } from "../../src/stats/psych";
import type { ModelProvider, StructuredRequest } from "../../src/models/types";

const BASE = new Date(2026, 0, 5, 12, 0, 0).getTime();

function db() {
  const d = testDb();
  d.insert(accounts).values(accountRow({ id: "a1", provider: "imap", email: "me@example.com" })).run();
  d.insert(threads)
    .values({ id: "t1", accountId: "a1", providerThreadId: "t1", subject: "t1", lastMessageAt: BASE, lastFromOperator: true })
    .run();
  return d;
}

function mine(d: ReturnType<typeof db>, id: string, body: string, at = BASE) {
  d.insert(messages)
    .values({
      id,
      accountId: "a1",
      threadId: "t1",
      providerMessageId: id,
      rfcMessageId: null,
      fromAddress: "me@example.com",
      fromName: null,
      toAddresses: [],
      ccAddresses: [],
      subject: "s",
      bodyText: body,
      bodyHtml: null,
      snippet: null,
      attachmentNames: [],
      isFromOperator: true,
      folder: "inbox",
      receivedAt: at,
      sentAt: at,
    })
    .run();
}

function fill(d: ReturnType<typeof db>, n: number) {
  for (let i = 0; i < n; i += 1) mine(d, `m${i}`, `this is message number ${i} and it is long enough`, BASE + i * 60_000);
}

/** Answers with whatever verdicts it is handed, one per call, in order. */
type Cite = { n: number; starts: string };

function model(answers: { verdict: string; forEvidence?: Cite[]; againstEvidence?: Cite[] }[]): ModelProvider {
  let call = 0;
  return {
    ref: { provider: "ollama", model: "qwen3:8b" },
    async structured<T>(req: StructuredRequest<T>) {
      const a = answers[call % answers.length]!;
      call += 1;
      return {
        output: req.schema.parse({
          verdict: a.verdict,
          reasoning: "because",
          forEvidence: a.forEvidence ?? [],
          againstEvidence: a.againstEvidence ?? [],
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
      };
    },
    text: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0 }),
    chat: () => {
      throw new Error("not used");
    },
  };
}

describe("psychSample", () => {
  it("leaves out anything too short to say something about a person", () => {
    const d = db();
    mine(d, "short", "ok haha", BASE);
    mine(d, "long", "this one is definitely long enough to be quoted", BASE + 1000);
    const sample = psychSample(d);
    expect(sample.map((s) => s.id)).toEqual(["long"]);
  });

  it("strips the quoted thread, so nobody else's words can be cited as the operator's", () => {
    const d = db();
    mine(d, "q", "I think we should go ahead with it\n\nOn Mon, A <a@example.com> wrote:\n> a long argument of their own");
    expect(psychSample(d)[0]!.text).toBe("I think we should go ahead with it");
  });
});

describe("declareType", () => {
  it("takes a real type and refuses anything else", () => {
    const d = db();
    declareType(d, "intj");
    expect(declaredType(d)).toBe("INTJ");

    expect(() => declareType(d, "XXXX")).toThrow(/not an MBTI type/);
    expect(() => declareType(d, "INT")).toThrow(/not an MBTI type/);
    // Right letters, wrong axes.
    expect(() => declareType(d, "NITJ")).toThrow(/not an MBTI type/);
  });

  it("replaces the old claim rather than keeping both", () => {
    const d = db();
    declareType(d, "INTJ");
    declareType(d, "ENFP");
    expect(declaredType(d)).toBe("ENFP");
  });
});

describe("readPsych", () => {
  it("refuses to run before a type has been claimed", async () => {
    const d = db();
    fill(d, 40);
    await expect(readPsych(d, model([{ verdict: "supported" }]))).rejects.toThrow(/No type declared/);
  });

  it("keeps the claimed letter whatever the messages say about it", async () => {
    const d = db();
    fill(d, 40);
    declareType(d, "INTJ");
    await readPsych(d, model([{ verdict: "against" }]));

    const read = psychRead(d);
    // The type on the page is the operator's, not the model's.
    expect(read.type).toBe("INTJ");
    expect(read.axes.every((a) => a.verdict === "against")).toBe(true);
  });

  it("reports a claim the runs did not agree on as weakly held", async () => {
    const d = db();
    fill(d, 40);
    declareType(d, "INTJ");
    // Three supported, two against, for every axis.
    await readPsych(d, model([{ verdict: "supported" }, { verdict: "supported" }, { verdict: "supported" }, { verdict: "against" }, { verdict: "against" }]));

    const ei = psychRead(d).axes[0]!;
    expect(ei.verdict).toBe("supported");
    expect(ei.agreement).toBe(3);
    expect(ei.runs).toBe(5);
    expect(ei.confidence).toBe("low");
  });

  it("keeps what argues against the claim even when the verdict supports it", async () => {
    const d = db();
    fill(d, 40);
    declareType(d, "INTJ");
    await readPsych(d, model([{ verdict: "supported", forEvidence: [{ n: 1, starts: "this is message" }], againstEvidence: [{ n: 2, starts: "this is message" }] }]));

    const ei = psychRead(d).axes[0]!;
    expect(ei.verdict).toBe("supported");
    expect(ei.supports).toHaveLength(1);
    expect(ei.against).toHaveLength(1);
    expect(ei.against[0]!.quote).toContain("message number 2");
  });

  it("quotes the operator's real message, never text the model produced", async () => {
    const d = db();
    fill(d, 40);
    declareType(d, "INTJ");
    await readPsych(d, model([{ verdict: "supported", forEvidence: [{ n: 7, starts: "this is message" }] }]));

    const cited = psychRead(d).axes[0]!.supports[0]!;
    const row = psychSample(d).find((m) => m.id === cited.messageId)!;
    expect(cited.quote).toBe(row.text);
  });

  it("drops a citation that points at no message rather than trusting it", async () => {
    const d = db();
    fill(d, 40);
    declareType(d, "INTJ");
    await readPsych(d, model([{ verdict: "supported", forEvidence: [{ n: 9999, starts: "this is message" }, { n: -1, starts: "this is message" }, { n: 3, starts: "this is message" }] }]));

    const supports = psychRead(d).axes[0]!.supports;
    expect(supports).toHaveLength(1);
    expect(supports[0]!.quote).toContain("message number 3");
  });

  it("is untested until every axis has been held up", async () => {
    const d = db();
    fill(d, 40);
    declareType(d, "INTJ");
    expect(psychRead(d).tested).toBe(false);
    // The claim still shows before anything has been checked.
    expect(psychRead(d).type).toBe("INTJ");

    await readPsych(d, model([{ verdict: "mixed" }]));
    expect(psychRead(d).tested).toBe(true);
    expect(psychRead(d).axes.map((a) => a.letter).join("")).toBe("INTJ");
  });

  it("replaces the evidence of a re-read instead of piling it up", async () => {
    const d = db();
    fill(d, 40);
    declareType(d, "INTJ");
    await readPsych(d, model([{ verdict: "supported", forEvidence: [{ n: 1, starts: "this is message" }, { n: 2, starts: "this is message" }, { n: 3, starts: "this is message" }] }]));
    await readPsych(d, model([{ verdict: "supported", forEvidence: [{ n: 4, starts: "this is message" }] }]));

    expect(psychRead(d).axes[0]!.supports).toHaveLength(1);
  });
});

describe("a citation that did not read its message", () => {
  it("is thrown away rather than quoted under a verdict", async () => {
    const d = db();
    fill(d, 40);
    declareType(d, "INTJ");
    // Points at message 5 but copies words from nowhere in the list.
    await readPsych(d, model([{ verdict: "supported", forEvidence: [{ n: 5, starts: "something else entirely" }] }]));

    expect(psychRead(d).axes[0]!.supports).toEqual([]);
  });

  it("is kept when the words it copied match the message it points at", async () => {
    const d = db();
    fill(d, 40);
    declareType(d, "INTJ");
    await readPsych(d, model([{ verdict: "supported", forEvidence: [{ n: 5, starts: "This is message" }] }]));

    expect(psychRead(d).axes[0]!.supports).toHaveLength(1);
  });
});
