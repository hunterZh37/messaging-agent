import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testConfig, testDb } from "../helpers/db";
import { FakeEmbedder, fakeVector } from "../helpers/embedder";
import { accounts, embeddingState, messages, projectAssignments, threads, type MailFolder } from "../../src/db/schema";
import { createProject, groupKey, listProjectGroups, listProjects, saveProjects, saveProjectsWithGroups } from "../../src/projects/projects";
import { listInboxMessages } from "../../src/queue/inbox";
import {
  classifyProjects,
  clearProjectVectorCache,
  cosine,
  ALL_KEY,
  countByProject,
  DEFAULT_MARGIN,
  DOCUMENT_PREFIX,
  embedTextFor,
  embedTextHash,
  embedPending,
  fileThread,
  projectVectors,
  QUERY_PREFIX,
  runProjectsPass,
  UNFILED_KEY,
} from "../../src/projects/classify";
import { EmbeddingsUnavailableError } from "../../src/projects/embedder";

type TestDb = ReturnType<typeof testDb>;

function account(db: TestDb) {
  db.insert(accounts)
    .values([
      { id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 },
      { id: "a2", provider: "imap", email: "work@example.com", displayName: null, createdAt: 1 },
    ])
    .run();
}

let sentAt = 1000;

function addMessage(
  db: TestDb,
  p: { id: string; accountId?: string; subject: string; body: string; fromOperator?: boolean; threadId?: string; folder?: MailFolder },
): string {
  const accountId = p.accountId ?? "a1";
  const threadId = p.threadId ?? `${accountId}:t-${p.id}`;
  const existing = db.select().from(threads).where(eq(threads.id, threadId)).get();
  if (!existing) {
    db.insert(threads)
      .values({ id: threadId, accountId, providerThreadId: threadId, subject: p.subject, lastMessageAt: sentAt, lastFromOperator: false })
      .run();
  }
  const id = `${accountId}:${p.id}`;
  db.insert(messages)
    .values({
      id,
      accountId,
      providerMessageId: p.id,
      threadId,
      rfcMessageId: null,
      fromAddress: "someone@x.com",
      fromName: null,
      toAddresses: ["me@example.com"],
      ccAddresses: [],
      subject: p.subject,
      bodyText: p.body,
      bodyHtml: null,
      snippet: null,
      attachmentNames: [],
      isFromOperator: p.fromOperator ?? false,
      folder: p.folder ?? "inbox",
      sentAt: sentAt++,
      receivedAt: 1,
    })
    .run();
  return id;
}

beforeEach(() => {
  clearProjectVectorCache();
  sentAt = 1000;
});

describe("cosine", () => {
  it("matches a hand-computed value", () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([2, 4, 6]);
    expect(cosine(a, b)).toBeCloseTo(1, 10);
    // dot 15, |a| = 5, |b| = sqrt(10): 15 / (5 * sqrt(10)) = 3 / sqrt(10)
    expect(cosine(Float32Array.from([3, 4]), Float32Array.from([1, 3]))).toBeCloseTo(3 / Math.sqrt(10), 10);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 10);
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([0, 1]))).toBe(0);
  });

  it("agrees with sqlite-vec's vec_distance_cosine", () => {
    const db = testDb();
    const a = fakeVector("signed SOW for the pilot");
    const b = fakeVector("SOW pilot invoice");
    db.$client.exec("CREATE VIRTUAL TABLE t USING vec0(id TEXT PRIMARY KEY, embedding float[768])");
    db.$client.prepare("INSERT INTO t(id, embedding) VALUES (?, ?)").run("x", Buffer.from(a.buffer));
    const row = db.$client.prepare("SELECT vec_distance_cosine(embedding, ?) d FROM t").get(Buffer.from(b.buffer)) as { d: number };
    expect(1 - row.d).toBeCloseTo(cosine(a, b), 5);
  });
});

