import { describe, it, expect } from "vitest";
import { testDb } from "../helpers/db";
import { FakeProvider } from "../helpers/provider";
import { accounts, messages } from "../../src/db/schema";
import { proposeProjects } from "../../src/projects/propose";
import { saveProjects } from "../../src/projects/projects";
import type { MailFolder } from "../../src/db/schema";

type TestDb = ReturnType<typeof testDb>;

const REF = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;

function seedAccount(db: TestDb, id = "a1"): void {
  db.insert(accounts).values({ id, provider: "imap", email: `${id}@example.com`, displayName: null, createdAt: 1 }).run();
}

function seedMessage(
  db: TestDb,
  p: { id: string; from: string; subject: string; body: string; sentAt: number; folder?: MailFolder; accountId?: string },
): void {
  const accountId = p.accountId ?? "a1";
  db.insert(messages)
    .values({
      id: `${accountId}:${p.id}`,
      accountId,
      providerMessageId: p.id,
      threadId: `${accountId}:t-${p.id}`,
      rfcMessageId: null,
      fromAddress: p.from,
      fromName: null,
      toAddresses: ["me@example.com"],
      ccAddresses: [],
      subject: p.subject,
      bodyText: p.body,
      bodyHtml: null,
      snippet: null,
      attachmentNames: [],
      isFromOperator: p.folder === "sent",
      folder: p.folder ?? "inbox",
      sentAt: p.sentAt,
      receivedAt: p.sentAt,
    })
    .run();
}

function answer(projects: { name: string; description: string }[]) {
  return { structured: { projects } };
}

describe("proposeProjects", () => {
  it("shows the model the mail and the projects this inbox already has", async () => {
    const db = testDb();
    seedAccount(db);
    seedMessage(db, { id: "m1", from: "attorney@lawfirm.com", subject: "trademark evidence", body: "Draft letter attached.", sentAt: 200 });
    seedMessage(db, { id: "m2", from: "me@example.com", subject: "Re: pilot scope", body: "Sending the SOW.", sentAt: 100, folder: "sent" });
    saveProjects(db, "a1", [{ name: "Immigration", description: "visa petition" }]);
    const provider = new FakeProvider(REF, answer([{ name: "Northwind pilot", description: "staging pilot" }]));

    const result = await proposeProjects(db, provider, { accountId: "a1" });

    const prompt = provider.lastUser();
    expect(prompt).toContain("attorney@lawfirm.com | trademark evidence | Draft letter attached.");
    expect(prompt).toContain("me@example.com | Re: pilot scope | Sending the SOW.");
    expect(prompt).toContain("Immigration: visa petition");
    expect(result.proposals).toEqual([{ name: "Northwind pilot", description: "staging pilot" }]);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.latencyMs).toBe(5);
  });

  it("reads the newest first, up to the limit, and leaves trash and junk out", async () => {
    const db = testDb();
    seedAccount(db);
    seedMessage(db, { id: "old", from: "old@example.com", subject: "Old", body: "x", sentAt: 100 });
    seedMessage(db, { id: "new", from: "new@example.com", subject: "New", body: "x", sentAt: 300 });
    seedMessage(db, { id: "spam", from: "spam@example.com", subject: "Spam", body: "x", sentAt: 400, folder: "junk" });
    const provider = new FakeProvider(REF, answer([]));

    await proposeProjects(db, provider, { accountId: "a1", limit: 1 });

    const prompt = provider.lastUser();
    expect(prompt).toContain("new@example.com");
    expect(prompt).not.toContain("old@example.com");
    expect(prompt).not.toContain("spam@example.com");
  });

  it("puts one message on one line: quoted history off, whitespace collapsed, 200 characters", async () => {
    const db = testDb();
    seedAccount(db);
    seedMessage(db, {
      id: "m1",
      from: "maya@northwind.co",
      subject: "Re: SOW",
      body: `Signed  and\n  returned.  ${"y".repeat(400)}\n\nOn Monday Hunter wrote:\n> the SOW is attached`,
      sentAt: 100,
    });
    const provider = new FakeProvider(REF, answer([]));

    await proposeProjects(db, provider, { accountId: "a1" });

    const line = provider
      .lastUser()
      .split("\n")
      .find((l) => l.startsWith("maya@northwind.co"))!;
    expect(line).toContain("Signed and returned.");
    expect(line).not.toContain("the SOW is attached");
    expect(line.split(" | ")[2]!.length).toBe(200);
  });

  it("drops a proposal this inbox already has, whatever its case", async () => {
    const db = testDb();
    seedAccount(db);
    seedMessage(db, { id: "m1", from: "a@example.com", subject: "Hi", body: "x", sentAt: 100 });
    saveProjects(db, "a1", [{ name: "Immigration", description: "visa petition" }]);
    const provider = new FakeProvider(
      REF,
      answer([
        { name: "immigration", description: "a second one" },
        { name: "Northwind pilot", description: "staging pilot" },
      ]),
    );

    const { proposals } = await proposeProjects(db, provider, { accountId: "a1" });

    expect(proposals.map((p) => p.name)).toEqual(["Northwind pilot"]);
  });

  it("trims, truncates to the column widths, dedupes, and stops at twelve", async () => {
    const db = testDb();
    seedAccount(db);
    seedMessage(db, { id: "m1", from: "a@example.com", subject: "Hi", body: "x", sentAt: 100 });
    const provider = new FakeProvider(
      REF,
      answer([
        { name: "  Padded  ", description: "  padded description  " },
        { name: "n".repeat(80), description: "d".repeat(900) },
        { name: "Padded", description: "the same name again" },
        { name: "", description: "no name at all" },
        ...Array.from({ length: 14 }, (_, i) => ({ name: `Project ${i}`, description: `description ${i}` })),
      ]),
    );

    const { proposals } = await proposeProjects(db, provider, { accountId: "a1" });

    expect(proposals).toHaveLength(12);
    expect(proposals[0]).toEqual({ name: "Padded", description: "padded description" });
    expect(proposals[1]!.name).toHaveLength(40);
    expect(proposals[1]!.description).toHaveLength(600);
    expect(proposals.filter((p) => p.name === "Padded")).toHaveLength(1);
    expect(proposals.every((p) => p.name.length > 0)).toBe(true);
  });

  it("never proposes the reserved Unfiled", async () => {
    const db = testDb();
    seedAccount(db);
    seedMessage(db, { id: "m1", from: "a@example.com", subject: "Hi", body: "x", sentAt: 100 });
    const provider = new FakeProvider(REF, answer([{ name: "Unfiled", description: "everything else" }]));

    const { proposals } = await proposeProjects(db, provider, { accountId: "a1" });

    expect(proposals).toEqual([]);
  });

  it("asks nothing of the model when the inbox is empty", async () => {
    const db = testDb();
    seedAccount(db);
    seedAccount(db, "a2");
    seedMessage(db, { id: "m1", from: "a@example.com", subject: "Hi", body: "x", sentAt: 100, accountId: "a2" });
    const provider = new FakeProvider(REF, answer([{ name: "Invented", description: "from nothing" }]));

    const result = await proposeProjects(db, provider, { accountId: "a1" });

    expect(result.proposals).toEqual([]);
    expect(provider.structuredRequests).toHaveLength(0);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
