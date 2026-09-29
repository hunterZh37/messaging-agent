import { describe, it, expect, beforeEach } from "vitest";
import { navPending, PENDING_AFTER_MS } from "../lib/navPending";

/**
 * The app saying it is busy (operator, 2026-09-29: "there should be a loading
 * icon popover in the middle while the background is glassy or dark"). The
 * danger in an overlay nothing can be pressed through is the one that stays:
 * every pressed link counts itself in, and every one of them must count
 * itself out, including the ones the arriving page takes off the screen.
 */
describe("navPending", () => {
  beforeEach(() => navPending.reset());

  it("is not waiting until something is pressed", () => {
    expect(navPending.waiting()).toBe(0);
  });

  it("counts a pressed link in, and its own ending out", () => {
    const done = navPending.start();
    expect(navPending.waiting()).toBe(1);
    done();
    expect(navPending.waiting()).toBe(0);
  });

  it("stays up while a second press is still waiting", () => {
    const first = navPending.start();
    const second = navPending.start();
    first();
    expect(navPending.waiting()).toBe(1);
    second();
    expect(navPending.waiting()).toBe(0);
  });

  /** A link taken off the screen may be cleaned up twice; it counts once. */
  it("does not count one link out twice", () => {
    const done = navPending.start();
    navPending.start();
    done();
    done();
    expect(navPending.waiting()).toBe(1);
  });

  it("never falls below nothing waiting", () => {
    const done = navPending.start();
    done();
    done();
    expect(navPending.waiting()).toBe(0);
  });

  it("tells whoever is listening, each time it moves", () => {
    let heard = 0;
    const stop = navPending.subscribe(() => (heard += 1));
    const done = navPending.start();
    expect(heard).toBe(1);
    done();
    expect(heard).toBe(2);
    stop();
    navPending.start();
    expect(heard).toBe(2);
  });

  it("moves its version whenever it moves, so a render follows", () => {
    const before = navPending.version();
    navPending.start();
    expect(navPending.version()).toBeGreaterThan(before);
  });

  /**
   * The glass asks one thing: is anything waiting. It reads it from the store
   * rather than counting at render, or its own wait before showing started
   * again every time any link began or ended, and a slow page could arrive
   * with no glass ever shown (review, 2026-09-29).
   */
  it("says plainly whether anything is waiting, however many are", () => {
    expect(navPending.busy()).toBe(false);
    const first = navPending.start();
    expect(navPending.busy()).toBe(true);
    const second = navPending.start();
    // A second press does not change the answer, so nothing downstream restarts.
    expect(navPending.busy()).toBe(true);
    first();
    expect(navPending.busy()).toBe(true);
    second();
    expect(navPending.busy()).toBe(false);
  });

  it("waits long enough that a page arriving quickly shows nothing", () => {
    // A folder is about a tenth of a second on the live server, a person's
    // page a quarter (measured 2026-09-29). The first must not flash.
    expect(PENDING_AFTER_MS).toBeGreaterThan(100);
    expect(PENDING_AFTER_MS).toBeLessThan(400);
  });
});