describe("embedTextFor", () => {
  it("puts the subject first and caps what follows", () => {
    const text = embedTextFor({ subject: "SOW", bodyText: "x".repeat(3000) });
    expect(text.startsWith("SOW\n\n")).toBe(true);
    expect(text.length).toBe(1500);
  });

  it("keeps the new part of a reply and drops the history under it", () => {
    const text = embedTextFor({
      subject: "Re: Pilot",
      bodyText: [
        "Can you send the revised scope by Friday?",
        "",
        "On Mon, 1 Sep 2026 at 09:12, Carol wrote:",
        "> Here is the trademark application draft and the the registry receipt notice.",
        "> Please review the evidence letters as well.",
      ].join("\n"),
    });
    expect(text).toBe("Re: Pilot\n\nCan you send the revised scope by Friday?");
    // The quoted mail is what made unrelated threads embed alike.
    expect(text).not.toContain("the registry");
  });

  it("cuts a signature at its marker", () => {
    const text = embedTextFor({
      subject: "Invoice",
      bodyText: ["The August invoice is attached.", "", "--", "Dana Reyes", "Reyes & Co", "+1 415 555 0134"].join("\n"),
    });
    expect(text).toBe("Invoice\n\nThe August invoice is attached.");
  });

  it("cuts an address block: three short contact lines in a row end the message", () => {
    const text = embedTextFor({
      subject: "Please sign: Formation docs",
      bodyText: [
        "Protocol Z formation documents are ready for your signature.",
        "Reyes & Co",
        "221 Main St",
        "San Francisco, CA 94105",
        "+1 415 555 0134",
      ].join("\n"),
    });
    expect(text).toBe("Please sign: Formation docs\n\nProtocol Z formation documents are ready for your signature. Reyes & Co");
  });

  it("needs three in a row, so one address line inside a message survives", () => {
    const body = ["Sign here.", "221 Main St", "Then send it back to me when you can."].join("\n");
    expect(embedTextFor({ subject: "Docs", bodyText: body })).toBe("Docs\n\nSign here. 221 Main St Then send it back to me when you can.");
  });

  it("cuts at a phrase footer too, and collapses what is left", () => {
    for (const footer of ["Sent from my iPhone", "Get Outlook for iOS", "Confidentiality notice: this is privileged."]) {
      const text = embedTextFor({ subject: "Hi", bodyText: `Let's   meet\n\nnext week.\n\n${footer}\nmore` });
      expect(text).toBe("Hi\n\nLet's meet next week.");
    }
  });

  it("leaves a real sentence that happens to hold a link alone", () => {
    const body = "The signed scope of work is on the shared drive at https://example.com/scope and the numbers look right to me.";
    expect(embedTextFor({ subject: "SOW", bodyText: body })).toBe(`SOW\n\n${body}`);
  });
});

