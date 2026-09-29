import { frequentPeople, SIDEBAR_PEOPLE, type Person } from "@messaging-agent/core";
import { core } from "@/lib/core";

/**
 * The sidebar's own read of who the operator talks to most (operator,
 * 2026-09-28: "there should be a feature where I can easily access to the
 * most common thread with contacts I talk to a lot"), the same way
 * `treeCounts` is every page's own read of the tree's numbers.
 *
 * Enough of them for either side of the Mail/Messages toggle to show a full
 * eight (operator, 2026-09-28: "the toggle between email and message should
 * also function as a filter"). The toggle is the operator's, in the browser,
 * and it moves without asking the server anything — so the server sends what
 * both sides need and the rail picks. Someone reached both ways is in both
 * lists, counted once here.
 */
export interface SidebarPeople {
  /** Enough people for either side of the toggle to show a full eight. */
  list: Person[];
  /** How many the operator has on each side, which the rail says beside its
   * heading (operator, 2026-09-29: "next to the text there should be a number
   * for displaying how many contacts should be shown") — so eight rows read
   * as the top of a longer list rather than as the whole of it. */
  mail: number;
  chat: number;
}

export function sidebarPeople(): SidebarPeople {
  const { db } = core();
  const everyone = frequentPeople(db);
  const picked: Person[] = [];
  for (const channel of ["mail", "chat"] as const) {
    let taken = 0;
    for (const person of everyone) {
      if (taken === SIDEBAR_PEOPLE) break;
      if (!person.channels.includes(channel)) continue;
      taken += 1;
      if (!picked.includes(person)) picked.push(person);
    }
  }
  // Best first, whichever side they came from: the rail slices this in order.
  picked.sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
  return {
    list: picked,
    mail: everyone.filter((p) => p.channels.includes("mail")).length,
    chat: everyone.filter((p) => p.channels.includes("chat")).length,
  };
}
