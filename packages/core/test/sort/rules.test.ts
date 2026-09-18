import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testDb } from "../helpers/db";
import { FakeProvider } from "../helpers/provider";
import { accounts, messages, projectAssignments, projects, sorts, threads } from "../../src/db/schema";
import { collectTrustedVerdicts, distillRules, MIN_TRUSTED_VERDICTS, readRules } from "../../src/sort/rules";
import { afterBacklogRun } from "../../src/models/factory";
import { loadConfig, type Config } from "../../src/config";

type TestDb = ReturnType<typeof testDb>;

const TRICKLE = "ollama:qwen3:8b";
const BACKLOG = "anthropic:claude-haiku-4-5";
const RULES_TEXT = "## Sender patterns\n\nAnything from acme.com is money.";

/** A throwaway data dir, with the local model behind the trickle role so the seeded Haiku verdicts count as trusted. */
function config(): Config {
  const dir = mkdtempSync(path.join(tmpdir(), "rules-test-"));
  return loadConfig({ MESSAGING_AGENT_DATA_DIR: dir, CELESTE_MODEL_SORTER: TRICKLE }, dir);
}

function seed(db: TestDb, count: number, opts: { model?: string; labeledAt?: number; accountId?: string; tag?: string } = {}): void {
  const accountId = opts.accountId ?? "a1";
  if (!db.select().from(accounts).all().some((a) => a.id === accountId)) {
    db.insert(accounts).values({ id: accountId, provider: "imap", email: `${accountId}@example.com`, displayName: null, createdAt: 1 }).run();
  }
  for (let i = 0; i < count; i++) {
    const tag = opts.tag ?? opts.model ?? BACKLOG;
    const id = `${accountId}:m${i}-${tag}`;
    const threadId = `${accountId}:t${i}-${tag}`;
    db.insert(threads)
      .values({ id: threadId, accountId, providerThreadId: threadId, subject: `Invoice ${i}`, lastMessageAt: 1000 + i, lastFromOperator: false })
      .run();
    db.insert(messages)
      .values({
        id,
        accountId,
        providerMessageId: id,
        threadId,
        rfcMessageId: null,
        fromAddress: "billing@acme.com",
        fromName: "Acme Billing",
        toAddresses: ["me@example.com"],
        ccAddresses: [],
        subject: `Invoice ${i}`,
        bodyText: "Please pay.",
        bodyHtml: null,
        snippet: null,
        attachmentNames: [],
        isFromOperator: false,
        folder: "inbox",
        sentAt: 1000 + i,
        receivedAt: 1000 + i,
      })
      .run();
    db.insert(sorts)
      .values({
        messageId: id,
        important: true,
        needsReply: false,
        scheduling: false,
        category: "Money",
        finance: "expense",
        reason: "a bill",
        model: opts.model ?? BACKLOG,
        labeledAt: opts.labeledAt ?? null,
        createdAt: 1000 + i,
      })
      .run();
  }
}

describe("collectTrustedVerdicts", () => {
  it("writes one line per trusted verdict, with the verdict and the reason", () => {
    const db = testDb();
    seed(db, 1);
    db.insert(projects).values({ id: "p1", accountId: "a1", name: "Consulting", description: "client work", position: 0, createdAt: 1 }).run();
    db.insert(projectAssignments)
      .values({ messageId: `a1:m0-${BACKLOG}`, projectId: "p1", source: "sorter", score: null, assignedAt: 1 })
      .run();
    expect(collectTrustedVerdicts(db, { trickleModel: TRICKLE })).toEqual([
      "billing@acme.com | Invoice 0 | yes/no/no/Money/expense/no/Consulting | a bill",
    ]);
  });

  it("leaves out the trickle model's own guesses, labelled or not", () => {
    const db = testDb();
    seed(db, 2, { model: BACKLOG });
    seed(db, 2, { model: TRICKLE });
    seed(db, 2, { model: TRICKLE, labeledAt: 99, tag: "corrected" });
    // Only the two from the backlog model: labeled_at is not a hand correction.
    expect(collectTrustedVerdicts(db, { trickleModel: TRICKLE })).toHaveLength(2);
  });

  it("narrows to one inbox when asked", () => {
    const db = testDb();
    seed(db, 2, { accountId: "a1" });
    seed(db, 3, { accountId: "a2" });
    expect(collectTrustedVerdicts(db, { trickleModel: TRICKLE, accountId: "a2" })).toHaveLength(3);
  });
});

