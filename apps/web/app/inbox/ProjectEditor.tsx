"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { proposeProjectsAction, refileProjectsAction, saveProjectsWithGroupsAction } from "./actions";
import { EditorRows } from "./EditorRows";

export interface EditorProject {
  id?: string;
  name: string;
  description: string;
  /** The group it sits in, by the editor's key for that group; null for none (2026-09-15). */
  groupKey?: string | null;
}

/** A group in the editor: `key` is how projects name it before it has an id. */
export interface EditorGroup {
  id?: string;
  key: string;
  name: string;
}

let newGroupSeq = 0;

/**
 * The project editor, opened below the inbox chip rows by the Edit chip on
 * the project row (`?edit=1` with one inbox selected). One Save writes the
 * whole ordered list for that inbox, the same single decision the
 * sub-category editor makes.
 */
export function ProjectEditor({
  accountId,
  projects,
  groups: initialGroups = [],
  closeHref,
  windowStart,
}: {
  accountId: string;
  projects: EditorProject[];
  groups?: EditorGroup[];
  closeHref: string;
  /** The window "Re-file this inbox" covers, in epoch ms; null for all of it. */
  windowStart: number | null;
}) {
  const [rows, setRows] = useState<EditorProject[]>(projects);
  const [groups, setGroups] = useState<EditorGroup[]>(initialGroups);
  const [error, setError] = useState<string | null>(null);
  const [refiled, setRefiled] = useState<string | null>(null);
  const [proposed, setProposed] = useState<number | null>(null);
  /** The first appended row, until the editor has scrolled it into view. */
  const [scrollTo, setScrollTo] = useState<number | null>(null);
  const [saving, startSaving] = useTransition();
  const [refiling, startRefiling] = useTransition();
  const [proposing, startProposing] = useTransition();
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  /** An inbox that had none until this editor saved some: Re-file is what fills them. */
  const [filled, setFilled] = useState(false);
  const empty = projects.length === 0;

  const close = useCallback(() => {
    router.push(closeHref);
  }, [router, closeHref]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // The proposals land below the fold of a long list, so the editor goes to
  // the first of them once React has put the rows on the page.
  useEffect(() => {
    if (scrollTo === null) return;
    panel.current?.querySelectorAll(".cat-row")[scrollTo]?.scrollIntoView({ block: "nearest" });
    setScrollTo(null);
  }, [scrollTo]);

  function update(i: number, patch: Partial<EditorProject>) {
    setRows(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  }

  function onSave() {
    setError(null);
    startSaving(async () => {
      const r = await saveProjectsWithGroupsAction(accountId, rows, groups);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      // An inbox that just got its first projects has nothing filed under
      // them yet, so the editor stays open to say what fills them. The rows
      // take the ids they were saved under, so a second Save edits those
      // projects instead of replacing them.
      if (empty && r.saved.length > 0) {
        setRows(r.saved);
        setGroups(r.groups);
        setProposed(null);
        setFilled(true);
        router.refresh();
        return;
      }
      close();
    });
  }

  /**
   * "Propose projects": Sonnet reads this inbox's mail and answers with the
   * projects it is about. They arrive as ordinary unsaved rows, appended
   * below whatever is already there, and Save is what writes them.
   */
  function onPropose() {
    setError(null);
    setProposed(null);
    startProposing(async () => {
      const r = await proposeProjectsAction(accountId);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      if (r.proposals.length === 0) {
        setError("No mail stored for this inbox yet, so there is nothing to propose from.");
        return;
      }
      setScrollTo(rows.length);
      setRows([...rows, ...r.proposals]);
      setProposed(r.proposals.length);
    });
  }

  function onRefile() {
    setError(null);
    setRefiled(null);
    startRefiling(async () => {
      const r = await refileProjectsAction(accountId, windowStart);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setRefiled(`${r.resorted} re-filed`);
      router.refresh();
    });
  }

  return (
    <div className="cat-editor" ref={panel}>
      <div className="meta">
        <span>
          {empty
            ? "No projects yet. Propose some from the mail, or add your own."
            : "Celeste files mail under the project it belongs to when she sorts it. Re-file runs the sorter over this window."}
        </span>
      </div>

      {/* Groups hold projects without re-filing anything (operator, 2026-09-15). */}
      <div className="group-editor">
        <div className="group-editor-head">
          <span className="group-editor-title">Groups</span>
          <span className="meta">Picking a group shows every project in it. Nothing is re-filed.</span>
        </div>
        {groups.map((g, i) => (
          <div className="group-editor-row" key={g.key}>
            <input
              className="field"
              maxLength={40}
              value={g.name}
              placeholder="Group name"
              aria-label="Group name"
              onChange={(e) => setGroups(groups.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
            />
            <span className="meta">{`${rows.filter((r) => r.groupKey === g.key).length} projects`}</span>
            <button
              type="button"
              className="btn quiet icon-only"
              aria-label={`Remove the group ${g.name || ""}`}
              onClick={() => {
                setGroups(groups.filter((_, j) => j !== i));
                setRows(rows.map((r) => (r.groupKey === g.key ? { ...r, groupKey: null } : r)));
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        ))}
        <button type="button" className="btn quiet" onClick={() => setGroups([...groups, { key: `new-${++newGroupSeq}`, name: "" }])}>
          Add group
        </button>
      </div>

      <EditorRows
        rows={rows}
        onChange={setRows}
        noun="project"
        namePlaceholder="Name"
        descriptionPlaceholder="What kind of mail belongs to this project?"
        nameMaxLength={40}
        extra={
          groups.length > 0
            ? (row, change) => (
                <select
                  className="field group-select"
                  aria-label={`Group for ${row.name || "project"}`}
                  value={row.groupKey ?? ""}
                  onChange={(e) => change({ groupKey: e.target.value || null })}
                >
                  <option value="">No group</option>
                  {groups.map((g) => (
                    <option key={g.key} value={g.key}>
                      {g.name || "Unnamed group"}
                    </option>
                  ))}
                </select>
              )
            : undefined
        }
      />

      {error ? <div className="error">{error}</div> : null}

      <div className="row">
        <button type="button" className="btn quiet" onClick={onPropose} disabled={proposing}>
          {proposing ? "Proposing…" : "Propose projects"}
        </button>
        <button type="button" className="btn quiet" onClick={() => setRows([...rows, { name: "", description: "" }])}>
          Add project
        </button>
        <button type="button" className="btn primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {proposed !== null ? <span className="meta">{`${proposed} proposed — edit, then Save`}</span> : null}
      </div>

      <div className="row">
        <button type="button" className="btn quiet" onClick={onRefile} disabled={refiling}>
          {refiling ? "Re-filing…" : "Re-file this inbox"}
        </button>
        {refiled ? <span className="meta">{refiled}</span> : filled ? <span className="meta">Re-file to sort mail into them</span> : null}
      </div>
    </div>
  );
}
