/**
 * Threads opened in this tab, and when (operator, 2026-09-15: "when I open a
 * message, the blue dot of unopened message does not disappear"). The server
 * records an open without reading the list again, and the list a phone goes
 * back to is the copy it already had, so its dot came from before the open.
 * A row reads this to go quiet at once; a message that arrives after the open
 * is newer than it, so its dot still shows.
 */
type Listener = () => void;
const openedAt = new Map<string, number>();
const listeners = new Set<Listener>();
let version = 0;

export const openedHere = {
  mark(threadId: string, at: number = Date.now()): void {
    openedAt.set(threadId, at);
    version++;
    for (const l of listeners) l();
  },
  at(threadId: string): number | undefined {
    return openedAt.get(threadId);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  version(): number {
    return version;
  },
};

/** Whether a row's dot still means something: unread on the server, and not opened here since it arrived. */
export function stillUnread(unread: boolean, receivedAt: number, opened: number | undefined): boolean {
  return unread && !(opened !== undefined && opened >= receivedAt);
}