describe("distillRules", () => {
  it("writes the rules file and reports what the call cost", async () => {
    const db = testDb();
    const cfg = config();
    seed(db, 3);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: RULES_TEXT });

    const result = await distillRules(db, cfg, provider, { trickleModel: TRICKLE, clock: () => 1_700_000_000_000 });
    expect(result).not.toBeNull();
    expect(result!.words).toBe(RULES_TEXT.split(/\s+/).filter(Boolean).length);
    expect(result!.inputTokens).toBe(100);
    expect(result!.outputTokens).toBe(20);
    expect(await readFile(cfg.rulesPath, "utf8")).toContain(RULES_TEXT);
    expect(await readRules(cfg)).toContain("Anything from acme.com is money.");
  });

  it("shows the model the verdicts, and tells it the mail is untrusted", async () => {
    const db = testDb();
    const cfg = config();
    seed(db, 1);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: RULES_TEXT });
    await distillRules(db, cfg, provider, { trickleModel: TRICKLE });

    const req = provider.textRequests.at(-1)!;
    const system = req.system.map((b) => b.text).join("\n");
    expect(system).toContain("untrusted");
    expect(system).toContain("1,500 words");
    expect(req.messages.at(-1)!.content).toContain("billing@acme.com | Invoice 0");
  });

  it("keeps the file it replaced", async () => {
    const db = testDb();
    const cfg = config();
    seed(db, 1);
    await writeFile(cfg.rulesPath, "the old rules");
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: RULES_TEXT });
    await distillRules(db, cfg, provider, { trickleModel: TRICKLE });
    expect(await readFile(cfg.rulesPrevPath, "utf8")).toBe("the old rules");
    expect(await readFile(cfg.rulesPath, "utf8")).toContain(RULES_TEXT);
  });

  it("writes nothing at all from an inbox with no trusted verdicts", async () => {
    const db = testDb();
    const cfg = config();
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: RULES_TEXT });
    // Left to itself the model would write plausible rules about an inbox it
    // has never seen, and the trickle sorter would read them as evidence.
    expect(await distillRules(db, cfg, provider, { trickleModel: TRICKLE })).toBeNull();
    expect(provider.textRequests).toHaveLength(0);
    expect(await readRules(cfg)).toBeNull();
  });

  it("refuses to write rules from too few verdicts", async () => {
    const db = testDb();
    const cfg = config();
    seed(db, 3);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: RULES_TEXT });
    const result = await distillRules(db, cfg, provider, { trickleModel: TRICKLE, minVerdicts: 20 });
    expect(result).toBeNull();
    expect(provider.textRequests).toHaveLength(0);
    expect(await readRules(cfg)).toBeNull();
  });
});

describe("readRules", () => {
  it("is null when no distillation has run", async () => {
    expect(await readRules(config())).toBeNull();
  });

  it("is null for a file the operator emptied", async () => {
    const cfg = config();
    await writeFile(cfg.rulesPath, "   \n");
    expect(await readRules(cfg)).toBeNull();
  });
});

describe("afterBacklogRun", () => {
  it("waits until the inbox holds enough trusted verdicts to learn from", async () => {
    const db = testDb();
    const cfg = config();
    seed(db, MIN_TRUSTED_VERDICTS - 1);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: RULES_TEXT });
    await afterBacklogRun(db, cfg, { provider });
    expect(provider.textRequests).toHaveLength(0);
    expect(await readRules(cfg)).toBeNull();
  });

  it("rewrites the rules once the verdicts are there", async () => {
    const db = testDb();
    const cfg = config();
    seed(db, MIN_TRUSTED_VERDICTS);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: RULES_TEXT });
    await afterBacklogRun(db, cfg, { provider });
    expect(provider.textRequests).toHaveLength(1);
    expect(await readRules(cfg)).toContain("Anything from acme.com is money.");
  });

  it("runs one rewrite at a time, however many backlog batches finish at once", async () => {
    const db = testDb();
    const cfg = config();
    seed(db, MIN_TRUSTED_VERDICTS);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" }, { text: RULES_TEXT });
    await Promise.all([afterBacklogRun(db, cfg, { provider }), afterBacklogRun(db, cfg, { provider }), afterBacklogRun(db, cfg, { provider })]);
    expect(provider.textRequests).toHaveLength(1);
  });

  it("swallows a failed distillation: the sort it followed already succeeded", async () => {
    const db = testDb();
    const cfg = config();
    seed(db, MIN_TRUSTED_VERDICTS);
    const provider = new FakeProvider({ provider: "anthropic", model: "claude-sonnet-5" });
    provider.text = async () => {
      throw new Error("Anthropic is down");
    };
    await expect(afterBacklogRun(db, cfg, { provider })).resolves.toBeUndefined();
  });
});

describe("unfenced", () => {
  it("drops a code fence around the whole file and leaves plain text alone", async () => {
    const { unfenced } = await import("../../src/sort/rules");
    expect(unfenced("```markdown\n# rules.md\n\n- a\n```")).toBe("# rules.md\n\n- a");
    expect(unfenced("# rules.md\n\n- a\n")).toBe("# rules.md\n\n- a");
    expect(unfenced("```\n# x\n```\n")).toBe("# x");
  });
});