describe("embedPending", () => {
  it("embeds inbound messages newest first and records them as done", async () => {
    const db = testDb();
    account(db);
    addMessage(db, { id: "m1", subject: "SOW", body: "signed" });
    addMessage(db, { id: "m2", subject: "Petition", body: "the registry" });
    addMessage(db, { id: "mine", subject: "Re: SOW", body: "thanks", fromOperator: true });

    const embedder = new FakeEmbedder();
    expect(await embedPending(db, embedder, { accountId: "a1" })).toEqual({ embedded: 2, reembedded: 0 });
    // Newest first, the operator's own message is not embedded, and every
    // message goes to the model as a document.
    expect(embedder.calls[0]).toEqual([
      `${DOCUMENT_PREFIX}Petition\n\nthe registry`,
      `${DOCUMENT_PREFIX}SOW\n\nsigned`,
    ]);
    expect(db.select().from(embeddingState).all().map((r) => r.messageId).sort()).toEqual(["a1:m1", "a1:m2"]);

    // A second pass has nothing left to do.
    expect(await embedPending(db, embedder, { accountId: "a1" })).toEqual({ embedded: 0, reembedded: 0 });
    expect(embedder.calls).toHaveLength(1);
  });

  it("honours the limit and the account filter", async () => {
    const db = testDb();
    account(db);
    addMessage(db, { id: "m1", subject: "one", body: "a" });
    addMessage(db, { id: "m2", subject: "two", body: "b" });
    addMessage(db, { id: "m3", accountId: "a2", subject: "three", body: "c" });

    expect(await embedPending(db, new FakeEmbedder(), { accountId: "a1", limit: 1 })).toEqual({ embedded: 1, reembedded: 0 });
    expect(db.select().from(embeddingState).all().map((r) => r.messageId)).toEqual(["a1:m2"]);
    expect(await embedPending(db, new FakeEmbedder(), {})).toEqual({ embedded: 2, reembedded: 0 });
  });

  it("re-embeds a message whose text no longer hashes to what was embedded", async () => {
    const db = testDb();
    account(db);
    addMessage(db, { id: "m1", subject: "SOW", body: "signed" });
    await embedPending(db, new FakeEmbedder(), {});

    const before = db.select().from(embeddingState).all()[0]!;
    expect(before.textHash).toBe(embedTextHash("SOW\n\nsigned"));

    // The same message, reduced to different text: the rules changed under it.
    db.update(embeddingState).set({ textHash: "stale" }).where(eq(embeddingState.messageId, "a1:m1")).run();
    const embedder = new FakeEmbedder();
    expect(await embedPending(db, embedder, {})).toEqual({ embedded: 1, reembedded: 1 });
    expect(embedder.calls[0]).toEqual([`${DOCUMENT_PREFIX}SOW\n\nsigned`]);
    expect(db.select().from(embeddingState).all()[0]!.textHash).toBe(embedTextHash("SOW\n\nsigned"));
    // One vector per message, not two.
    expect((db.$client.prepare("SELECT count(*) n FROM message_embeddings").get() as { n: number }).n).toBe(1);
  });

  it("treats a row with no hash as stale, so mail embedded before the rules is redone", async () => {
    const db = testDb();
    account(db);
    addMessage(db, { id: "m1", subject: "SOW", body: "signed" });
    await embedPending(db, new FakeEmbedder(), {});
    db.update(embeddingState).set({ textHash: null }).run();
    expect(await embedPending(db, new FakeEmbedder(), {})).toEqual({ embedded: 1, reembedded: 1 });
  });

  it("lets an embedder failure through rather than marking the mail done", async () => {
    const db = testDb();
    account(db);
    addMessage(db, { id: "m1", subject: "one", body: "a" });
    const broken = {
      embed: async () => {
        throw new EmbeddingsUnavailableError("Ollama is not running at http://127.0.0.1:11434");
      },
    };
    await expect(embedPending(db, broken, {})).rejects.toThrow("Ollama is not running");
    expect(db.select().from(embeddingState).all()).toEqual([]);
  });
});

describe("projectVectors", () => {
  it("embeds each project once and re-embeds only on a reword", async () => {
    const db = testDb();
    account(db);
    saveProjects(db, "a1", [{ name: "Consulting", description: "client work" }]);
    const embedder = new FakeEmbedder();

    const first = await projectVectors(db, embedder, "a1");
    await projectVectors(db, embedder, "a1");
    expect(embedder.calls).toHaveLength(1);
    // A project is what the mail is matched against, so it goes as a query.
    expect(embedder.calls[0]).toEqual([`${QUERY_PREFIX}Consulting: client work`]);
    expect([...first.values()][0]).toEqual(fakeVector("Consulting: client work"));

    const project = listProjects(db, "a1")[0]!;
    saveProjects(db, "a1", [{ id: project.id, name: "Consulting", description: "client work and tutoring" }]);
    await projectVectors(db, embedder, "a1");
    expect(embedder.calls).toHaveLength(2);
  });
});

