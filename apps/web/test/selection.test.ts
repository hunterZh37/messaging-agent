import { describe, it, expect } from "vitest";
import {
  accountLabels,
  financeWithMail,
  projectCookieValue,
  projectScope,
  selectedAccountId,
  selectedProject,
  unfiledInInbox,
} from "../lib/selection";

const accounts = [
  { id: "a1", email: "me@example.com", status: "ok" as const },
  { id: "a2", email: "work@example.com", status: "needs_signin" as const },
  { id: "a3", email: "old@gone.com", status: "disconnected" as const },
];

describe("selectedAccountId", () => {
  it("takes the URL over the cookie when it names a connected inbox", () => {
    expect(selectedAccountId("a1", "a2", accounts)).toBe("a1");
    expect(selectedAccountId("a2", undefined, accounts)).toBe("a2");
  });

  it("falls back to the cookie when the URL says nothing", () => {
    expect(selectedAccountId(undefined, "a2", accounts)).toBe("a2");
  });

  it("ignores unknown and disconnected ids, on both the URL and the cookie", () => {
    expect(selectedAccountId("nope", "a1", accounts)).toBe("a1");
    expect(selectedAccountId("a3", "a1", accounts)).toBe("a1");
    expect(selectedAccountId(undefined, "nope", accounts)).toBeUndefined();
    expect(selectedAccountId(undefined, "a3", accounts)).toBeUndefined();
  });

  it("means All when nothing selects an inbox", () => {
    expect(selectedAccountId(undefined, undefined, accounts)).toBeUndefined();
    expect(selectedAccountId("", "", accounts)).toBeUndefined();
    expect(selectedAccountId(undefined, "a1", [])).toBeUndefined();
  });
});

describe("accountLabels", () => {
  it("labels an inbox by its domain", () => {
    expect(accountLabels([{ id: "a1", email: "me@example.com" }])).toEqual({ a1: "example.com" });
  });

  it("uses the full address when two inboxes share a domain", () => {
    expect(
      accountLabels([
        { id: "a1", email: "me@example.com" },
        { id: "a2", email: "work@example.com" },
        { id: "a3", email: "solo@other.com" },
      ]),
    ).toEqual({ a1: "me@example.com", a2: "work@example.com", a3: "other.com" });
  });
});

describe("selectedProject", () => {
  const projects = [{ id: "p1" }, { id: "p2" }];

  it("takes the URL over the cookie when it names one of the inbox's projects", () => {
    expect(selectedProject("p1", "a1:p2", "a1", projects)).toBe("p1");
    expect(selectedProject("unfiled", "a1:p2", "a1", projects)).toBe("unfiled");
  });

  it("falls back to the cookie when the URL says nothing", () => {
    expect(selectedProject(undefined, "a1:p2", "a1", projects)).toBe("p2");
    expect(selectedProject(undefined, "a1:unfiled", "a1", projects)).toBe("unfiled");
  });

  it("ignores a cookie left by another inbox", () => {
    expect(selectedProject(undefined, "a2:p1", "a1", projects)).toBeUndefined();
  });

  it("ignores a project that no longer exists, on the URL and the cookie", () => {
    expect(selectedProject("gone", undefined, "a1", projects)).toBeUndefined();
    expect(selectedProject(undefined, "a1:gone", "a1", projects)).toBeUndefined();
    // A stale URL still lets a good cookie through.
    expect(selectedProject("gone", "a1:p2", "a1", projects)).toBe("p2");
  });

  it("is All projects when neither the link nor the cookie says anything usable", () => {
    expect(selectedProject(undefined, undefined, "a1", projects)).toBeUndefined();
    expect(selectedProject(undefined, "nonsense", "a1", projects)).toBeUndefined();
  });

  it("takes any inbox's project under All inboxes, remembered under its own owner", () => {
    // Operator, 2026-09-10: the bar under All inboxes shows every inbox's
    // projects, so picking one there has to survive a reload like any other.
    expect(selectedProject("p1", undefined, undefined, projects, ["a1", "a2"])).toBe("p1");
    expect(selectedProject(undefined, "all:p2", undefined, projects, ["a1", "a2"])).toBe("p2");
  });

  it("keeps one inbox's choice out of the All view, and the All choice out of an inbox", () => {
    expect(selectedProject(undefined, "a1:p1", undefined, projects, ["a1"])).toBeUndefined();
    expect(selectedProject(undefined, "all:p1", "a1", projects)).toBeUndefined();
  });

  it("takes an inbox's Unfiled under All inboxes only when it names a real inbox", () => {
    expect(selectedProject("unfiled:a2", undefined, undefined, projects, ["a1", "a2"])).toBe("unfiled:a2");
    expect(selectedProject(undefined, "all:unfiled:a2", undefined, projects, ["a1", "a2"])).toBe("unfiled:a2");
    expect(selectedProject("unfiled:gone", undefined, undefined, projects, ["a1", "a2"])).toBeUndefined();
    // Bare "unfiled" would list every inbox's while no tab could say so.
    expect(selectedProject("unfiled", undefined, undefined, projects, ["a1", "a2"])).toBeUndefined();
    // Under one inbox, Unfiled is that inbox's and needs no name.
    expect(selectedProject("unfiled:a1", undefined, "a1", projects)).toBeUndefined();
  });
});

describe("projectCookieValue", () => {
  it("scopes the choice to the inbox that owns it", () => {
    expect(projectCookieValue("a1", "p1")).toBe("a1:p1");
    expect(projectCookieValue("a1", "unfiled")).toBe("a1:unfiled");
  });

  it("gives the choice made under All inboxes its own owner", () => {
    expect(projectCookieValue(undefined, "p1")).toBe("all:p1");
    expect(projectCookieValue(undefined, unfiledInInbox("a2"))).toBe("all:unfiled:a2");
  });
});

describe("projectScope", () => {
  it("passes a project id straight through, and names no inbox", () => {
    expect(projectScope("p1")).toEqual({ projectId: "p1" });
    expect(projectScope("unfiled")).toEqual({ projectId: "unfiled" });
    expect(projectScope(undefined)).toEqual({});
  });

  it("splits an inbox's Unfiled into the filter and the inbox it narrows to", () => {
    expect(projectScope(unfiledInInbox("a2"))).toEqual({ projectId: "unfiled", accountId: "a2" });
  });
});

describe("financeWithMail", () => {
  it("keeps a side the current project actually holds", () => {
    expect(financeWithMail("income", { income: 3, expense: 0 })).toBe("income");
    expect(financeWithMail("expense", { income: 0, expense: 9 })).toBe("expense");
  });

  it("drops a side the current project holds none of", () => {
    // The operator moved to a project with no expense mail: the filter comes
    // off rather than showing them an empty list they did not ask for.
    expect(financeWithMail("expense", { income: 4, expense: 0 })).toBeUndefined();
    expect(financeWithMail("income", { income: 0, expense: 0 })).toBeUndefined();
  });

  it("has nothing to say when no side is applied", () => {
    expect(financeWithMail(undefined, { income: 0, expense: 0 })).toBeUndefined();
    expect(financeWithMail(undefined, { income: 5, expense: 5 })).toBeUndefined();
  });
});
