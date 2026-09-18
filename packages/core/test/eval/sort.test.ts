import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testConfig, testDb } from "../helpers/db";
import { accounts, evalResults, evalRuns, messages, sorts } from "../../src/db/schema";
import { saveCategories } from "../../src/sort/categories";
import { NO_PROJECT, type SortInput, type SortProject, type SortResult } from "../../src/sort/types";
import type { Category } from "../../src/sort/categories";
import { BASELINE, evalModelLabel, runSortEval, type EvalSorter } from "../../src/eval/run";
import type { SorterAids } from "../../src/sort/sorter";
import { renderSortEvalReport, sortEvalReport } from "../../src/eval/report";
import type { ModelRef } from "../../src/models/types";

const HAIKU: ModelRef = { provider: "anthropic", model: "claude-haiku-4-5" };
const LOCAL: ModelRef = { provider: "ollama", model: "qwen3:8b" };

const base = {
  accountId: "a1",
  threadId: "a1:t1",
  rfcMessageId: null,
  toAddresses: ["me@example.com"],
  ccAddresses: [],
  snippet: null,
  attachmentNames: [],
  receivedAt: 1,
};

/** Three sorted inbound messages, one operator message, one unsorted. */
function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  saveCategories(db, [
    { name: "Needs reply", description: "someone is waiting." },
    { name: "FYI", description: "nothing to do." },
  ]);
  db.insert(messages)
    .values([
      { ...base, id: "a1:m1", providerMessageId: "m1", fromAddress: "bob@example.com", fromName: "Bob", subject: "Invoice", bodyText: "Please pay", isFromOperator: false, sentAt: 100 },
      { ...base, id: "a1:m2", providerMessageId: "m2", fromAddress: "ann@example.com", fromName: "Ann", subject: "Lunch", bodyText: "Free Friday?", isFromOperator: false, sentAt: 200 },
      { ...base, id: "a1:m3", providerMessageId: "m3", fromAddress: "news@example.com", fromName: null, subject: "Weekly", bodyText: "News", isFromOperator: false, sentAt: 300 },
      { ...base, id: "a1:m4", providerMessageId: "m4", fromAddress: "me@example.com", fromName: null, subject: "Re: Q", bodyText: "Yes", isFromOperator: true, sentAt: 400 },
      { ...base, id: "a1:m5", providerMessageId: "m5", fromAddress: "new@example.com", fromName: null, subject: "Unsorted", bodyText: "Hi", isFromOperator: false, sentAt: 500 },
    ])
    .run();
  db.insert(sorts)
    .values([
      { messageId: "a1:m1", important: true, needsReply: true, scheduling: false, category: "Needs reply", finance: "expense", reason: "bill", model: "anthropic:claude-haiku-4-5", labeledAt: null, createdAt: 1 },
      { messageId: "a1:m2", important: true, needsReply: true, scheduling: true, category: "Needs reply", finance: "none", reason: "asks", model: "anthropic:claude-haiku-4-5", labeledAt: null, createdAt: 1 },
      { messageId: "a1:m3", important: false, needsReply: false, scheduling: false, category: null, finance: "none", disposable: true, reason: "newsletter", model: "anthropic:claude-haiku-4-5", labeledAt: null, createdAt: 1 },
    ])
    .run();
}

function verdict(p: Partial<SortResult> = {}): SortResult {
  return { important: true, needs_reply: true, scheduling: false, category: "Needs reply", finance: "none", disposable: false, project: NO_PROJECT, reason: "because", ...p };
}

/** A model, scripted by sender, that also reports what it would have cost. */
function fakeSorter(model: string, script: (input: SortInput) => SortResult | Error, latencyMs = 10): EvalSorter & { seenProjects: SortProject[][]; seenCategories: Category[][]; criteria: string[] } {
  const seenProjects: SortProject[][] = [];
  const seenCategories: Category[][] = [];
  const criteria: string[] = [];
  return {
    model,
    seenProjects,
    seenCategories,
    criteria,
    async sort(c, categories, projects, input) {
      criteria.push(c);
      seenCategories.push(categories);
      seenProjects.push(projects);
      const r = script(input);
      if (r instanceof Error) throw r;
      return { output: r, usage: { inputTokens: 1000, outputTokens: 100 }, latencyMs };
    },
  };
}