describe("classifyProjects", () => {
  it("files a message under the project it reads like", async () => {
    const db = testDb();
    account(db);
    saveProjects(db, "a1", [
      { name: "Consulting", description: "proposal SOW invoice retainer engagement advisory deliverable client" },
      { name: "Immigration", description: "trademark application the registry attorney recommendation letter evidence visa" },
    ]);
    const sow = addMessage(db, { id: "m1", subject: "SOW invoice", body: "proposal retainer advisory deliverable client engagement" });
    const rfe = addMessage(db, { id: "m2", subject: "the registry petition", body: "attorney recommendation letter evidence visa trademark" });

    const embedder = new FakeEmbedder();
    await embedPending(db, embedder, {});
    const result = await classifyProjects(db, embedder, "a1", { threshold: 0.4 });

    expect(result.filed).toBe(2);
    const [consulting, immigration] = listProjects(db, "a1");
    const byId = new Map(db.select().from(projectAssignments).all().map((r) => [r.messageId, r]));
    expect(byId.get(sow)?.projectId).toBe(consulting!.id);
    expect(byId.get(rfe)?.projectId).toBe(immigration!.id);
    expect(byId.get(sow)?.source).toBe("auto");
    expect(byId.get(sow)?.score).toBeGreaterThan(0.4);
  });

  it("leaves a receipt unfiled when nothing clears the threshold", async () => {
    const db = testDb();
    account(db);
    saveProjects(db, "a1", [{ name: "Consulting", description: "proposal SOW invoice retainer engagement advisory client" }]);
    const receipt = addMessage(db, { id: "m1", subject: "Your package shipped", body: "tracking number 9400 delivery Tuesday" });

    const embedder = new FakeEmbedder();
    await embedPending(db, embedder, {});
    const result = await classifyProjects(db, embedder, "a1");

    expect(result).toEqual({ filed: 0, unfiled: 1 });
    const assignment = db.select().from(projectAssignments).where(eq(projectAssignments.messageId, receipt)).get();
    expect(assignment?.projectId).toBeNull();
    expect(assignment?.source).toBe("auto");
    expect(assignment?.score).toBeLessThan(0.55);
  });

  it("never overwrites a manual filing", async () => {
    const db = testDb();
    account(db);
    saveProjects(db, "a1", [
      { name: "Consulting", description: "proposal SOW invoice retainer engagement advisory client" },
      { name: "Immigration", description: "trademark application the registry attorney letter evidence visa" },
    ]);
    const id = addMessage(db, { id: "m1", subject: "SOW invoice", body: "proposal retainer advisory client engagement" });
    const [, immigration] = listProjects(db, "a1");
    fileThread(db, "a1:t-m1", immigration!.id);

    const embedder = new FakeEmbedder();
    await embedPending(db, embedder, {});
    await classifyProjects(db, embedder, "a1", { threshold: 0.1 });

    const assignment = db.select().from(projectAssignments).where(eq(projectAssignments.messageId, id)).get();
    expect(assignment?.projectId).toBe(immigration!.id);
    expect(assignment?.source).toBe("manual");
  });

  it("lets a manual filing pull a near-duplicate in on the next pass", async () => {
    const db = testDb();
    account(db);
    saveProjects(db, "a1", [{ name: "Consulting", description: "proposal SOW invoice retainer" }]);
    const project = listProjects(db, "a1")[0]!;
    const body = "Reminder: the quarterly onsite workshop runs Thursday in the Cambridge annex";
    const exemplar = addMessage(db, { id: "m1", subject: "Quarterly onsite workshop", body });
    const twin = addMessage(db, { id: "m2", subject: "Quarterly onsite workshop", body: `${body} again` });

    const embedder = new FakeEmbedder();
    await embedPending(db, embedder, {});
    // Neither reads like the description, so both start Unfiled.
    expect(await classifyProjects(db, embedder, "a1")).toEqual({ filed: 0, unfiled: 2 });

    fileThread(db, `a1:t-m1`, project.id);
    const after = await classifyProjects(db, embedder, "a1");

    expect(after).toEqual({ filed: 1, unfiled: 0 });
    const rows = new Map(db.select().from(projectAssignments).all().map((r) => [r.messageId, r]));
    expect(rows.get(exemplar)?.source).toBe("manual");
    expect(rows.get(twin)?.projectId).toBe(project.id);
    expect(rows.get(twin)?.source).toBe("auto");
  });

  it("leaves an inbox with no projects alone", async () => {
    const db = testDb();
    account(db);
    addMessage(db, { id: "m1", subject: "SOW", body: "signed" });
    const embedder = new FakeEmbedder();
    await embedPending(db, embedder, {});

    expect(await classifyProjects(db, embedder, "a1")).toEqual({ filed: 0, unfiled: 1 });
    expect(db.select().from(projectAssignments).all()).toEqual([]);
  });

  it("stays inside the inbox it was asked about", async () => {
    const db = testDb();
    account(db);
    saveProjects(db, "a1", [{ name: "Consulting", description: "proposal SOW invoice retainer" }]);
    addMessage(db, { id: "m1", subject: "SOW invoice", body: "proposal retainer" });
    addMessage(db, { id: "m2", accountId: "a2", subject: "SOW invoice", body: "proposal retainer" });

    const embedder = new FakeEmbedder();
    await embedPending(db, embedder, {});
    await classifyProjects(db, embedder, "a1", { threshold: 0.1 });

    expect(db.select().from(projectAssignments).all().map((r) => r.messageId)).toEqual(["a1:m1"]);
  });
});

