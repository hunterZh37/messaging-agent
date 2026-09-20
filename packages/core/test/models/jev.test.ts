import { describe, it, expect } from "vitest";
import { createJevSorter, jevQuestions, jevReason, jevState } from "../../src/models/jev";
import { NO_PROJECT, type SortInput } from "../../src/sort/types";
import type { Category } from "../../src/sort/categories";

const CATEGORIES: Category[] = [
  { name: "Needs reply", description: "a real person is waiting on my answer." },
  { name: "FYI", description: "nothing for me to do." },
];
const PROJECTS = [{ name: "Consulting", description: "client work" }];

const mail: SortInput = {
  fromAddress: "dana@example.com",
  fromName: "Dana",
  toAddresses: ["me@example.com"],
  ccAddresses: [],
  operatorAddress: "me@example.com",
  subject: "Contract for Sept",
  bodyText: "Can you sign this?",
  attachmentNames: [],
  sentAt: 1_789_700_000_000,
};

/** A list broadcast: the shape that used to reach Need to reply (2026-09-18). */
const broadcast: SortInput = {
  ...mail,
  fromAddress: "ases@lists.example.com",
  fromName: "Someone via ases",
  toAddresses: ["ases@lists.example.com"],
  subject: "[RSVP] Fireside chat",
};

function reply(answers: Record<string, unknown>, status = 200): typeof fetch {
  return (async () =>
    ({
      ok: status === 200,
      status,
      json: async () => ({ answers }),
      text: async () => "boom",
    }) as unknown as Response) as unknown as typeof fetch;
}

const sorterWith = (answers: Record<string, unknown>) => createJevSorter({ apiKey: "k", fetchImpl: reply(answers) });

const full = {
  wants: { choice: "reply", probabilities: { reply: 0.82, action: 0.11, knowing: 0.05, bin: 0.02 }, confidence: 0.8 },
  scheduling: { noul: 0.1 },
  category: { choice: "Needs reply" },
  finance: { choice: "expense" },
  project: { choice: "Consulting" },
};

describe("the state Jev is given", () => {
  it("names the recipients and whether they include the operator", () => {
    const s = jevState(mail);
    expect(s.to).toEqual(["me@example.com"]);
    expect(s.addressed_to_operator).toBe(true);
    expect(jevState(broadcast).addressed_to_operator).toBe(false);
  });

  it("says it cannot tell rather than guessing, when it does not know the operator's own address", () => {
    expect(jevState({ ...mail, operatorAddress: null }).addressed_to_operator).toBeNull();
  });

  it("reads an address inside a display name", () => {
    expect(jevState({ ...mail, toAddresses: ['"Me" <ME@example.com>'] }).addressed_to_operator).toBe(true);
  });

  it("truncates a body that would otherwise run to the whole thread", () => {
    const long = { ...mail, bodyText: "x".repeat(9000) };
    expect(String(jevState(long).body)).toContain("[truncated]");
    expect(String(jevState(long).body).length).toBeLessThan(4100);
  });
});

describe("the questions", () => {
  it("carries every option's own description, not only its name", () => {
    const q = jevQuestions("what matters to me", CATEGORIES, PROJECTS) as Record<string, { criteria?: Record<string, unknown> }>;
    expect(q.category?.criteria).toMatchObject({ "Needs reply": "a real person is waiting on my answer.", FYI: "nothing for me to do." });
    expect(q.project?.criteria).toMatchObject({ Consulting: "client work" });
  });

  it("always offers a way out: Other, and no project", () => {
    const q = jevQuestions("", [], []) as Record<string, { criteria?: Record<string, unknown> }>;
    expect(q.category?.criteria).toHaveProperty("Other");
    expect(q.project?.criteria).toHaveProperty(NO_PROJECT);
  });

  it("puts the operator's own criteria in front of the rung, where importance is decided", () => {
    const q = jevQuestions("only clients matter", CATEGORIES, PROJECTS) as Record<string, { instructions?: { the_operators_own_criteria?: string } }>;
    expect(q.wants?.instructions?.the_operators_own_criteria).toBe("only clients matter");
  });

  it("asks the ladder as a choice of four, in its own order", () => {
    const q = jevQuestions("", [], []) as Record<string, { type?: string; criteria?: Record<string, unknown> }>;
    expect(q.wants?.type).toBe("choice");
    expect(Object.keys(q.wants?.criteria ?? {})).toEqual(["reply", "action", "knowing", "bin"]);
  });
});

describe("the verdict that comes back", () => {
  it("reads the rung, the flag, the category, the money and the project", async () => {
    const r = await sorterWith(full).sort("c", CATEGORIES, PROJECTS, mail);
    expect(r).toMatchObject({ wants: "reply", scheduling: false, category: "Needs reply", finance: "expense", project: "Consulting" });
  });

  it("builds a reason out of the numbers, since Jev writes no prose", async () => {
    const r = await sorterWith(full).sort("c", CATEGORIES, PROJECTS, mail);
    expect(r.reason).toBe("Jev read this as reply at 0.82, then action at 0.11.");
  });

  it("still brings a list broadcast down a rung, and says it did", async () => {
    const r = await sorterWith(full).sort("c", CATEGORIES, PROJECTS, broadcast);
    expect(r.wants).toBe("knowing");
    expect(r.reason).toContain("not addressed on");
  });

  /** A project that has since been renamed or deleted must not be written back. */
  it("refuses a project this inbox does not have", async () => {
    const r = await sorterWith({ ...full, project: { choice: "Ghost project" } }).sort("c", CATEGORIES, PROJECTS, mail);
    expect(r.project).toBe(NO_PROJECT);
  });

  it("takes the safest rung when the answer is not one of the four", async () => {
    const r = await sorterWith({ ...full, wants: { choice: "something else" } }).sort("c", CATEGORIES, PROJECTS, mail);
    expect(r.wants).toBe("knowing");
  });

  it("reads a scheduling noul as the flag it is, at the halfway mark", async () => {
    expect((await sorterWith({ ...full, scheduling: { noul: 0.5 } }).sort("c", CATEGORIES, PROJECTS, mail)).scheduling).toBe(true);
    expect((await sorterWith({ ...full, scheduling: { noul: 0.49 } }).sort("c", CATEGORIES, PROJECTS, mail)).scheduling).toBe(false);
  });

  it("falls back to none for a money answer it does not recognise", async () => {
    expect((await sorterWith({ ...full, finance: { choice: "maybe" } }).sort("c", CATEGORIES, PROJECTS, mail)).finance).toBe("none");
  });

  it("throws on a refusal rather than writing a verdict nobody gave", async () => {
    const sorter = createJevSorter({ apiKey: "k", fetchImpl: reply({}, 429) });
    await expect(sorter.sort("c", CATEGORIES, PROJECTS, mail)).rejects.toThrow("jev 429");
  });

  it("names itself, so a verdict says which model wrote it", () => {
    expect(createJevSorter({ apiKey: "k" }).model).toBe("typesafe:jev-latest");
  });
});

describe("the reason, read on its own", () => {
  it("says how sure it was and what it nearly said instead", () => {
    expect(jevReason({ probabilities: { bin: 0.55, knowing: 0.4 } }, "bin")).toBe("Jev read this as bin at 0.55, then knowing at 0.40.");
  });

  it("still says something when no probabilities came back", () => {
    expect(jevReason(undefined, "knowing")).toBe("Jev read this as knowing.");
  });
});