describe("evalModelLabel", () => {
  it("names the aid beside the model, so bare and aided runs are two rows", () => {
    expect(evalModelLabel(LOCAL)).toBe("ollama:qwen3:8b");
    expect(evalModelLabel(LOCAL, { examples: true })).toBe("ollama:qwen3:8b+examples");
    expect(evalModelLabel(LOCAL, { rules: true })).toBe("ollama:qwen3:8b+rules");
    expect(evalModelLabel(LOCAL, { examples: true, rules: true })).toBe("ollama:qwen3:8b+examples+rules");
  });
});

describe("runSortEval with the learning aids", () => {
  it("labels the run and its rows with the aids, and hands them to every model", async () => {
    const db = testDb();
    const cfg = testConfig();
    seed(db);
    const seen: { ref: ModelRef; aids: SorterAids }[] = [];
    const run = await runSortEval(db, cfg, {
      models: [LOCAL, HAIKU],
      sample: 1,
      criteria: "c",
      seed: 1,
      examples: true,
      rules: true,
      sorterFor: (ref, aids) => {
        seen.push({ ref, aids });
        return fakeSorter(evalModelLabel(ref, { examples: true, rules: true }), () => verdict());
      },
    });

    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(typeof s.aids.examplesFor).toBe("function");
      expect(typeof s.aids.rules).toBe("function");
    }
    const stored = db.select().from(evalRuns).where(eq(evalRuns.id, run.runId)).get();
    expect(stored?.models).toEqual(["ollama:qwen3:8b+examples+rules", "anthropic:claude-haiku-4-5+examples+rules"]);
    const labels = db.select().from(evalResults).where(eq(evalResults.runId, run.runId)).all().map((r) => r.model);
    expect(labels).toContain("ollama:qwen3:8b+examples+rules");
    expect(labels).toContain("anthropic:claude-haiku-4-5+examples+rules");
  });

  it("gives the sorter the message id and inbox, so examples can leave it out", async () => {
    const db = testDb();
    const cfg = testConfig();
    seed(db);
    const inputs: SortInput[] = [];
    await runSortEval(db, cfg, {
      models: [LOCAL],
      sample: 3,
      criteria: "c",
      seed: 1,
      sorterFor: () => ({
        model: "ollama:qwen3:8b",
        async sort(_c, _cat, _p, input) {
          inputs.push(input);
          return { output: verdict(), usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
        },
      }),
    });
    expect(inputs.every((i) => i.id?.startsWith("a1:") && i.accountId === "a1")).toBe(true);
  });

  it("leaves the label alone when no aid was asked for", async () => {
    const db = testDb();
    const cfg = testConfig();
    seed(db);
    const run = await runSortEval(db, cfg, { models: [LOCAL], sample: 1, criteria: "c", seed: 1, sorterFor: () => fakeSorter("ollama:qwen3:8b", () => verdict()) });
    expect(db.select().from(evalRuns).where(eq(evalRuns.id, run.runId)).get()?.models).toEqual(["ollama:qwen3:8b"]);
  });
});

