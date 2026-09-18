import { describe, it, expect } from "vitest";
import { financeCountScope, projectCountScope, viewFromHref, type ViewScope } from "../lib/scopes";
import { financeWithMail } from "../lib/selection";

const VIEW: ViewScope = {
  folder: "inbox",
  accountId: "a1",
  status: "needs_reply",
  since: 1_000,
  project: "p1",
  finance: "income",
};

describe("projectCountScope", () => {
  it("takes the folder, child row, inbox and window, so a tab's number is what the list shows (2026-09-15)", () => {
    expect(projectCountScope(VIEW)).toEqual({ folder: "inbox", accountId: "a1", status: "needs_reply", since: 1_000 });
  });

  it("ignores the money side and the project itself, so finance cannot move the project row", () => {
    // The operator's rule: you cannot dictate the project by choosing finance.
    const quiet = projectCountScope({ ...VIEW, finance: undefined, project: undefined });
    expect(projectCountScope(VIEW)).toEqual(quiet);
  });

  it("drops what the view does not have", () => {
    expect(projectCountScope({ folder: "sent", since: null })).toEqual({ folder: "sent" });
  });
});

describe("financeCountScope", () => {
  it("takes everything above and beside it, the project included", () => {
    expect(financeCountScope(VIEW)).toEqual({
      folder: "inbox",
      accountId: "a1",
      status: "needs_reply",
      since: 1_000,
      projectId: "p1",
    });
  });

  it("leaves the window out only when it is All, which has no lower bound", () => {
    expect(financeCountScope({ ...VIEW, since: null })).not.toHaveProperty("since");
  });

  it("never narrows itself by the side it is counting", () => {
    expect(financeCountScope(VIEW)).not.toHaveProperty("finance");
  });
});

describe("the Safe-to-delete view", () => {
  it("is a child row of the inbox, carried into every count the way the others are", () => {
    const view: ViewScope = { folder: "inbox", accountId: "a1", status: "disposable", since: 1_000, project: "p1" };
    expect(projectCountScope(view)).toEqual({ folder: "inbox", accountId: "a1", status: "disposable", since: 1_000 });
    expect(financeCountScope(view)).toEqual({ folder: "inbox", accountId: "a1", status: "disposable", since: 1_000, projectId: "p1" });
  });

  it("is read back off a link, and ignored on a folder that has no such row", () => {
    expect(viewFromHref("/inbox?status=disposable&since=30d")).toEqual({ folder: "inbox", status: "disposable", window: "30d" });
    expect(viewFromHref("/deleted?status=disposable")).toEqual({ folder: "trash", window: "today" });
  });
});

describe("viewFromHref", () => {
  it("reads the folder, the child row and the window off a folder link", () => {
    expect(viewFromHref("/sent?since=all&status=waiting")).toEqual({ folder: "sent", status: "waiting", window: "all" });
    expect(viewFromHref("/deleted")).toEqual({ folder: "trash", window: "today" });
    expect(viewFromHref("/junk?since=today")).toEqual({ folder: "junk", window: "today" });
  });

  it("takes a thread's folder from its param, since the path does not say", () => {
    expect(viewFromHref("/inbox/a1%3At1?folder=sent&status=waiting")).toEqual({ folder: "sent", status: "waiting", window: "today" });
    expect(viewFromHref("/inbox/a1%3At1")).toEqual({ folder: "inbox", window: "today" });
  });

  it("falls back to the remembered window when the link does not name one", () => {
    expect(viewFromHref("/inbox", "30d").window).toBe("30d");
    expect(viewFromHref("/inbox?since=today", "30d").window).toBe("today");
  });

  it("ignores a child row the folder does not have", () => {
    expect(viewFromHref("/junk?status=needs_reply")).toEqual({ folder: "junk", window: "today" });
  });
});

describe("one money side for the whole view", () => {
  // The bug: the tree counted with the remembered side while the list had
  // already dropped it, so a row read 0 over five rows of mail.
  it("drops the side once, and every scope built after sees the same thing", () => {
    const remembered = "expense" as const;
    const counts = { income: 4, expense: 0 };
    const finance = financeWithMail(remembered, counts);
    expect(finance).toBeUndefined();

    const view: ViewScope = { folder: "inbox", accountId: "a1", since: 1_000, ...(finance ? { finance } : {}) };
    expect(financeCountScope(view)).not.toHaveProperty("finance");
    expect(projectCountScope(view)).not.toHaveProperty("finance");
  });

  it("keeps a side the view does hold, everywhere", () => {
    const finance = financeWithMail("income", { income: 4, expense: 0 });
    expect(finance).toBe("income");
  });
});
