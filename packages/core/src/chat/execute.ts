import { eq } from "drizzle-orm";
import { fileThread } from "../projects/classify";
import { createProject, listProjects } from "../projects/projects";
import type { Db } from "../db/client";
import { threads } from "../db/schema";

/** How a project born of a question describes itself, so the editor shows where it came from. */
export const ASK_PROJECT_DESCRIPTION = "Created from Ask Celeste";

export interface FiledToProject {
  /** How many threads were filed. */
  filed: number;
  /** How many projects had to be made first — one per inbox involved, at most. */
  created: number;
}

/**
 * A "file these to <project>" proposal, carried out (spec 10c). The name is
 * the operator's word for the project, so it is resolved per inbox; with
 * `create` it is made where it is missing, once, and every thread goes into
 * it. Without `create`, a name no inbox has is an error rather than a new
 * project nobody asked for.
 */
export function fileThreadsToProject(
  db: Db,
  threadIds: string[],
  projectName: string,
  opts: { create?: boolean; clock?: () => number } = {},
): FiledToProject | { error: string } {
  const name = projectName.trim();
  if (name === "") return { error: "That proposal names no project." };
  if (threadIds.length === 0) return { error: "That proposal names no thread." };

  const rows = threadIds.map((id) => db.select().from(threads).where(eq(threads.id, id)).get());
  const missing = threadIds.filter((_, i) => !rows[i]);
  if (missing.length > 0) return { error: `Thread not found: ${missing[0]}.` };

  const wanted = name.toLowerCase();
  const byAccount = new Map<string, string[]>();
  for (const [i, thread] of rows.entries()) {
    const list = byAccount.get(thread!.accountId) ?? [];
    list.push(threadIds[i]!);
    byAccount.set(thread!.accountId, list);
  }

  let created = 0;
  let filed = 0;
  for (const [accountId, ids] of byAccount) {
    let project = listProjects(db, accountId).find((p) => p.name.trim().toLowerCase() === wanted);
    if (!project) {
      if (!opts.create) return { error: `No project named ${name} in this inbox.` };
      project = createProject(db, accountId, name, ASK_PROJECT_DESCRIPTION, opts.clock);
      created++;
    }
    for (const id of ids) {
      fileThread(db, id, project.id, opts.clock);
      filed++;
    }
  }
  return { filed, created };
}
