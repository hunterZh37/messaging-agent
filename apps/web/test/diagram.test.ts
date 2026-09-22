import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diagramFile, readDiagram, DIAGRAM_RELATIVE } from "../lib/diagram";

/**
 * The Architecture page reads the rendered diagram off disk rather than from a
 * copy in public/ (operator, 2026-09-22: a button in the app that shows it).
 * The lookup walks up from the working directory, because Next runs with
 * apps/web as its own, and a worktree sits at a different depth.
 */

let root: string;
let deep: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "diagram-"));
  deep = path.join(root, "apps", "web");
  mkdirSync(deep, { recursive: true });
  mkdirSync(path.join(root, "docs", "diagrams"), { recursive: true });
  writeFileSync(path.join(root, DIAGRAM_RELATIVE), "<html><body>diagram</body></html>");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("diagramFile", () => {
  it("finds the diagram from the app directory, several levels down", () => {
    expect(diagramFile(deep)).toBe(path.join(root, DIAGRAM_RELATIVE));
  });

  it("finds it from the repository root too", () => {
    expect(diagramFile(root)).toBe(path.join(root, DIAGRAM_RELATIVE));
  });

  it("returns null rather than throwing when nothing above has one", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "no-diagram-"));
    try {
      expect(diagramFile(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("readDiagram", () => {
  it("reads the rendered HTML", async () => {
    await expect(readDiagram(deep)).resolves.toContain("diagram");
  });

  it("is null when the diagram has never been rendered", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "no-diagram-"));
    try {
      await expect(readDiagram(empty)).resolves.toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
