import { describe, it, expect } from "vitest";
import { z } from "zod";
import { renderCategoriesSystem, renderProjectsSystem, renderSortUserMessage, sortSchemaFor } from "../../src/sort/sorter";

describe("renderSortUserMessage", () => {
  it("includes sender, subject, attachments, and truncates long bodies", () => {
    const s = renderSortUserMessage({
      fromAddress: "bob@example.com", fromName: "Bob", subject: "Invoice", bodyText: "x".repeat(10_000),
      attachmentNames: ["inv.pdf"], sentAt: 1725600000000,
    });
    expect(s).toContain("From: Bob <bob@example.com>");
    expect(s).toContain("Subject: Invoice");
    expect(s).toContain("Attachments: inv.pdf");
    expect(s).toContain("[truncated]");
    expect(s.length).toBeLessThan(5_000);
  });
});

describe("renderCategoriesSystem", () => {
  it("lists the operator's categories in order and always offers Other", () => {
    const s = renderCategoriesSystem([
      { name: "Money", description: "bills and invoices." },
      { name: "Family", description: "anything from family." },
    ]);
    expect(s.split("\n")).toEqual([
      "# Sub-categories (priority order)",
      "",
      "- Money: bills and invoices.",
      "- Family: anything from family.",
      "- Other: none of the above.",
    ]);
  });

  it("offers only Other when the operator listed none", () => {
    expect(renderCategoriesSystem([])).toContain("- Other: none of the above.");
  });
});

describe("renderProjectsSystem", () => {
  it("lists the inbox's projects in the operator's order and always offers None", () => {
    const s = renderProjectsSystem([
      { name: "Consulting", description: "client work and tutoring." },
      { name: "Immigration", description: "the trademark application." },
    ]);
    expect(s.split("\n")).toEqual([
      "# Projects (this inbox)",
      "",
      "- Consulting: client work and tutoring.",
      "- Immigration: the trademark application.",
      "- None: belongs to no project.",
    ]);
  });

  it("offers only None for an inbox with no projects yet", () => {
    expect(renderProjectsSystem([])).toBe("# Projects (this inbox)\n\n- None: belongs to no project.");
  });
});

describe("sortSchemaFor", () => {
  // A local model is handed this schema as JSON Schema (`format`), so an axis
  // that is only in the prompt is an axis the model may leave out.
  it("makes the model answer on every axis, safe-to-delete included", () => {
    const schema = z.toJSONSchema(sortSchemaFor([{ name: "Money", description: "bills." }], [{ name: "Consulting", description: "client work." }]));
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
      "important",
      "needs_reply",
      "scheduling",
      "category",
      "finance",
      "disposable",
      "project",
      "reason",
    ]);
    expect(schema.required).toContain("disposable");
    expect((schema.properties as Record<string, { type?: string }>).disposable).toEqual({ type: "boolean" });
  });
});
