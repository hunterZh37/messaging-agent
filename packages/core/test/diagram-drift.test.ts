import { describe, it, expect } from "vitest";
// The same rules the pre-commit and post-commit hooks run. One copy, so the
// hooks and the test cannot drift apart.
import { drift, dependencyChanges, parseNameStatus, parseNameStatusZ, DIAGRAM_JSON } from "../../../tools/diagram-drift.mjs";

/**
 * The system diagram went 42 commits without an edit while a model, three
 * sorter stages and a new tag layer landed under it (operator, 2026-09-21:
 * every change to the system should update the diagram). These are the
 * changes that must be caught, and the everyday ones that must not be.
 */

const A = (path: string) => ({ status: "A", path });
const M = (path: string) => ({ status: "M", path });
const D = (path: string) => ({ status: "D", path });

describe("drift", () => {
  it("flags a new source module, the shape of the Jev commit", () => {
    const r = drift([A("packages/core/src/models/jev.ts"), M("packages/core/src/sort/index.ts")]);
    expect(r.reasons).toEqual(["added packages/core/src/models/jev.ts"]);
    expect(r.touched).toBe(false);
  });

  it("flags removed and renamed modules", () => {
    const r = drift([
      D("packages/core/src/queue/old.ts"),
      { status: "R087", from: "apps/web/lib/tags.ts", path: "apps/web/lib/rowTags.ts" },
    ]);
    expect(r.reasons).toEqual([
      "removed packages/core/src/queue/old.ts",
      "renamed apps/web/lib/tags.ts → apps/web/lib/rowTags.ts",
    ]);
  });

  it("flags a new API route and a new top-level page, not a component inside one", () => {
    expect(drift([A("apps/web/app/api/push/route.ts")]).reasons).toHaveLength(1);
    expect(drift([A("apps/web/app/stats/page.tsx")]).reasons).toHaveLength(1);
    expect(drift([A("apps/web/app/inbox/[threadId]/Pane.tsx")]).reasons).toEqual([]);
  });

  it("flags any edit to how the server process starts", () => {
    expect(drift([M("scripts/celeste-server/start.sh")]).reasons).toEqual(["changed scripts/celeste-server/start.sh"]);
    expect(drift([M("scripts/com.example.celeste.plist")]).reasons).toHaveLength(1);
  });

  it("leaves everyday edits alone", () => {
    const r = drift([
      M("packages/core/src/sort/index.ts"),
      M("packages/core/src/db/schema.ts"),
      A("packages/core/drizzle/0040_new.sql"),
      A("packages/core/test/sort/broadcast.test.ts"),
      A("packages/core/src/sort/fixtures/mail.json"),
      A("apps/web/app/globals.css"),
      A("docs/notes.md"),
    ]);
    expect(r.reasons).toEqual([]);
  });

  it("is satisfied when the diagram comes with the change", () => {
    const r = drift([A("packages/core/src/models/jev.ts"), M(DIAGRAM_JSON)]);
    expect(r.touched).toBe(true);
  });

  it("flags an added dependency but not a version bump", () => {
    const manifests = [
      {
        name: "packages/core/package.json",
        before: { dependencies: { zod: "^3.0.0", openai: "^4.0.0" } },
        after: { dependencies: { zod: "^3.1.0", "@typesafe/jev": "^1.0.0" } },
      },
    ];
    expect(drift([M("packages/core/package.json")], manifests).reasons).toEqual([
      "added dependency @typesafe/jev in packages/core/package.json",
      "removed dependency openai in packages/core/package.json",
    ]);
  });
});

describe("dependencyChanges", () => {
  it("treats a new package.json as all additions and ignores devDependencies", () => {
    expect(dependencyChanges(null, { dependencies: { a: "1" }, devDependencies: { b: "1" } })).toEqual([
      "added dependency a",
    ]);
  });
});

describe("parseNameStatusZ", () => {
  it("keeps non-ASCII paths byte for byte, so the rules still match them", () => {
    // What `git diff --name-status -M -z` prints for a new café.ts and a rename.
    const out = "A\0packages/core/src/café.ts\0R091\0apps/web/lib/a b.ts\0apps/web/lib/ç.ts\0M\0README.md\0";
    const entries = parseNameStatusZ(out);
    expect(entries).toEqual([
      { status: "A", path: "packages/core/src/café.ts" },
      { status: "R091", from: "apps/web/lib/a b.ts", path: "apps/web/lib/ç.ts" },
      { status: "M", path: "README.md" },
    ]);
    expect(drift(entries).reasons).toEqual([
      "added packages/core/src/café.ts",
      "renamed apps/web/lib/a b.ts → apps/web/lib/ç.ts",
    ]);
  });

  it("reads empty output as no changes", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });
});

describe("parseNameStatus", () => {
  it("reads plain and rename rows", () => {
    expect(parseNameStatus("A\tx.ts\nR100\told.ts\tnew.ts\n")).toEqual([
      { status: "A", path: "x.ts" },
      { status: "R100", from: "old.ts", path: "new.ts" },
    ]);
  });
});
