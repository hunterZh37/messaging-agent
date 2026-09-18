import { describe, it, expect } from "vitest";
import { accountRow, testDb } from "../helpers/db";
import { accounts, messages, threads, type NewMessageRow } from "../../src/db/schema";
import { MIN_SAMPLE, monthSample, monthsWithMessages, readAll, readMonth, readings, unreadMonths } from "../../src/stats/tone";
import type { ModelProvider, StructuredRequest } from "../../src/models/types";

const BASE = new Date(2026, 4, 10, 12, 0, 0).getTime();
const DAY = 86_400_000;

function db() {
  const d = testDb();
  d.insert(accounts).values(accountRow({ id: "a1", provider: "imap", email: "me@example.com" })).run();
  d.insert(threads)
    .values({ id: "t1", accountId: "a1", providerThreadId: "t1", subject: "t1", lastMessageAt: BASE, lastFromOperator: false })
    .run();
  return d;
}

function mine(d: ReturnType<typeof db>, p: Partial<NewMessageRow> & Pick<NewMessageRow, "id" | "sentAt">) {
  d.insert(messages)
    .values({
      accountId: "a1",
      threadId: "t1",
      providerMessageId: p.id,
      rfcMessageId: null,
      fromAddress: "me@example.com",
      fromName: null,
      toAddresses: [],
      ccAddresses: [],
      subject: "s",
      bodyText: "a normal enough thing to say",
      bodyHtml: null,
      snippet: null,
      attachmentNames: [],
      isFromOperator: true,
      folder: "inbox",
      receivedAt: p.sentAt,
      ...p,
    })
    .run();
}

/** Records what it was asked, and answers in the shape the schema demands. */
function fakeModel(): ModelProvider & { prompts: string[]; systems: string[] } {
  const prompts: string[] = [];
  const systems: string[] = [];
  return {
    prompts,
    systems,
    ref: { provider: "ollama", model: "qwen3:8b" },
    async structured<T>(req: StructuredRequest<T>) {
      prompts.push(req.messages.map((m) => m.content).join("\n"));
      systems.push(req.system.map((s) => s.text).join("\n"));
      return {
        output: req.schema.parse({ tone: "brisk, plain", energy: "steady", warmth: "neutral", note: "Short and to the point." }),
        usage: { inputTokens: 10, outputTokens: 5 },
        latencyMs: 1,
      };
    },
    text: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0 }),
    chat: () => {
      throw new Error("not used");
    },
  };
}

function fillMonth(d: ReturnType<typeof db>, monthOffset: number, count: number, body?: string, tag = "a") {
  for (let i = 0; i < count; i += 1) {
    mine(d, { id: `m${monthOffset}-${tag}-${i}`, sentAt: BASE + monthOffset * 31 * DAY + i * 60_000, bodyText: body ?? `message ${i}` });
  }
}

describe("monthSample", () => {
  it("takes only the operator's own words, with the quoted thread cut away", () => {
    const d = db();
    mine(d, { id: "q", sentAt: BASE, bodyText: "Sounds good.\n\nOn Mon, A <a@example.com> wrote:\n> their long point" });
    expect(monthSample(d, "2026-05")).toEqual(["Sounds good."]);
  });

  it("ignores everything the operator did not write", () => {
    const d = db();
    mine(d, { id: "mine", sentAt: BASE, bodyText: "mine" });
    mine(d, { id: "theirs", sentAt: BASE, bodyText: "theirs", isFromOperator: false, fromAddress: "them@example.com" });
    expect(monthSample(d, "2026-05")).toEqual(["mine"]);
  });

  it("spreads the sample across the month rather than taking the first few", () => {
    const d = db();
    fillMonth(d, 0, 100);
    const sample = monthSample(d, "2026-05", 10);
    expect(sample).toHaveLength(10);
    expect(sample[0]).toBe("message 0");
    // Drawn from the far end too, which taking the head would never reach.
    expect(sample.at(-1)).toBe("message 90");
  });
});

