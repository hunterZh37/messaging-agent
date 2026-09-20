import { describe, it, expect } from "vitest";
import { rowTags } from "../lib/rowTags";

const row = (over: Partial<Parameters<typeof rowTags>[0]> = {}) => ({
  unread: false,
  sort: { wants: "knowing" as const },
  project: null,
  ...over,
});
const names = (...args: Parameters<typeof rowTags>) => rowTags(...args).map((t) => t.name);

describe("the labels on a row", () => {
  it("names the rung the message is on", () => {
    expect(names(row({ sort: { wants: "reply" } }))).toEqual(["Reply"]);
    expect(names(row({ sort: { wants: "action" } }))).toEqual(["Action Required"]);
    expect(names(row({ sort: { wants: "bin" } }))).toEqual(["Safe to Delete"]);
  });

  it("says unopened beside the rung, not instead of it", () => {
    expect(names(row({ unread: true, sort: { wants: "reply" } }))).toEqual(["Unopened", "Reply"]);
  });

  it("names the project it is filed under, last", () => {
    expect(names(row({ project: { id: "p1", name: "Housing" } }))).toEqual(["Worth Knowing", "Housing"]);
  });

  it("leaves off the one the list it is in already says", () => {
    expect(names(row({ sort: { wants: "bin" } }), { status: "disposable" })).toEqual([]);
    expect(names(row({ unread: true }), { status: "unopened" })).toEqual(["Worth Knowing"]);
  });

  /** Reply and Action Required share one row, so that row says both. */
  it("leaves off both rungs under Reply / Action Required", () => {
    expect(names(row({ sort: { wants: "reply" } }), { status: "owed" })).toEqual([]);
    expect(names(row({ sort: { wants: "action" } }), { status: "owed" })).toEqual([]);
  });

  it("keeps the rung a different list is filtered on", () => {
    expect(names(row({ sort: { wants: "reply" } }), { status: "knowing" })).toEqual(["Reply"]);
  });

  it("leaves off the project the view is already filtered to", () => {
    expect(names(row({ project: { id: "p1", name: "Housing" } }), { project: "p1" })).toEqual(["Worth Knowing"]);
  });

  it("says nothing about mail the sorter has not judged", () => {
    expect(names(row({ sort: null }))).toEqual([]);
  });
});