describe("fileThread", () => {
  it("files every message in the thread by hand, including the operator's", () => {
    const db = testDb();
    account(db);
    const project = createProject(db, "a1", "Consulting", "client work");
    addMessage(db, { id: "m1", subject: "SOW", body: "signed", threadId: "a1:t1" });
    addMessage(db, { id: "m2", subject: "Re: SOW", body: "thanks", fromOperator: true, threadId: "a1:t1" });

    expect(fileThread(db, "a1:t1", project.id)).toEqual({ filed: 2 });
    const rows = db.select().from(projectAssignments).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.projectId === project.id && r.source === "manual" && r.score === null)).toBe(true);

    // Moving to Unfiled is a manual decision too.
    expect(fileThread(db, "a1:t1", null)).toEqual({ filed: 2 });
    expect(db.select().from(projectAssignments).all().every((r) => r.projectId === null && r.source === "manual")).toBe(true);
  });
});

describe("the margin behind the winner", () => {
  it("leaves a message that fits two projects almost equally Unfiled", async () => {
    const db = testDb();
    account(db);
    // Two projects that share most of their words: whichever edges the other
    // does so by noise, which is how one project fills with the other's mail.
    saveProjects(db, "a1", [
      { name: "Consulting", description: "contract invoice signature agreement documents legal review" },
      { name: "Immigration", description: "contract invoice signature agreement documents legal filing" },
    ]);
    const id = addMessage(db, { id: "m1", subject: "Documents", body: "contract invoice signature agreement documents legal" });

    await embedPending(db, new FakeEmbedder(), {});
    expect(await classifyProjects(db, new FakeEmbedder(), "a1")).toEqual({ filed: 0, unfiled: 1 });

    const row = db.select().from(projectAssignments).where(eq(projectAssignments.messageId, id)).get()!;
    expect(row.projectId).toBeNull();
    // The near miss is still recorded, so the score is legible rather than lost.
    expect(row.score).toBeGreaterThan(0.55);
  });

  it("files it once one project is clearly ahead", async () => {
    const db = testDb();
    account(db);
    saveProjects(db, "a1", [
      { name: "Consulting", description: "proposal SOW invoice retainer engagement advisory deliverable client" },
      { name: "Immigration", description: "trademark application the registry attorney recommendation letter evidence visa" },
    ]);
    const id = addMessage(db, { id: "m1", subject: "SOW invoice", body: "proposal retainer advisory deliverable client engagement" });

    await embedPending(db, new FakeEmbedder(), {});
    expect(await classifyProjects(db, new FakeEmbedder(), "a1")).toEqual({ filed: 1, unfiled: 0 });
    const project = listProjects(db, "a1").find((p) => p.name === "Consulting")!;
    expect(db.select().from(projectAssignments).where(eq(projectAssignments.messageId, id)).get()!.projectId).toBe(project.id);
  });

  it("lets a hand-filed exemplar carry a near-duplicate over the margin", async () => {
    const db = testDb();
    account(db);
    saveProjects(db, "a1", [
      { name: "Consulting", description: "contract invoice signature agreement documents legal review" },
      { name: "Immigration", description: "contract invoice signature agreement documents legal filing" },
    ]);
    const body = "contract invoice signature agreement documents legal";
    addMessage(db, { id: "filed", subject: "Documents", body, threadId: "a1:filed" });
    const twin = addMessage(db, { id: "m1", subject: "Documents", body: `${body} again`, threadId: "a1:twin" });

    await embedPending(db, new FakeEmbedder(), {});
    // Nothing separates the two projects on words alone.
    expect(await classifyProjects(db, new FakeEmbedder(), "a1")).toEqual({ filed: 0, unfiled: 2 });

    const consulting = listProjects(db, "a1").find((p) => p.name === "Consulting")!;
    fileThread(db, "a1:filed", consulting.id);
    expect(await classifyProjects(db, new FakeEmbedder(), "a1")).toEqual({ filed: 1, unfiled: 0 });
    expect(db.select().from(projectAssignments).where(eq(projectAssignments.messageId, twin)).get()!.projectId).toBe(consulting.id);
  });

  it("is off when the margin is zero, which is what the old rule did", async () => {
    const db = testDb();
    account(db);
    saveProjects(db, "a1", [
      { name: "Consulting", description: "contract invoice signature agreement documents legal review" },
      { name: "Immigration", description: "contract invoice signature agreement documents legal filing" },
    ]);
    addMessage(db, { id: "m1", subject: "Documents", body: "contract invoice signature agreement documents legal" });
    await embedPending(db, new FakeEmbedder(), {});
    expect(await classifyProjects(db, new FakeEmbedder(), "a1", { margin: 0 })).toEqual({ filed: 1, unfiled: 0 });
    expect(DEFAULT_MARGIN).toBeGreaterThan(0);
  });
});