describe("runSortEval", () => {
  it("samples sorted inbound mail, asks every model, and leaves sorts untouched", async () => {
    const db = testDb();
    seed(db);
    const before = db.select().from(sorts).all();

    const haiku = fakeSorter("anthropic:claude-haiku-4-5", () => verdict());
    const local = fakeSorter("ollama:qwen3:8b", () => verdict({ important: false }), 900);

    const r = await runSortEval(db, testConfig(), {
      models: [HAIKU, LOCAL],
      sample: 10,
      criteria: "my criteria",
      seed: 1,
      sorterFor: (ref) => (ref.provider === "ollama" ? local : haiku),
    });

    expect(r.sampled).toBe(3);
    expect(r.failed).toBe(0);
    expect(db.select().from(sorts).all()).toEqual(before);

    const run = db.select().from(evalRuns).where(eq(evalRuns.id, r.runId)).get();
    expect(run).toMatchObject({ role: "sorter", models: ["anthropic:claude-haiku-4-5", "ollama:qwen3:8b"], sampleSize: 3, accountId: null });
    expect(run!.finishedAt).not.toBeNull();

    const rows = db.select().from(evalResults).where(eq(evalResults.runId, r.runId)).all();
    // Three messages, two models, plus the baseline kept beside them.
    expect(rows).toHaveLength(9);
    expect(rows.filter((x) => x.model === BASELINE)).toHaveLength(3);
    expect(rows.find((x) => x.model === "ollama:qwen3:8b")).toMatchObject({ latencyMs: 900, inputTokens: 1000, outputTokens: 100 });
    expect(haiku.criteria).toEqual(["my criteria", "my criteria", "my criteria"]);
    expect(haiku.seenCategories[0]!.map((c) => c.name)).toEqual(["Needs reply", "FYI"]);
  });

  it("stores the baseline verdict as it was, so a later re-sort cannot move the target", async () => {
    const db = testDb();
    seed(db);
    const r = await runSortEval(db, testConfig(), {
      models: [HAIKU],
      sample: 10,
      criteria: "c",
      seed: 1,
      sorterFor: () => fakeSorter("anthropic:claude-haiku-4-5", () => verdict()),
    });
    const baseline = db.select().from(evalResults).where(eq(evalResults.model, BASELINE)).all();
    expect(baseline.find((b) => b.messageId === "a1:m1")!.output).toMatchObject({ important: true, needs_reply: true, finance: "expense", disposable: false, category: "Needs reply" });
    // Safe to delete is copied into the run beside the rest, so the target
    // cannot move under a later re-sort either (spec 13).
    expect(baseline.find((b) => b.messageId === "a1:m3")!.output).toMatchObject({ disposable: true });
    expect(baseline.every((b) => b.latencyMs === null)).toBe(true);
    void r;
  });

  it("records a failed call as an error row rather than losing the run", async () => {
    const db = testDb();
    seed(db);
    const r = await runSortEval(db, testConfig(), {
      models: [LOCAL],
      sample: 10,
      criteria: "c",
      seed: 1,
      sorterFor: () => fakeSorter("ollama:qwen3:8b", (i) => (i.fromAddress === "bob@example.com" ? new Error("Ollama is not running") : verdict())),
    });
    expect(r.failed).toBe(1);
    const failed = db.select().from(evalResults).where(eq(evalResults.messageId, "a1:m1")).all().find((x) => x.model === "ollama:qwen3:8b");
    expect(failed).toMatchObject({ output: null, error: "Ollama is not running" });
  });

  it("honours the sample size and the account filter", async () => {
    const db = testDb();
    seed(db);
    const small = await runSortEval(db, testConfig(), {
      models: [HAIKU],
      sample: 2,
      criteria: "c",
      seed: 7,
      sorterFor: () => fakeSorter("anthropic:claude-haiku-4-5", () => verdict()),
    });
    expect(small.sampled).toBe(2);

    db.insert(accounts).values({ id: "a2", provider: "imap", email: "other@example.com", displayName: null, createdAt: 1 }).run();
    const other = await runSortEval(db, testConfig(), {
      models: [HAIKU],
      sample: 10,
      accountId: "a2",
      criteria: "c",
      seed: 1,
      sorterFor: () => fakeSorter("anthropic:claude-haiku-4-5", () => verdict()),
    });
    expect(other.sampled).toBe(0);
  });
});

