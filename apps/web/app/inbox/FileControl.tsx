"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProjectRow } from "@messaging-agent/core";
import { fileThreadAction } from "./actions";
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
export function FileControl({ threadId, subject, projects, currentId, unfiledLabel, onOpenChange }: {
  threadId: string;
  subject: string;
  /** The projects of this row's own inbox, which is the only place it can be filed. */
  projects: ProjectRow[];
  currentId: string | null;
  /** Core's reserved name for no project, passed in so this stays free of server-only imports. */
  unfiledLabel: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
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
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: Event) => {
      if (wrap.current?.contains(e.target as HTMLElement | null)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  function file(projectId: string | null) {
    setOpen(false);
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

  const rows = [...projects.map((p) => ({ id: p.id as string | null, name: p.name })), { id: null, name: unfiledLabel }];
  return (
    <div className="inbox-row-keep" ref={wrap}>
      <button
        type="button"
        className="keep-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`File the thread ${subject || "(no subject)"}`}
        title={error ?? "File this under a project"}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{pending ? "Filing…" : error ? "Not filed" : "File"}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <div className="keep-menu projects" role="menu" aria-label="File this under">
          {rows.map((p) => (
            <button
              key={p.id ?? "unfiled"}
              type="button"
              role="menuitemradio"
              aria-checked={currentId === p.id}
              className={currentId === p.id ? "keep-row on" : "keep-row"}
              onClick={() => file(p.id)}
            >
              <span className="picker-name">
                {p.name}
                {currentId === p.id ? <span className="keep-now"> · where it is now</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
