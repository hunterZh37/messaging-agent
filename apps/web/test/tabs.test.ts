import { describe, it, expect } from "vitest";
import {
  allTab,
  ALL_TAB,
  financeTabs,
  inboxPill,
  projectTabs,
  projectTabsByInbox,
  projectName,
  groupRow,
  groupTabKey,
  UNFILED_TAB,
  type InboxTabs,
} from "../lib/tabs";

const PROJECTS = [
  { id: "p1", name: "Robotics research" },
  { id: "p2", name: "Consulting" },
  { id: "p3", name: "Immigration" },
];

describe("projectTabs", () => {
  it("keeps the operator's order and drops projects that hold nothing here", () => {
    // Operator, 2026-09-09: "hide all the project chips that have 0 emails".
    const tabs = projectTabs(PROJECTS, { [ALL_TAB]: 9, p1: 4, p3: 5 }, undefined);
    expect(tabs.map((t) => t.key)).toEqual([ALL_TAB, "p1", "p3"]);
    expect(tabs.map((t) => t.label)).toEqual(["All · 9", "Robotics research · 4", "Immigration · 5"]);
    expect(tabs.every((t) => !t.dim)).toBe(true);
  });

  it("shows Unfiled only when something is unfiled", () => {
    expect(projectTabs(PROJECTS, { [ALL_TAB]: 2, [UNFILED_TAB]: 2 }, undefined).map((t) => t.key)).toEqual([ALL_TAB, UNFILED_TAB]);
    expect(projectTabs(PROJECTS, { [ALL_TAB]: 2, p2: 2 }, undefined).map((t) => t.key)).toEqual([ALL_TAB, "p2"]);
  });

  it("keeps the tab that is on even at zero, so the filter can be switched off", () => {
    const tabs = projectTabs(PROJECTS, { [ALL_TAB]: 9, p1: 4 }, "p3");
    expect(tabs.map((t) => t.key)).toEqual([ALL_TAB, "p1", "p3"]);
    expect(tabs.find((t) => t.key === "p3")).toMatchObject({ on: true, dim: false, value: null, label: "Immigration · 0" });
    expect(tabs.find((t) => t.key === "p1")?.value).toBe("p1");
    expect(tabs.find((t) => t.key === ALL_TAB)?.on).toBe(false);
  });

  it("is All alone when nothing holds mail, and All is never removed", () => {
    const tabs = projectTabs(PROJECTS, {}, undefined);
    expect(tabs.map((t) => t.key)).toEqual([ALL_TAB]);
    expect(tabs[0]).toMatchObject({ on: true, value: null });
  });
});

describe("projectTabsByInbox", () => {
  // Operator, 2026-09-10: under All inboxes the projects still show, sorted
  // under the inbox each belongs to.
  const groups: InboxTabs[] = [
    { label: "example", accountId: "a1", projects: PROJECTS.slice(0, 2), counts: { [ALL_TAB]: 9, p1: 4, p2: 5 } },
    { label: "example", accountId: "a2", projects: PROJECTS.slice(2), counts: { [ALL_TAB]: 7, p3: 4, [UNFILED_TAB]: 3 } },
  ];

  it("gives each inbox its own row, in switcher order, with no All tab of its own", () => {
    const rows = projectTabsByInbox(groups, undefined);
    expect(rows.map((r) => [r.label, r.accountId])).toEqual([
      ["example", "a1"],
      ["example", "a2"],
    ]);
    expect(rows[0]!.tabs.map((t) => t.label)).toEqual(["Robotics research · 4", "Consulting · 5"]);
    expect(rows.every((r) => r.tabs.every((t) => t.key !== ALL_TAB))).toBe(true);
  });

  it("gives each inbox its own Unfiled, counted and named for that inbox alone", () => {
    const rows = projectTabsByInbox(groups, undefined);
    // a1 has nothing unfiled, so it has no Unfiled tab; a2's names a2.
    expect(rows[0]!.tabs.map((t) => t.key)).toEqual(["p1", "p2"]);
    expect(rows[1]!.tabs.map((t) => t.key)).toEqual(["p3", "unfiled:a2"]);
    expect(rows[1]!.tabs[1]).toMatchObject({ label: "Unfiled · 3", value: "unfiled:a2" });
  });

  it("hides what holds nothing here, and drops an inbox left with nothing to show", () => {
    const rows = projectTabsByInbox(
      [
        { ...groups[0]!, counts: { [ALL_TAB]: 4, p1: 4 } },
        { ...groups[1]!, counts: {} },
      ],
      undefined,
    );
    expect(rows.map((r) => r.accountId)).toEqual(["a1"]);
    expect(rows[0]!.tabs.map((t) => t.key)).toEqual(["p1"]);
  });

  it("keeps the tab that is on in its own row, empty or not, so it can be switched off", () => {
    const rows = projectTabsByInbox([{ ...groups[1]!, counts: {} }], "p3");
    expect(rows.map((r) => r.accountId)).toEqual(["a2"]);
    expect(rows[0]!.tabs[0]).toMatchObject({ key: "p3", on: true, dim: false, value: null, label: "Immigration · 0" });
    // The same for an inbox's Unfiled, which is what its own row calls it.
    const unfiled = projectTabsByInbox([{ ...groups[1]!, counts: {} }], "unfiled:a2");
    expect(unfiled[0]!.tabs.map((t) => t.key)).toEqual(["unfiled:a2"]);
    expect(unfiled[0]!.tabs[0]).toMatchObject({ on: true, value: null });
  });

  it("leaves another inbox's rows alone when one inbox's tab is on", () => {
    const rows = projectTabsByInbox(groups, "p3");
    expect(rows[0]!.tabs.every((t) => !t.on)).toBe(true);
    expect(rows[1]!.tabs.find((t) => t.key === "p3")?.on).toBe(true);
  });
});