describe("readMonth", () => {
  it("stores a reading, tagged with the model that gave it", async () => {
    const d = db();
    fillMonth(d, 0, 20);
    const model = fakeModel();

    const row = await readMonth(d, model, "2026-05");
    expect(row?.tone).toBe("brisk, plain");
    expect(row?.sampled).toBe(20);
    expect(row?.model).toBe("ollama:qwen3:8b");
    expect(readings(d)).toHaveLength(1);
  });

  it("tells the model the writer is the subject and the other side is absent", async () => {
    const d = db();
    fillMonth(d, 0, 20);
    const model = fakeModel();
    await readMonth(d, model, "2026-05");

    const system = model.systems[0]!;
    expect(system).toMatch(/never describe, name, or guess at anyone else/i);
    expect(system).toMatch(/not here and are not your subject/i);
  });

  it("refuses a month too thin to say anything about, and stores nothing", async () => {
    const d = db();
    fillMonth(d, 0, MIN_SAMPLE - 1);
    const model = fakeModel();

    expect(await readMonth(d, model, "2026-05")).toBeNull();
    expect(model.prompts).toHaveLength(0);
    expect(readings(d)).toHaveLength(0);
  });

  it("replaces an earlier reading of the same month rather than doubling it", async () => {
    const d = db();
    fillMonth(d, 0, 20);
    const model = fakeModel();
    await readMonth(d, model, "2026-05");
    await readMonth(d, model, "2026-05");
    expect(readings(d)).toHaveLength(1);
  });
});

describe("readAll", () => {
  it("reads every month that has none, and leaves the read ones alone", async () => {
    const d = db();
    fillMonth(d, 0, 20);
    fillMonth(d, 1, 20);
    const model = fakeModel();

    expect(monthsWithMessages(d)).toHaveLength(2);
    expect(await readAll(d, model)).toBe(2);
    expect(unreadMonths(d)).toEqual([]);
    expect(await readAll(d, model)).toBe(0);
  });

  it("keeps what it finished when a run is stopped part way", async () => {
    const d = db();
    fillMonth(d, 0, 20);
    fillMonth(d, 1, 20);
    fillMonth(d, 2, 20);
    const model = fakeModel();
    const stop = new AbortController();

    await readAll(d, model, {
      signal: stop.signal,
      onProgress: (p) => {
        if (p.done === 1) stop.abort();
      },
    });

    expect(readings(d)).toHaveLength(1);
    expect(unreadMonths(d)).toHaveLength(2);
  });

  it("reads the newest month first, which is the one worth having", async () => {
    const d = db();
    fillMonth(d, 0, 20);
    fillMonth(d, 2, 20);
    const months = unreadMonths(d);
    expect(months[0]! > months[1]!).toBe(true);
  });
});

describe("months too thin to read", () => {
  it("are never offered, so the button does not keep asking for the impossible", async () => {
    const d = db();
    fillMonth(d, 0, 20);
    fillMonth(d, 1, MIN_SAMPLE - 1);
    const model = fakeModel();

    // Only the month with enough in it is ever a candidate.
    expect(monthsWithMessages(d)).toHaveLength(1);
    expect(unreadMonths(d)).toHaveLength(1);

    await readAll(d, model);
    expect(readings(d)).toHaveLength(1);
    // The run leaves nothing outstanding, which is what the page reports.
    expect(unreadMonths(d)).toEqual([]);
  });

  it("become readable on their own once enough has synced", async () => {
    const d = db();
    fillMonth(d, 0, MIN_SAMPLE - 1);
    expect(unreadMonths(d)).toEqual([]);

    // The rest of that month arrives on a later sync.
    fillMonth(d, 0, 5, undefined, "later");
    expect(unreadMonths(d)).toHaveLength(1);
  });

  it("does not count an empty body towards the threshold", () => {
    const d = db();
    fillMonth(d, 0, MIN_SAMPLE + 6, "   ");
    expect(unreadMonths(d)).toEqual([]);
  });

  it("does not count a bare forward, which has plenty of text and none of it the operator's", () => {
    const d = db();
    // Twenty sent mails, every one of them a quote with nothing written above
    // it. This is what an old mail-only month actually looks like.
    fillMonth(d, 0, 20, "On Mon, 1 Jan 2026 at 09:00, A <a@example.com> wrote:\n> the whole of it");
    expect(unreadMonths(d)).toEqual([]);
  });
});
