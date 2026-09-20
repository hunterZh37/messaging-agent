import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { FakeEmbedder } from "../helpers/embedder";
import { accounts, messages, projectAssignments, projects, sorts, threads } from "../../src/db/schema";
import { embedPending } from "../../src/projects/classify";
import { EmbeddingsUnavailableError, type Embedder } from "../../src/projects/embedder";
import { findExamples, renderExamples, trustedVerdictCondition, type SortExample } from "../../src/sort/examples";
import type { SortInput } from "../../src/sort/types";

type TestDb = ReturnType<typeof testDb>;

const TRICKLE = "ollama:qwen3:8b";
const BACKLOG = "anthropic:claude-haiku-4-5";

let sentAt = 1000;

interface Seed {
  id: string;
  accountId?: string;
  from: string;
  fromName?: string | null;
  subject: string;
  body: string;
  /** No verdict at all when absent: the message being judged. */
  sort?: { model: string; labeledAt?: number; wants?: "reply" | "action" | "knowing" | "bin"; category?: string | null; finance?: string };
  project?: string;
}

function seed(db: TestDb, rows: Seed[]): void {
  db.insert(accounts)
    .values([
      { id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 },
      { id: "a2", provider: "imap", email: "work@example.com", displayName: null, createdAt: 1 },
    ])
    .run();
  for (const r of rows) {
    const accountId = r.accountId ?? "a1";
    const threadId = `${accountId}:t-${r.id}`;
    const at = sentAt++;
    db.insert(threads)
      .values({ id: threadId, accountId, providerThreadId: threadId, subject: r.subject, lastMessageAt: at, lastFromOperator: false })
      .run();
    db.insert(messages)
      .values({
        id: r.id,
        accountId,
        providerMessageId: r.id,
        threadId,
        rfcMessageId: null,
        fromAddress: r.from,
        fromName: r.fromName ?? null,
        toAddresses: ["me@example.com"],
        ccAddresses: [],
        subject: r.subject,
        bodyText: r.body,
        bodyHtml: null,
        snippet: null,
        attachmentNames: [],
        isFromOperator: false,
        folder: "inbox",
        sentAt: at,
        receivedAt: at,
      })
      .run();
    if (r.sort) {
      db.insert(sorts)
        .values({
          messageId: r.id,
          wants: r.sort.wants ?? "knowing",
          scheduling: false,
          category: r.sort.category === undefined ? "Money" : r.sort.category,
          finance: r.sort.finance ?? "expense",
          reason: `judged ${r.id}`,
          model: r.sort.model,
          labeledAt: r.sort.labeledAt ?? null,
          createdAt: at,
        })
        .run();
    }
    if (r.project) {
      const projectId = `p-${r.project}`;
      if (!db.select().from(projects).where(eq(projects.id, projectId)).get()) {
        db.insert(projects).values({ id: projectId, accountId, name: r.project, description: "work", position: 0, createdAt: 1 }).run();
      }
      db.insert(projectAssignments).values({ messageId: r.id, projectId, source: "sorter", score: null, assignedAt: at }).run();
    }
  }
}

/** The message being judged: the same invoice words as the trusted examples. */
function input(p: Partial<SortInput & { id: string; accountId: string }> = {}): SortInput & { id: string; accountId: string } {
  return {
    id: "m-new",
    accountId: "a1",
    fromAddress: "billing@acme.com",
    fromName: "Acme Billing",
    subject: "Invoice 1002 from Acme",
    bodyText: "Please pay the attached Acme invoice by Friday.",
    attachmentNames: [],
    sentAt: 9000,
    ...p,
  };
}

/** Every message in the mailbox gets a vector, the way the projects pass leaves them. */
async function embedAll(db: TestDb): Promise<void> {
  const embedder = new FakeEmbedder();
  await embedPending(db, embedder, { accountId: "a1" });
  await embedPending(db, embedder, { accountId: "a2" });
}

const INVOICE = "Please pay the attached Acme invoice by Friday.";

