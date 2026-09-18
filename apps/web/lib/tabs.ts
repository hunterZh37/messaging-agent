import { unfiledInInbox } from "./selection";

/** The key the "All projects" tab counts under, matching core's `ALL_KEY`. */
export const ALL_TAB = "all";

/** The key mail no project claims counts under, matching core's `UNFILED_KEY`. */
export const UNFILED_TAB = "unfiled";

export interface Tab {
  /** React key, and the key its count is filed under. */
  key: string;
  /** What it is called, without its count: "Consulting", "All", "Unfiled". */
  name: string;
  label: string;
  /** What to remember when this tab is picked: a value, or null for "no filter". */
  value: string | null;
  on: boolean;
  /** Nothing falls under it here. Still shown and still clickable, just quiet. */
  dim: boolean;
  /** Nothing falls under it and clicking would show an empty list, so it does not. */
  disabled?: boolean;
  /** A group of projects (2026-09-15): picking it shows every project in it. */
  group?: boolean;
  /** A group's own projects, which show beneath it once it or one of them is on. */
  children?: Tab[];
}

/** What a tab builder needs of a project: `groupId` places it in a group. */
export interface ProjectLike {
  id: string;
  name: string;
  groupId?: string | null;
}

/** What a tab builder needs of a group. */
export interface GroupLike {
  id: string;
  name: string;
}

/** The key a group goes by, matching core's `groupKey`. */
export function groupTabKey(groupId: string): string {
  return `group:${groupId}`;
}

/**
 * One inbox's projects as the bar shows them (2026-09-15): each group as one
 * tab holding its projects, then the projects in no group. A group's tab is
 * on when it or one of its projects is, so it stays lit while a project in it
 * narrows the list; picking a project that is already on goes back to its
 * group rather than to All. With `keepEmpty` off, what holds nothing here
 * drops out, except the one that is on.
 */
function groupedTabs(
  projects: ProjectLike[],
  groups: GroupLike[],
  counts: Record<string, number>,
  selected: string | undefined,
  keepEmpty: boolean,
): Tab[] {
  const shown = (t: Tab, key: string) => keepEmpty || t.on || (counts[key] ?? 0) > 0;
  const known = new Set(groups.map((g) => g.id));
  const out: Tab[] = [];
  for (const g of groups) {
    const key = groupTabKey(g.id);
    const children = projects
      .filter((p) => p.groupId === g.id)
      .map((p) => {
        const count = counts[p.id] ?? 0;
        const on = selected === p.id;
        const tab: Tab = { key: p.id, name: p.name, label: `${p.name} · ${count}`, value: on ? key : p.id, on, dim: count === 0 && !on };
        return { tab, count };
      })
      .filter(({ tab }) => shown(tab, tab.key))
      .map(({ tab }) => tab);
    const count = counts[key] ?? 0;
    const on = selected === key || children.some((c) => c.on);
    const tab: Tab = { key, name: g.name, label: `${g.name} · ${count}`, value: selected === key ? null : key, on, dim: count === 0 && !on, group: true, children };
    if (shown(tab, key)) out.push(tab);
  }
  for (const p of projects) {
    if (p.groupId && known.has(p.groupId)) continue;
    const tab = makeTab(p.id, p.name, p.id, counts[p.id] ?? 0, selected);
    if (shown(tab, p.id)) out.push(tab);
  }
  return out;
}

/**
 * The row beneath the bar while a group is on (operator, 2026-09-15: "when I
 * click on admin, I still want to see the sub-projects"): the whole group
 * first, then each project in it. Null when no group is on.
 */
export function groupRow(tabs: Tab[]): { group: Tab; tabs: Tab[] } | null {
  const group = tabs.find((t) => t.group && t.on);
  if (!group) return null;
  const count = group.label.slice(group.name.length + 3);
  const whole: Tab = { key: `${group.key}:all`, name: `All ${group.name}`, label: `All · ${count}`, value: group.key, on: group.value === null, dim: false };
  return { group, tabs: [whole, ...(group.children ?? [])] };
}

/**
 * One tab per project that holds mail under the current selections, in the
 * operator's order (spec 10d; operator, 2026-09-09: "hide all the project
 * chips that have 0 emails"). All always shows, and so does the tab that is
 * on, empty or not, so the filter can be seen and switched off. Picking the
 * tab that is already on goes back to All. Finance and window chips keep
 * their places regardless.
 */
export function projectTabs(
  projects: ProjectLike[],
  counts: Record<string, number>,
  selected: string | undefined,
  groups: GroupLike[] = [],
): Tab[] {
  const unfiled = makeTab(UNFILED_TAB, "Unfiled", UNFILED_TAB, counts[UNFILED_TAB] ?? 0, selected);
  return [
    makeTab(ALL_TAB, "All", null, counts[ALL_TAB] ?? 0, selected),
    ...groupedTabs(projects, groups, counts, selected, false),
    ...(unfiled.on || (counts[UNFILED_TAB] ?? 0) > 0 ? [unfiled] : []),
  ];
}

/** One tab, whichever row it stands in: what it is called, what it holds, whether it is on. */
function makeTab(key: string, name: string, value: string | null, count: number, selected: string | undefined): Tab {
  const on = value === null ? selected === undefined : selected === value;
  return {
    key,
    name,
    label: `${name} · ${count}`,
    value: on ? null : value,
    on,
    // The one that is on keeps its own emphasis, empty or not.
    dim: count === 0 && !on,
  };
}