describe("inboxPill", () => {
  // Operator, 2026-09-10: the row per inbox read as messy, so each inbox's
  // row folds behind a pill that says whose it is and what is under it.
  const groups: InboxTabs[] = [
    {
      label: "work.example.com",
      accountId: "a1",
      projects: [...PROJECTS, { id: "p4", name: "Grantee portal document collection" }],
      counts: { [ALL_TAB]: 12, p1: 4, p2: 5, p3: 2, p4: 1, [UNFILED_TAB]: 3 },
    },
  ];

  it("carries the inbox's mail, the number the All tab is the total of", () => {
    // Operator, 2026-09-11: a pill saying 0 under Sent while the list held
    // that inbox's mail read as a bug. The pill counts mail, not projects.
    const row = projectTabsByInbox(groups, undefined)[0]!;
    expect(row.tabs).toHaveLength(5);
    expect(row.mail).toBe(12);
    expect(inboxPill(row)).toEqual({ label: "work.example.com", count: 12 });
  });

  it("is the domain and nothing else, whichever project is on", () => {
    // Operator, 2026-09-10: a label that changed with the selection made the
    // pill jump around under the pointer.
    expect(inboxPill(projectTabsByInbox(groups, "p2")[0]!)).toEqual({ label: "work.example.com", count: 12 });
    expect(inboxPill(projectTabsByInbox(groups, "unfiled:a1")[0]!)).toEqual({ label: "work.example.com", count: 12 });
  });

  it("keeps an inbox on the bar when it has mail but no project rows, and drops one with neither", () => {
    expect(projectTabsByInbox([{ ...groups[0]!, projects: [], counts: { [ALL_TAB]: 20, [UNFILED_TAB]: 20 } }], undefined)[0]?.mail).toBe(20);
    expect(projectTabsByInbox([{ ...groups[0]!, counts: {} }], undefined)).toEqual([]);
    // The open pill stays at 0, so the empty list has a visible reason and a way out.
    expect(projectTabsByInbox([{ ...groups[0]!, counts: {} }], undefined, "a1")[0]?.mail).toBe(0);
  });
});

describe("allTab", () => {
  it("counts every inbox at once and is on when nothing is filtered", () => {
    const groups: InboxTabs[] = [
      { label: "example", accountId: "a1", projects: PROJECTS.slice(0, 2), counts: { [ALL_TAB]: 9, p1: 4, p2: 5 } },
      { label: "example", accountId: "a2", projects: PROJECTS.slice(2), counts: { [ALL_TAB]: 7, p3: 4, [UNFILED_TAB]: 3 } },
    ];
    const total = groups.reduce((n, g) => n + (g.counts[ALL_TAB] ?? 0), 0);
    expect(allTab(total, undefined)).toMatchObject({ key: ALL_TAB, label: "All · 16", on: true, value: null });
    expect(allTab(total, "p3")).toMatchObject({ label: "All · 16", on: false, value: null });
  });
});