describe("countByProject", () => {
  it("counts inbound mail per project, with everything else unfiled and a total", async () => {
    const db = testDb();
    account(db);
    const project = createProject(db, "a1", "Consulting", "client work");
    addMessage(db, { id: "m1", subject: "SOW", body: "signed", threadId: "a1:t1" });
    addMessage(db, { id: "m2", subject: "Receipt", body: "order" });
    addMessage(db, { id: "mine", subject: "Re: SOW", body: "thanks", fromOperator: true, threadId: "a1:t1" });
    addMessage(db, { id: "m3", accountId: "a2", subject: "Other inbox", body: "x" });
    fileThread(db, "a1:t1", project.id);

    expect(countByProject(db, { accountId: "a1" })).toEqual({ [project.id]: 1, [UNFILED_KEY]: 1, [ALL_KEY]: 2 });
    // A message the pass has explicitly called Unfiled counts the same as one it never reached.
    await embedPending(db, new FakeEmbedder(), {});
    await classifyProjects(db, new FakeEmbedder(), "a1");
    expect(countByProject(db, { accountId: "a1" })).toEqual({ [project.id]: 1, [UNFILED_KEY]: 1, [ALL_KEY]: 2 });
    expect(countByProject(db)).toEqual({ [project.id]: 1, [UNFILED_KEY]: 2, [ALL_KEY]: 3 });
  });

  it("keeps its counts through a rename and moves them to Unfiled on a delete", async () => {
    const db = testDb();
    account(db);
    const project = createProject(db, "a1", "Consulting", "client work");
    addMessage(db, { id: "m1", subject: "SOW", body: "signed", threadId: "a1:t1" });
    fileThread(db, "a1:t1", project.id);

    saveProjects(db, "a1", [{ id: project.id, name: "Advisory", description: "client work" }]);
    expect(countByProject(db, { accountId: "a1" })).toEqual({ [project.id]: 1, [ALL_KEY]: 1 });

    saveProjects(db, "a1", []);
    expect(countByProject(db, { accountId: "a1" })).toEqual({ [UNFILED_KEY]: 1, [ALL_KEY]: 1 });
  });

  it("respects the window", () => {
    const db = testDb();
    account(db);
    addMessage(db, { id: "m1", subject: "old", body: "x" });
    const recent = addMessage(db, { id: "m2", subject: "new", body: "y" });
    const at = db.select().from(messages).where(eq(messages.id, recent)).get()!.sentAt;
    expect(countByProject(db, { accountId: "a1", since: at })).toEqual({ [UNFILED_KEY]: 1, [ALL_KEY]: 1 });
  });

  it("counts the operator's own mail under Sent, and both sides under Deleted items", () => {
    const db = testDb();
    account(db);
    const project = createProject(db, "a1", "Consulting", "client work");
    // One thread: an inbound message and the operator's reply, both filed.
    addMessage(db, { id: "m1", subject: "SOW", body: "signed", threadId: "a1:t1" });
    addMessage(db, { id: "mine", subject: "Re: SOW", body: "thanks", fromOperator: true, threadId: "a1:t1", folder: "sent" });
    // Deleted items holds one of each side.
    addMessage(db, { id: "d1", subject: "Old", body: "x", threadId: "a1:t2", folder: "trash" });
    addMessage(db, { id: "d2", subject: "Re: Old", body: "y", fromOperator: true, threadId: "a1:t2", folder: "trash" });
    fileThread(db, "a1:t1", project.id);

    expect(countByProject(db, { accountId: "a1", folder: "inbox" })).toEqual({ [project.id]: 1, [ALL_KEY]: 1 });
    expect(countByProject(db, { accountId: "a1", folder: "sent" })).toEqual({ [project.id]: 1, [ALL_KEY]: 1 });
    expect(countByProject(db, { accountId: "a1", folder: "trash" })).toEqual({ [UNFILED_KEY]: 2, [ALL_KEY]: 2 });
    expect(countByProject(db, { accountId: "a1", folder: "junk" })).toEqual({ [ALL_KEY]: 0 });
  });
});

