import { describe, it, expect } from "vitest";
import { FakeProvider } from "../helpers/provider";
import { EXAMPLES_HEADING, type SortExample } from "../../src/sort/examples";
import { createSorterFor, RULES_HEADING } from "../../src/sort/sorter";
import { NO_PROJECT, type SortInput, type SortResult } from "../../src/sort/types";

const VERDICT: SortResult = {
  important: true,
  needs_reply: false,
  scheduling: false,
  category: "Money",
  finance: "expense",
  disposable: false,
  project: NO_PROJECT,
  reason: "a bill",
};

const CATEGORIES = [{ name: "Money", description: "bills and invoices." }];
const PROJECTS = [{ name: "Consulting", description: "client work." }];

const INPUT: SortInput = {
  id: "a1:m9",
  accountId: "a1",
  fromAddress: "billing@acme.com",
  fromName: "Acme Billing",
  subject: "Invoice 1002",
  bodyText: "Please pay.",
  attachmentNames: [],
  sentAt: 1725600000000,
};

const EXAMPLE: SortExample = {
  fromLine: "Acme Billing <billing@acme.com>",
  subject: "Invoice 1001",
  snippet: "Please pay the last one.",
  verdict: { important: true, needs_reply: false, scheduling: false, category: "Money", finance: "expense", disposable: false, project: "Consulting" },
};

function provider(): FakeProvider {
  return new FakeProvider({ provider: "ollama", model: "qwen3:8b" }, { structured: VERDICT });
}

describe("createSorterFor with the learning aids", () => {
  it("puts the examples in the user message, above the mail, and never in a cached block", async () => {
    const p = provider();
    const sorter = createSorterFor(p, { examplesFor: async () => [EXAMPLE] });
    await sorter.sort("criteria", CATEGORIES, PROJECTS, INPUT);

    const user = p.lastUser();
    expect(user).toContain(EXAMPLES_HEADING);
    expect(user).toContain("Subject: Invoice 1001");
    expect(user.indexOf(EXAMPLES_HEADING)).toBeLessThan(user.indexOf("From: Acme Billing <billing@acme.com>\nDate:"));
    expect(p.lastSystem().join("\n")).not.toContain(EXAMPLES_HEADING);
  });

  it("puts the learned rules in a cached system block after the projects", async () => {
    const p = provider();
    const sorter = createSorterFor(p, { rules: async () => "Acme always means money." });
    await sorter.sort("criteria", CATEGORIES, PROJECTS, INPUT);

    const system = p.structuredRequests.at(-1)!.system;
    expect(system).toHaveLength(5);
    expect(system[4]!.text).toBe(`${RULES_HEADING}\n\nAcme always means money.`);
    expect(system[4]!.cache).toBe(true);
    expect(system[3]!.text).toContain("# Projects (this inbox)");
  });

  it("leaves the prompt exactly as it was when there are no aids", async () => {
    const bare = provider();
    await createSorterFor(bare).sort("criteria", CATEGORIES, PROJECTS, INPUT);
    expect(bare.lastSystem()).toHaveLength(4);
    expect(bare.lastUser()).not.toContain(EXAMPLES_HEADING);
    expect(bare.lastUser().startsWith("From: Acme Billing")).toBe(true);
  });

  it("adds nothing for an empty example list or a missing rules file", async () => {
    const p = provider();
    await createSorterFor(p, { examplesFor: async () => [], rules: async () => null }).sort("criteria", CATEGORIES, PROJECTS, INPUT);
    expect(p.lastSystem()).toHaveLength(4);
    expect(p.lastUser().startsWith("From: Acme Billing")).toBe(true);
  });

  it("still sorts when an aid throws: a verdict beats a perfect prompt", async () => {
    const p = provider();
    const sorter = createSorterFor(p, {
      examplesFor: async () => {
        throw new Error("Ollama is not running");
      },
      rules: async () => {
        throw new Error("disk on fire");
      },
    });
    expect(await sorter.sort("criteria", CATEGORIES, PROJECTS, INPUT)).toEqual(VERDICT);
    expect(p.lastSystem()).toHaveLength(4);
  });
});
