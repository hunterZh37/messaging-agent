import { describe, it, expect } from "vitest";
import { wholeInbox } from "../lib/opened";

/** Mark all opened acts on the whole inbox, every window (2026-09-14). */
describe("wholeInbox", () => {
  it("drops the window and keeps what names the mail", () => {
    expect(wholeInbox({ accountId: "a1", since: 400, projectId: "p1", finance: "income" as const })).toEqual({ accountId: "a1", projectId: "p1", finance: "income", folder: "inbox" });
  });
  it("defaults to the inbox and keeps the Messages folder when given", () => {
    expect(wholeInbox({})).toEqual({ folder: "inbox" });
    expect(wholeInbox({ folder: "messages" as const, since: 1 })).toEqual({ folder: "messages" });
  });
});
