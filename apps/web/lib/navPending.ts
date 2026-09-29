/**
 * Whether the app is waiting on a page the operator asked for (operator,
 * 2026-09-29: "when I click on the contact card and the content is
 * displaying, there should be a loading icon popover in the middle while the
 * background is glassy or dark").
 *
 * The 2px bar under a pressed row already says the click was heard
 * (2026-09-20). This says the app is busy, for the waits long enough that a
 * hairline is not enough of an answer: a person's page is a quarter of a
 * second of reading against a folder's tenth, and a big mailbox over all time
 * is longer than either.
 *
 * Every pressed link counts itself in and out, because React only tells a
 * link about its own navigation. A link that is taken off the screen mid-flight
 * counts itself out on the way, or the overlay would have nothing left to end
 * it and would sit there over the page that did arrive.
 */

type Listener = () => void;
const listeners = new Set<Listener>();
let waiting = 0;
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export const navPending = {
  /** One more link is waiting on its page. Returns the way to count it out. */
  start(): () => void {
    waiting += 1;
    changed();
    let counted = false;
    return () => {
      if (counted) return;
      counted = true;
      waiting = Math.max(0, waiting - 1);
      changed();
    };
  },
  /** How many links are waiting. */
  waiting(): number {
    return waiting;
  },
  /**
   * Whether anything is waiting at all, which is the whole of what the glass
   * needs to know. It is read as the store's own snapshot rather than counted
   * at render: a count that moves whenever any link starts or finishes made
   * the overlay's own wait start again from nothing each time, and a
   * navigation slow enough to need the glass could be left without it
   * (review, 2026-09-29).
   */
  busy(): boolean {
    return waiting > 0;
  },
  version(): number {
    return version;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** For a test, and for a page that wants to be sure nothing is left over. */
  reset(): void {
    waiting = 0;
    changed();
  },
};

/**
 * How long the app waits before saying it is busy. Most pages arrive inside
 * this, and an overlay that flashed on every press would be worse than none
 * (measured against the live server, 2026-09-29: a folder is about a tenth of
 * a second, a person's page a quarter).
 */
export const PENDING_AFTER_MS = 180;