/** One inbox's projects and what the view holds under each of them, for its row of the bar. */
export interface InboxTabs {
  /** The inbox's short name, which is what its row is labelled with. */
  label: string;
  accountId: string;
  projects: ProjectLike[];
  /** That inbox's project groups (2026-09-15); none when it has not made any. */
  groups?: GroupLike[];
  /** That inbox's counts alone, from `countByProject` scoped to it. */
  counts: Record<string, number>;
}

/** One row of the project bar under All inboxes: an inbox, and its tabs. */
export interface InboxTabRow {
  label: string;
  accountId: string;
  tabs: Tab[];
  /** How much of the view's mail this inbox holds: the number on its pill. */
  mail: number;
}

/**
 * The project bar under All inboxes (spec 10d; operator, 2026-09-10: "the
 * projects for each inbox should still show but they should be categorized
 * under different mailboxes"). One row per inbox, in switcher order, each
 * holding that inbox's own tabs and nothing else — the leading All tab is
 * the bar's own, so no row repeats it. Each row's Unfiled is that inbox's,
 * counted and filtered over that inbox alone, since two rows sharing one
 * Unfiled would each show a number neither of their lists has.
 *
 * The hidden-at-zero rule holds inside each row as it does under one inbox,
 * and the tab that is on always shows, so the filter can be switched off. An
 * inbox with nothing left to show gets no row at all.
 */
export function projectTabsByInbox(groups: InboxTabs[], selected: string | undefined, keep?: string): InboxTabRow[] {
  return groups
    .map((g) => ({
      label: g.label,
      accountId: g.accountId,
      mail: g.counts[ALL_TAB] ?? 0,
      tabs: [...groupedTabs(g.projects, g.groups ?? [], g.counts, selected, false), ...inboxUnfiled(g, selected)],
    }))
    // An inbox with nothing in the view drops off the bar, unless its pill is
    // the open one: then it stays, saying 0, so the operator can see why the
    // list is empty and close it (2026-09-11).
    .filter((row) => row.tabs.length > 0 || row.mail > 0 || row.accountId === keep);
}

/** An inbox's own Unfiled under All inboxes, when something is unfiled or it is on. */
function inboxUnfiled(g: InboxTabs, selected: string | undefined): Tab[] {
  const value = unfiledInInbox(g.accountId);
  const count = g.counts[UNFILED_TAB] ?? 0;
  return count > 0 || selected === value ? [makeTab(value, "Unfiled", value, count, selected)] : [];
}

/**
 * The tab that leads the bar under All inboxes: everything, across every
 * inbox. Its count is taken over all of them at once rather than added up
 * from the rows, so it is the length of the list it opens even when an inbox
 * has no projects and therefore no row.
 */
export function allTab(total: number, selected: string | undefined): Tab {
  return makeTab(ALL_TAB, "All", null, total, selected);
}

/** How much of a project's name a closed pill can hold before it is cut short. */
/** What one inbox's pill on the project bar says, and how many tabs it hides. */
export interface InboxPill {
  label: string;
  /** How much of the view's mail the inbox holds. */
  count: number;
}

/**
 * The pill that opens one inbox's row of the project bar (operator,
 * 2026-09-10: the row-per-inbox header was "messy", so the rows fold behind
 * their inboxes). It carries the inbox's name and how much of the view's
 * mail that inbox holds, the same count the All tab is the total of
 * (operator, 2026-09-11: a pill saying 0 under Sent while the list showed
 * mail read as a bug). The label is the domain and nothing else, open or
 * shut, so the pill never changes width under the pointer.
 */
export function inboxPill(row: { label: string; mail: number }): InboxPill {
  return { label: row.label, count: row.mail };
}

/**
 * The two sides of the money axis, always both, in their places (spec 7).
 * A side that holds nothing under the project and window on screen is not
 * clickable: it would show an empty list, and offering that is how the money
 * row ends up looking like it decides the project. The side that is applied
 * stays clickable whatever its count, since clicking it is how it comes off.
 */
export function financeTabs(counts: { income: number; expense: number }, selected: string | undefined): Tab[] {
  return (["income", "expense"] as const).map((side) => {
    const on = selected === side;
    const empty = counts[side] === 0 && !on;
    const name = side === "income" ? "Income" : "Expense";
    return {
      key: side,
      name,
      label: `${name} · ${counts[side]}`,
      value: on ? null : side,
      on,
      dim: empty,
      disabled: empty,
    };
  });
}

/**
 * What the applied line calls the project that is on: the group and the
 * project under it, since a project's name alone does not say where it sits
 * (operator, 2026-09-15: labels should read "big project name › small project
 * name"). A project in no group is its own name, and "Unfiled" is itself.
 */
export function projectName(projects: ProjectLike[], selected: string, groups: GroupLike[] = []): string {
  if (selected === UNFILED_TAB) return "Unfiled";
  const group = groups.find((g) => groupTabKey(g.id) === selected);
  if (group) return group.name;
  const project = projects.find((p) => p.id === selected);
  if (!project) return "Unfiled";
  const parent = project.groupId ? groups.find((g) => g.id === project.groupId) : undefined;
  return parent ? `${parent.name} › ${project.name}` : project.name;
}
