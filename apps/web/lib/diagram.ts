import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The rendered system diagram, read off disk at request time.
 *
 * It is not copied into `public/`: the file is 750 KB and archify rewrites it
 * on every commit that touches the JSON, so a copy would be a second thing to
 * keep true — the failure this whole feature exists to stop. The server runs
 * from the repository on the operator's own Mac, so reading the real file is
 * both simpler and always current.
 */

export const DIAGRAM_RELATIVE = "docs/diagrams/system-architecture.html";

/**
 * Walk up from `from` for the repository root holding the diagram. Next runs
 * with its own app directory as the working directory, and a worktree or a
 * different checkout depth would defeat a fixed `../../`.
 */
export function diagramFile(from: string = process.cwd()): string | null {
  let dir = path.resolve(from);
  for (;;) {
    const file = path.join(dir, DIAGRAM_RELATIVE);
    if (existsSync(file)) return file;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The diagram's HTML, or null when it has never been rendered. */
export async function readDiagram(from?: string): Promise<string | null> {
  const file = diagramFile(from);
  if (!file) return null;
  return readFile(file, "utf8").catch(() => null);
}