describe("sortEvalReport", () => {
  async function twoModelRun() {
    const db = testDb();
    seed(db);
    // Haiku repeats the baseline exactly; the local model gets m3 wrong.
    const haiku = fakeSorter("anthropic:claude-haiku-4-5", (i) =>
      i.fromAddress === "news@example.com"
        ? verdict({ important: false, needs_reply: false, category: "FYI", disposable: true })
        : verdict({ finance: i.fromAddress === "bob@example.com" ? "expense" : "none", scheduling: i.fromAddress === "ann@example.com" }),
    );
    const local = fakeSorter(
      "ollama:qwen3:8b",
      (i) => (i.fromAddress === "news@example.com" ? verdict({ important: true, needs_reply: true, category: "Needs reply" }) : verdict({ finance: i.fromAddress === "bob@example.com" ? "expense" : "none" })),
      800,
    );
    const r = await runSortEval(db, testConfig(), {
      models: [HAIKU, LOCAL],
      sample: 10,
      criteria: "c",
      seed: 1,
      sorterFor: (ref) => (ref.provider === "ollama" ? local : haiku),
    });
    return { db, runId: r.runId };
  }

  it("scores each model against the baseline and against each other", async () => {
    const { db, runId } = await twoModelRun();
    const report = sortEvalReport(db, runId);

    expect(report.sampleSize).toBe(3);
    const haiku = report.models.find((m) => m.model === "anthropic:claude-haiku-4-5")!;
    expect(haiku.agreement).toEqual({ important: 1, needs_reply: 1, finance: 1, disposable: 1, category: 1, project: 1 });
    expect(haiku.meanLatencyMs).toBe(10);
    expect(haiku.inputTokens).toBe(3000);
    // 3000 in at $1/M plus 300 out at $5/M.
    expect(haiku.estimatedCostUsd).toBeCloseTo(0.0045, 6);

    const local = report.models.find((m) => m.model === "ollama:qwen3:8b")!;
    expect(local.agreement.important).toBeCloseTo(2 / 3, 6);
    expect(local.agreement.category).toBeCloseTo(2 / 3, 6);
    expect(local.agreement.finance).toBe(1);
    expect(local.meanLatencyMs).toBe(800);
    // Nothing leaves the Mac, so nothing is billed.
    expect(local.estimatedCostUsd).toBe(0);

    expect(report.pairwise).toHaveLength(1);
    expect(report.pairwise[0]!.a).toBe("anthropic:claude-haiku-4-5");
    expect(report.pairwise[0]!.b).toBe("ollama:qwen3:8b");
    expect(report.pairwise[0]!.compared).toBe(3);
    expect(report.pairwise[0]!.agreement.important).toBeCloseTo(2 / 3, 6);
  });

  it("scores safe to delete like the other axes, and names it in the table", async () => {
    const { db, runId } = await twoModelRun();
    const report = sortEvalReport(db, runId);
    // The baseline calls the newsletter disposable. Haiku says so too; the
    // local model calls it worth keeping, and misses exactly that one.
    expect(report.models.find((m) => m.model === "anthropic:claude-haiku-4-5")!.agreement.disposable).toBe(1);
    expect(report.models.find((m) => m.model === "ollama:qwen3:8b")!.agreement.disposable).toBeCloseTo(2 / 3, 6);
    expect(renderSortEvalReport(report)).toContain("disposable");
  });

  it("renders a table naming every model, the run and the sample", async () => {
    const { db, runId } = await twoModelRun();
    const text = renderSortEvalReport(sortEvalReport(db, runId));
    expect(text).toContain("ollama:qwen3:8b");
    expect(text).toContain("anthropic:claude-haiku-4-5");
    expect(text).toContain("important");
    expect(text).toContain("3 messages");
    expect(text).toContain(runId);
  });

  it("refuses a run id it does not know", () => {
    const db = testDb();
    expect(() => sortEvalReport(db, "nope")).toThrow(/nope/);
  });
});