describe("runProjectsPass", () => {
  it("embeds then files in one call", async () => {
    const db = testDb();
    account(db);
    saveProjects(db, "a1", [{ name: "Consulting", description: "proposal SOW invoice retainer advisory client" }]);
    addMessage(db, { id: "m1", subject: "SOW invoice", body: "proposal retainer advisory client" });
    addMessage(db, { id: "m2", subject: "Package shipped", body: "tracking delivery Tuesday" });

    const result = await runProjectsPass(db, testConfig(), "a1", new FakeEmbedder());
    expect(result.embedded).toBe(2);
    expect(result.filed + result.unfiled).toBe(2);
  });
});

describe("without sqlite-vec", () => {
  it("refuses every embedding path with a message naming the cause", async () => {
    const db = testDb();
    account(db);
    db.vecAvailable = false;
    const embedder = new FakeEmbedder();
    await expect(embedPending(db, embedder, {})).rejects.toThrow(EmbeddingsUnavailableError);
    await expect(classifyProjects(db, embedder, "a1")).rejects.toThrow("sqlite-vec failed to load");
    await expect(runProjectsPass(db, testConfig(), "a1", embedder)).rejects.toThrow("sqlite-vec failed to load");
  });

  it("still files a thread by hand", () => {
    const db = testDb();
    account(db);
    const project = createProject(db, "a1", "Consulting", "client work");
    addMessage(db, { id: "m1", subject: "SOW", body: "signed", threadId: "a1:t1" });
    db.vecAvailable = false;
    expect(fileThread(db, "a1:t1", project.id)).toEqual({ filed: 1 });
  });
});

