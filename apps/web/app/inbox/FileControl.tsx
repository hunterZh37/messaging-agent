"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProjectRow } from "@messaging-agent/core";
import { createProjectAction, fileThreadAction } from "./actions";
import { ChevronIcon } from "./icons";

/**
 * "File" on a row (operator, 2026-09-20: "for some email card I want to be
 * able to categorize them in different projects"), beside Move and reading
 * the same way: the project it is under now is marked rather than hidden, so
 * the menu says where the mail is filed as well as offering to refile it.
 *
 * A filing by hand is recorded as the operator's, which outranks the
 * automatic pass and is read back by it as an example, so correcting one
 * message teaches the filing of the next.
 *
 * The row stays where it is. Filing says what a message is about, not whether
 * it is dealt with, which is Move's question.
 */
export function FileControl({ threadId, subject, accountId, projects, groups, currentId, unfiledLabel, onOpenChange }: {
  threadId: string;
  subject: string;
  /** Whose inbox this row belongs to; a new project is made in that inbox. */
  accountId: string;
  /** The projects of this row's own inbox, which is the only place it can be filed. */
  projects: ProjectRow[];
  /** The bigger projects, in the order the operator put them in. */
  groups?: { id: string; name: string }[];
  currentId: string | null;
  /** Core's reserved name for no project, passed in so this stays free of server-only imports. */
  unfiledLabel: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  // Which bigger project is open. The menu shows those first and the
  // smaller ones inside the one the operator picks.
  const [inGroup, setInGroup] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: Event) => {
      if (wrap.current?.contains(e.target as HTMLElement | null)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setInGroup(null);
    setNaming(false);
    setName("");
  }

  function file(projectId: string | null) {
    close();
    setError(null);
    startTransition(async () => {
      const r = await fileThreadAction(threadId, projectId);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  /**
   * A project the operator thinks of while looking at the mail that needs it.
   * Made in this row's own inbox, inside the bigger project open at the time,
   * and the thread filed into it in one go, so naming it is the whole of the
   * work.
   */
  function create() {
    const named = name.trim();
    if (!named) return;
    setError(null);
    startTransition(async () => {
      const r = await createProjectAction(accountId, named, threadId, openGroup?.id ?? null);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      close();
      router.refresh();
    });
  }

  const byGroup = (id: string) => projects.filter((p) => p.groupId === id);
  const known = new Set((groups ?? []).map((g) => g.id));
  // A project nobody has grouped has no bigger project to sit inside, so it
  // stands among them rather than being unreachable behind one.
  const loose = projects.filter((p) => !p.groupId || !known.has(p.groupId));
  const openGroup = (groups ?? []).find((g) => g.id === inGroup) ?? null;
  const here = projects.find((p) => p.id === currentId) ?? null;

  const inside = openGroup
    ? byGroup(openGroup.id).map((p) => ({ kind: "project" as const, id: p.id as string | null, name: p.name, note: null as string | null }))
    : [
        ...(groups ?? [])
          .filter((g) => byGroup(g.id).length > 0)
          .map((g) => ({
            kind: "group" as const,
            id: g.id,
            name: g.name,
            note: `${byGroup(g.id).length} inside`,
          })),
        ...loose.map((p) => ({ kind: "project" as const, id: p.id as string | null, name: p.name, note: null as string | null })),
        { kind: "project" as const, id: null, name: unfiledLabel, note: null as string | null },
      ];

  const marked = (row: { kind: "group" | "project"; id: string | null }) =>
    row.kind === "project" ? currentId === row.id : here?.groupId === row.id;

  return (
    <div className="inbox-row-keep" ref={wrap}>
      <button
        type="button"
        className="keep-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`File the thread ${subject || "(no subject)"}`}
        title={error ?? "File this under a project"}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span>{pending ? "Filing…" : error ? "Not filed" : "File"}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <div className="keep-menu projects" role="menu" aria-label="File this under">
          {/* The list scrolls; what is under it does not scroll away with it. */}
          <div className="keep-scroll">
            {openGroup ? (
              <button type="button" className="keep-row back" role="menuitem" onClick={() => setInGroup(null)}>
                <span className="picker-name">
                  <span className="keep-back" aria-hidden="true">‹</span> {openGroup.name}
                </span>
              </button>
            ) : null}
            {inside.map((row) => (
              <button
                key={`${row.kind}:${row.id ?? "unfiled"}`}
                type="button"
                role={row.kind === "group" ? "menuitem" : "menuitemradio"}
                {...(row.kind === "group" ? { "aria-haspopup": "menu" as const } : { "aria-checked": marked(row) })}
                className={marked(row) ? "keep-row on" : "keep-row"}
                onClick={() => (row.kind === "group" ? setInGroup(row.id) : file(row.id))}
              >
                <span className="picker-name">
                  {row.name}
                  {marked(row) ? <span className="keep-now">{row.kind === "group" ? " · in here" : " · where it is now"}</span> : null}
                  {row.kind === "group" ? <span className="keep-into" aria-hidden="true">›</span> : null}
                </span>
                {row.note ? <span className="picker-desc">{row.note}</span> : null}
              </button>
            ))}
          </div>
          <div className="keep-hairline" />
          {naming ? (
            <div className="keep-new">
              <input
                className="field"
                autoFocus
                maxLength={40}
                value={name}
                placeholder="Project name"
                aria-label="New project name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                }}
              />
              <button type="button" className="btn primary" onClick={create} disabled={pending || !name.trim()}>
                Create
              </button>
            </div>
          ) : (
            <button type="button" className="keep-row add" role="menuitem" onClick={() => setNaming(true)}>
              <span className="picker-name">
                <span className="keep-plus" aria-hidden="true">+</span> New project{openGroup ? ` in ${openGroup.name}` : ""}
              </span>
            </button>
          )}
          {error ? <div className="keep-error">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
