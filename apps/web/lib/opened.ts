/**
 * What "Mark all opened" acts on and counts (2026-09-14): the view's scope
 * minus its window. Marking only the days on screen left older read mail to
 * surface the moment the window widened, which read as opened mail
 * reappearing. The inbox pill, project and money side still narrow it: those
 * name which mail, the window only named how far back to look.
 */
export function wholeInbox<T extends { since?: number; folder?: "inbox" | "messages" }>(scope: T): Omit<T, "since"> & { folder: "inbox" | "messages" } {
  const { since: _since, ...rest } = scope;
  void _since;
  return { ...rest, folder: scope.folder ?? "inbox" };
}