/** Groups of projects (operator, 2026-09-15): picking one shows every project in it. */
describe("project groups", () => {
  function setup() {
    const db = testDb();
    account(db);
    const bank = createProject(db, "a1", "Banking", "bank mail");
    const legal = createProject(db, "a1", "Legal", "lawyers");
    const lab = createProject(db, "a1", "Lab", "research");
    addMessage(db, { id: "m1", subject: "Wire", body: "sent", threadId: "a1:bank" });
    addMessage(db, { id: "m2", subject: "Consent", body: "sign", threadId: "a1:legal" });
    addMessage(db, { id: "m3", subject: "Paper", body: "draft", threadId: "a1:lab" });
    addMessage(db, { id: "m4", subject: "Receipt", body: "order" });
    fileThread(db, "a1:bank", bank.id);
    fileThread(db, "a1:legal", legal.id);
    fileThread(db, "a1:lab", lab.id);
    saveProjectsWithGroups(
      db,
      "a1",
      [
        { id: bank.id, name: "Banking", description: "bank mail", groupKey: "admin" },
        { id: legal.id, name: "Legal", description: "lawyers", groupKey: "admin" },
        { id: lab.id, name: "Lab", description: "research", groupKey: null },
      ],
      [{ key: "admin", name: "Admin" }],
    );
    const admin = listProjectGroups(db, "a1")[0]!;
    return { db, bank, legal, lab, admin };
  }

  it("counts a group as the sum of its projects, beside the projects themselves", () => {
    const { db, bank, legal, lab, admin } = setup();
    expect(countByProject(db, { accountId: "a1" })).toEqual({
      [bank.id]: 1,
      [legal.id]: 1,
      [lab.id]: 1,
      [UNFILED_KEY]: 1,
      [ALL_KEY]: 4,
      [groupKey(admin.id)]: 2,
    });
  });

  it("lists every project in a group when the group is picked, and one project when it is", () => {
    const { db, bank, admin } = setup();
    const subjects = (projectId: string) => listInboxMessages(db, { accountId: "a1", projectId }).map((r) => r.message.subject).sort();
    expect(subjects(groupKey(admin.id))).toEqual(["Consent", "Wire"]);
    expect(subjects(bank.id)).toEqual(["Wire"]);
  });

  it("renames a group in place, and a group left out lets its projects stand alone", () => {
    const { db, bank, legal, lab, admin } = setup();
    saveProjectsWithGroups(
      db,
      "a1",
      [
        { id: bank.id, name: "Banking", description: "bank mail", groupKey: "g" },
        { id: legal.id, name: "Legal", description: "lawyers", groupKey: null },
        { id: lab.id, name: "Lab", description: "research", groupKey: null },
      ],
      [{ id: admin.id, key: "g", name: "Paperwork" }],
    );
    expect(listProjectGroups(db, "a1").map((g) => [g.id, g.name])).toEqual([[admin.id, "Paperwork"]]);
    expect(listProjects(db, "a1").map((p) => [p.name, p.groupId])).toEqual([
      ["Banking", admin.id],
      ["Legal", null],
      ["Lab", null],
    ]);
    saveProjectsWithGroups(db, "a1", listProjects(db, "a1").map((p) => ({ id: p.id, name: p.name, description: p.description, groupKey: null })), []);
    expect(listProjectGroups(db, "a1")).toEqual([]);
    expect(listProjects(db, "a1").every((p) => p.groupId === null)).toBe(true);
    // Nothing filed moved.
    expect(countByProject(db, { accountId: "a1" })[bank.id]).toBe(1);
  });

  it("refuses an unnamed or doubled group, and a project naming a group not on the list, changing nothing", () => {
    const { db, bank, admin } = setup();
    const items = listProjects(db, "a1").map((p) => ({ id: p.id, name: p.name, description: p.description, groupKey: null as string | null }));
    expect(() => saveProjectsWithGroups(db, "a1", items, [{ key: "x", name: " " }])).toThrow(/needs a name/);
    expect(() => saveProjectsWithGroups(db, "a1", items, [{ key: "x", name: "A" }, { key: "y", name: "a" }])).toThrow(/twice/);
    expect(() => saveProjectsWithGroups(db, "a1", [{ ...items[0]!, groupKey: "nope" }], [])).toThrow(/not on the list/);
    expect(listProjectGroups(db, "a1").map((g) => g.id)).toEqual([admin.id]);
    expect(listProjects(db, "a1").find((p) => p.id === bank.id)?.groupId).toBe(admin.id);
  });
});