describe("financeTabs", () => {
  it("keeps both sides in place and refuses the empty one", () => {
    const tabs = financeTabs({ income: 0, expense: 7 }, undefined);
    expect(tabs.map((t) => t.label)).toEqual(["Income · 0", "Expense · 7"]);
    expect(tabs.map((t) => t.dim)).toEqual([true, false]);
    // An empty side would open an empty list, so it is not offered.
    expect(tabs.map((t) => t.disabled)).toEqual([true, false]);
    expect(tabs.map((t) => t.value)).toEqual(["income", "expense"]);
  });

  it("leaves the applied side clickable at zero, so it can be taken off", () => {
    // A project change can empty the side already on; it stays the way out.
    const tabs = financeTabs({ income: 0, expense: 0 }, "income");
    expect(tabs[0]).toMatchObject({ on: true, disabled: false, dim: false, value: null });
    expect(tabs[1]).toMatchObject({ on: false, disabled: true });
  });

  it("clicking the side that is on turns the filter off", () => {
    const tabs = financeTabs({ income: 3, expense: 7 }, "income");
    expect(tabs[0]).toMatchObject({ on: true, value: null });
    expect(tabs[1]).toMatchObject({ on: false, value: "expense" });
  });
});

/** The phone's project sheet lists every project, even on a list that holds nothing (2026-09-15). */

/** Groups of projects (operator, 2026-09-15). */
describe("project groups in the bar", () => {
  const projects = [
    { id: "bank", name: "Banking", groupId: "admin" },
    { id: "verify", name: "E-Verify", groupId: "admin" },
    { id: "lab", name: "Lab", groupId: null },
  ];
  const groups = [{ id: "admin", name: "Admin" }];
  const counts = { [ALL_TAB]: 9, bank: 5, verify: 0, lab: 4, [groupTabKey("admin")]: 5 };

  it("shows a group as one tab ahead of the projects in no group, holding its own projects", () => {
    const tabs = projectTabs(projects, counts, undefined, groups);
    expect(tabs.map((t) => [t.key, t.label])).toEqual([
      [ALL_TAB, "All · 9"],
      [groupTabKey("admin"), "Admin · 5"],
      ["lab", "Lab · 4"],
    ]);
    expect(tabs[1]!.children?.map((t) => t.key)).toEqual(["bank"]);
    expect(groupRow(tabs)).toBeNull();
  });

  it("keeps the group lit, and its projects in a row beneath, while it or one of its projects is on", () => {
    const onGroup = projectTabs(projects, counts, groupTabKey("admin"), groups);
    const row = groupRow(onGroup)!;
    expect(row.group.name).toBe("Admin");
    expect(row.tabs.map((t) => [t.name, t.on, t.value])).toEqual([
      ["All Admin", true, groupTabKey("admin")],
      ["Banking", false, "bank"],
    ]);
    const onProject = projectTabs(projects, counts, "bank", groups);
    expect(onProject[1]).toMatchObject({ on: true, value: groupTabKey("admin") });
    // Picking the project that is on goes back to its group, not to All.
    expect(groupRow(onProject)!.tabs.map((t) => [t.name, t.on, t.value])).toEqual([
      ["All Admin", false, groupTabKey("admin")],
      ["Banking", true, groupTabKey("admin")],
    ]);
  });

});

/** A tab with nothing in this period is not offered (operator, 2026-09-15). */
describe("project tabs over a window", () => {
  it("drops what holds nothing here, and keeps the one that is on so it can be switched off", () => {
    const projects = [
      { id: "a", name: "Clients" },
      { id: "b", name: "Admin" },
    ];
    const inWindow = { [ALL_TAB]: 4, a: 4 };
    expect(projectTabs(projects, inWindow, undefined).map((t) => t.key)).toEqual([ALL_TAB, "a"]);
    expect(projectTabs(projects, inWindow, "b").map((t) => [t.key, t.dim])).toEqual([
      [ALL_TAB, false],
      ["a", false],
      // The one that is on keeps its own emphasis, empty or not.
      ["b", false],
    ]);
  });
});

/** The applied line names the group a project sits in (operator, 2026-09-15). */
describe("projectName with groups", () => {
  const projects = [
    { id: "bank", name: "Banking", groupId: "admin" },
    { id: "lab", name: "Lab", groupId: null },
  ];
  const groups = [{ id: "admin", name: "Admin" }];
  it("reads group then project, and the project alone when it is in none", () => {
    expect(projectName(projects, "bank", groups)).toBe("Admin › Banking");
    expect(projectName(projects, "lab", groups)).toBe("Lab");
    expect(projectName(projects, groupTabKey("admin"), groups)).toBe("Admin");
    expect(projectName(projects, UNFILED_TAB, groups)).toBe("Unfiled");
  });
});
