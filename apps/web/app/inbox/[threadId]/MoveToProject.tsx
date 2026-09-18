"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProjectRow } from "@messaging-agent/core";
import { createProjectAction, fileThreadAction } from "../actions";

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

/**
 * "Move to project…" on a thread: the operator's own filing, which outranks
 * the automatic pass and teaches it (spec 10d). Every message in the thread
 * moves together, because a thread is about one thing.
 */
export function MoveToProject({
  threadId,
  accountId,
  projects,
  currentId,
  unfiledLabel,
}: {
  threadId: string;
  accountId: string;
  projects: ProjectRow[];
  currentId: string | null;
  /** Core's reserved name for no project, passed in so this stays free of server-only imports. */
  unfiledLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setNaming(false);
    setName("");
    setError(null);
  }

  function file(projectId: string | null) {
    setError(null);
    startTransition(async () => {
      const r = await fileThreadAction(threadId, projectId);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      close();
      router.refresh();
    });
  }

  function create() {
    setError(null);
    startTransition(async () => {
      const r = await createProjectAction(accountId, name, threadId);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      close();
      router.refresh();
    });
  }

  return (
    <div className="move-project" ref={wrap}>
      <button
        type="button"
        className="btn quiet"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pending}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span>{pending ? "Filing…" : "Move to project…"}</span>
        <ChevronIcon />
      </button>

      {open ? (
        <div className="switcher-panel" role="menu" aria-label="Move to project">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              className="switcher-row"
              role="menuitemradio"
              aria-checked={currentId === p.id}
              onClick={() => file(p.id)}
            >
              <span className="switcher-text">
                <span className="switcher-label">{p.name}</span>
              </span>
              {currentId === p.id ? <CheckIcon /> : null}
            </button>
          ))}
          <button
            type="button"
            className="switcher-row"
            role="menuitemradio"
            aria-checked={currentId === null}
            onClick={() => file(null)}
          >
            <span className="switcher-text">
              <span className="switcher-label">{unfiledLabel}</span>
            </span>
            {currentId === null ? <CheckIcon /> : null}
          </button>

          <div className="switcher-hairline" />

          {naming ? (
            <div className="switcher-new">
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
            <button type="button" className="switcher-row add" role="menuitem" onClick={() => setNaming(true)}>
              <span className="switcher-text">
                <span className="switcher-label">New project…</span>
              </span>
            </button>
          )}

          {error ? <div className="error">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
