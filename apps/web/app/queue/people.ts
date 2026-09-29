import { frequentPeople, PEOPLE_MAX, type Person } from "@messaging-agent/core";
import { core } from "@/lib/core";

/**
 * The sidebar's own read of who the operator talks to most (operator,
 * 2026-09-28: "there should be a feature where I can easily access to the
 * most common thread with contacts I talk to a lot"), the same way
 * `treeCounts` is every page's own read of the tree's numbers.
 *
 * Enough of them for either side of the Mail/Messages toggle to show as many
 * as the operator has asked for (operator, 2026-09-28: "the toggle between
 * email and message should also function as a filter"; 2026-09-29: the number
 * beside the heading says how many to show). The toggle is the operator's, in the browser,
 * and it moves without asking the server anything — so the server sends what
 * both sides need and the rail picks. Someone reached both ways is in both
 * lists, counted once here.
 */
export interface SidebarPeople {
  /** Enough people for either side of the toggle to fill the longest list the
   * operator can ask for. */
  list: Person[];
}

export function sidebarPeople(): SidebarPeople {
  const { db } = core();
  const everyone = frequentPeople(db);
  const picked: Person[] = [];
  for (const channel of ["mail", "chat"] as const) {
    let taken = 0;
    for (const person of everyone) {
      if (taken === PEOPLE_MAX) break;
      if (!person.channels.includes(channel)) continue;
      taken += 1;
      if (!picked.includes(person)) picked.push(person);
    }
  }
  // Best first, whichever side they came from: the rail slices this in order.
  picked.sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
  return { list: picked };
}