describe("trustedVerdictCondition", () => {
  it("trusts a hand-corrected verdict even when no model is trusted", () => {
    expect(trustedVerdictCondition([])).toBeDefined();
  });
});

describe("findExamples", () => {
  it("returns the nearest verdicts the backlog model made, and no others", async () => {
    const db = testDb();
    seed(db, [
      { id: "m1", from: "billing@acme.com", fromName: "Acme Billing", subject: "Invoice 1001 from Acme", body: INVOICE, sort: { model: BACKLOG }, project: "Consulting" },
      { id: "m2", from: "billing@acme.com", subject: "Invoice 1000 from Acme", body: INVOICE, sort: { model: TRICKLE } },
      { id: "m3", from: "billing@acme.com", subject: "Invoice 999 from Acme", body: INVOICE, sort: { model: TRICKLE, labeledAt: 500 } },
      { id: "m4", accountId: "a2", from: "billing@acme.com", subject: "Invoice 998 from Acme", body: INVOICE, sort: { model: BACKLOG } },
      { id: "m-new", from: "billing@acme.com", subject: "Invoice 1002 from Acme", body: INVOICE, sort: { model: BACKLOG } },
    ]);
    await embedAll(db);

    const found = await findExamples(db, new FakeEmbedder(), input(), { trickleModel: TRICKLE });
    const subjects = found.map((e) => e.subject);
    // m1 the backlog model judged.
    expect(subjects).toContain("Invoice 1001 from Acme");
    // m2 and m3 are the trickle model's own guesses (labeled_at only says the
    // provider label went on), m4 belongs to another inbox, and m-new is the
    // message being judged.
    expect(subjects).not.toContain("Invoice 1000 from Acme");
    expect(subjects).not.toContain("Invoice 999 from Acme");
    expect(subjects).not.toContain("Invoice 998 from Acme");
    expect(subjects).not.toContain("Invoice 1002 from Acme");
  });

  it("picks the message that reads alike over the one that merely arrived last", async () => {
    const db = testDb();
    seed(db, [
      { id: "m1", from: "billing@acme.com", subject: "Invoice 1001 from Acme", body: INVOICE, sort: { model: BACKLOG } },
      { id: "m2", from: "billing@acme.com", subject: "Office closed Monday", body: "The office is shut for the holiday.", sort: { model: BACKLOG } },
      { id: "m3", from: "billing@acme.com", subject: "New parking arrangements", body: "Park behind the building from now on.", sort: { model: BACKLOG } },
    ]);
    await embedAll(db);
    // Same sender and the newest two are the other messages, so recency alone
    // would answer m3 and m2: only the vector search puts the invoice first.
    const found = await findExamples(db, new FakeEmbedder(), input(), { trickleModel: TRICKLE, k: 1 });
    expect(found.map((e) => e.subject)).toEqual(["Invoice 1001 from Acme"]);
  });

  it("carries the sender, a two-line snippet, and the stored verdict", async () => {
    const db = testDb();
    seed(db, [
      {
        id: "m1",
        from: "billing@acme.com",
        fromName: "Acme Billing",
        subject: "Invoice 1001 from Acme",
        body: "Line one about the invoice.\nLine two about the invoice.\nLine three nobody sees.\n\n> quoted history",
        sort: { model: BACKLOG, wants: "reply", category: "Money", finance: "expense" },
        project: "Consulting",
      },
    ]);
    await embedAll(db);

    const [example] = await findExamples(db, new FakeEmbedder(), input(), { trickleModel: TRICKLE });
    expect(example?.fromLine).toBe("Acme Billing <billing@acme.com>");
    expect(example?.subject).toBe("Invoice 1001 from Acme");
    expect(example?.snippet).toBe("Line one about the invoice.\nLine two about the invoice.");
    expect(example?.verdict).toEqual({
      wants: "reply", scheduling: false,
      category: "Money",
      finance: "expense",
      
      project: "Consulting",
    });
  });

  it("says None for a message no project claimed", async () => {
    const db = testDb();
    seed(db, [{ id: "m1", from: "billing@acme.com", subject: "Invoice 1001", body: INVOICE, sort: { model: BACKLOG } }]);
    await embedAll(db);
    const [example] = await findExamples(db, new FakeEmbedder(), input(), { trickleModel: TRICKLE });
    expect(example?.verdict.project).toBe("None");
  });

  it("keeps at most k", async () => {
    const db = testDb();
    seed(
      db,
      Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`,
        from: "billing@acme.com",
        subject: `Invoice ${i}`,
        body: INVOICE,
        sort: { model: BACKLOG },
      })),
    );
    await embedAll(db);
    expect(await findExamples(db, new FakeEmbedder(), input(), { trickleModel: TRICKLE })).toHaveLength(6);
    expect(await findExamples(db, new FakeEmbedder(), input(), { trickleModel: TRICKLE, k: 2 })).toHaveLength(2);
  });

  it("falls back to the sender's domain when Ollama is down", async () => {
    const db = testDb();
    seed(db, [
      { id: "m1", from: "someone@elsewhere.com", subject: "Newest, wrong domain", body: "Nothing alike", sort: { model: BACKLOG } },
      { id: "m2", from: "ap@acme.com", subject: "Older, right domain", body: "Nothing alike", sort: { model: BACKLOG } },
      { id: "m3", from: "ap@acme.com", subject: "Newer, right domain", body: "Nothing alike", sort: { model: BACKLOG } },
      { id: "m4", from: "ap@acme.com", subject: "Untrusted, right domain", body: "Nothing alike", sort: { model: TRICKLE } },
    ]);
    await embedAll(db);

    const down: Embedder = {
      async embed() {
        throw new EmbeddingsUnavailableError("Ollama is not running");
      },
    };
    const found = await findExamples(db, down, input(), { trickleModel: TRICKLE, k: 2 });
    expect(found.map((e) => e.subject)).toEqual(["Newer, right domain", "Older, right domain"]);
  });

  it("fills the rest of the fallback from the inbox when the domain has too few", async () => {
    const db = testDb();
    seed(db, [
      { id: "m1", from: "someone@elsewhere.com", subject: "Anyone else", body: "Nothing alike", sort: { model: BACKLOG } },
      { id: "m2", from: "ap@acme.com", subject: "Same domain", body: "Nothing alike", sort: { model: BACKLOG } },
    ]);
    await embedAll(db);
    const down: Embedder = {
      async embed() {
        throw new EmbeddingsUnavailableError("Ollama is not running");
      },
    };
    const found = await findExamples(db, down, input(), { trickleModel: TRICKLE, k: 4 });
    expect(found.map((e) => e.subject)).toEqual(["Same domain", "Anyone else"]);
  });

  it("returns nothing when the inbox holds no trusted verdict at all", async () => {
    const db = testDb();
    seed(db, [{ id: "m1", from: "billing@acme.com", subject: "Invoice 1001", body: INVOICE, sort: { model: TRICKLE } }]);
    await embedAll(db);
    expect(await findExamples(db, new FakeEmbedder(), input(), { trickleModel: TRICKLE })).toEqual([]);
  });
});

describe("renderExamples", () => {
  const example: SortExample = {
    fromLine: "Acme Billing <billing@acme.com>",
    subject: "Invoice 1001",
    snippet: "Please pay the attached invoice.",
    verdict: { wants: "knowing", scheduling: false, category: "Money", finance: "expense",  project: "Consulting" },
  };

  it("heads the block and puts each verdict under its message", () => {
    const s = renderExamples([example]);
    expect(s).toContain("# Already judged in this inbox (examples)");
    expect(s).toContain("From: Acme Billing <billing@acme.com>");
    expect(s).toContain("Subject: Invoice 1001");
    expect(s).toContain("Please pay the attached invoice.");
    expect(s).toContain(
      'Verdict: {"wants":"knowing","scheduling":false,"category":"Money","finance":"expense","project":"Consulting"}',
    );
  });

  it("renders nothing at all when there are no examples", () => {
    expect(renderExamples([])).toBe("");
  });
});
