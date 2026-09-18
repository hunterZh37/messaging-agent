import { describe, it, expect } from "vitest";
import { isEntryAddress, landingHref, landingPage, OPEN_SCRIPT } from "../lib/landing";

/** Where Celeste opens (operator, 2026-09-15). */
describe("landingHref", () => {
  it("opens Need to reply, then Unopened, then the Inbox", () => {
    expect(landingHref({ needsReply: 3, unopened: 5 })).toBe("/inbox?status=needs_reply");
    expect(landingHref({ needsReply: 0, unopened: 5 })).toBe("/inbox?status=unopened");
    expect(landingHref({ needsReply: 0, unopened: 0 })).toBe("/inbox");
  });
});

describe("isEntryAddress", () => {
  it("is the Inbox and the home-screen app's start address", () => {
    expect(isEntryAddress("/inbox", "")).toBe(true);
    expect(isEntryAddress("/inbox", "?status=needs_reply")).toBe(true);
  });
  it("is never a thread, another folder, or a link that asks for more", () => {
    expect(isEntryAddress("/inbox/a1%3At1", "")).toBe(false);
    expect(isEntryAddress("/inbox", "?status=unopened")).toBe(false);
    expect(isEntryAddress("/inbox", "?status=needs_reply&account=a1")).toBe(false);
    expect(isEntryAddress("/messages", "")).toBe(false);
  });
});

/** Runs the head script against a fake tab and says where it sent it, if anywhere. */
function open(pathname: string, search: string, store: Map<string, string>, writable = true): string | null {
  let went: string | null = null;
  const sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (!writable) throw new Error("quota");
      store.set(k, v);
    },
  };
  const location = { pathname, search, replace: (to: string) => (went = to) };
  new Function("sessionStorage", "location", OPEN_SCRIPT)(sessionStorage, location);
  return went;
}

describe("OPEN_SCRIPT", () => {
  it("sends a tab's first page by the landing when it came in by an entry address", () => {
    expect(open("/inbox", "?status=needs_reply", new Map())).toBe("/");
    expect(open("/inbox", "", new Map())).toBe("/");
  });
  it("agrees with isEntryAddress about what an entry address is", () => {
    for (const [p, s] of [["/inbox", ""], ["/inbox", "?status=needs_reply"], ["/inbox", "?status=unopened"], ["/inbox/t1", ""], ["/messages", ""]] as const) {
      expect(open(p, s, new Map()) === "/").toBe(isEntryAddress(p, s));
    }
  });
  it("stays put on a reload or a later page of the same tab", () => {
    const store = new Map<string, string>();
    open("/inbox", "?status=unopened", store);
    expect(open("/inbox", "?status=needs_reply", store)).toBeNull();
    expect(open("/inbox", "", store)).toBeNull();
  });
  it("never moves when the tab cannot remember, so it cannot loop", () => {
    expect(open("/inbox", "?status=needs_reply", new Map(), false)).toBeNull();
  });
});

describe("landingPage", () => {
  it("marks the tab as opened before it goes, so the row it lands on is not sent back", () => {
    const html = landingPage("/inbox?status=needs_reply");
    expect(html.indexOf("sessionStorage.setItem")).toBeLessThan(html.indexOf("location.replace"));
    expect(html).toContain('location.replace("/inbox?status=needs_reply")');
  });
});
