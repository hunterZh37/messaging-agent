import { frequentPeople, SIDEBAR_PEOPLE, type Person } from "@messaging-agent/core";
import { core } from "@/lib/core";

/**
 * The sidebar's own read of who the operator talks to most (operator,
 * 2026-09-28: "there should be a feature where I can easily access to the
 * most common thread with contacts I talk to a lot"), the same way
 * `treeCounts` is every page's own read of the tree's numbers.
 */
export function sidebarPeople(): Person[] {
  const { db } = core();
  return frequentPeople(db, { limit: SIDEBAR_PEOPLE });
}
