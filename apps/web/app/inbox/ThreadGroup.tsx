"use client";

import { useState, type ReactNode } from "react";

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={open ? "open" : undefined}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/**
 * One thread in the list: the newest message, then the rest folded under it
 * (spec 10a). Collapsed, a thread takes one line and says how many more it
 * holds, so a long exchange does not read as a run of separate mail sharing a
 * subject. The group whose thread is open beside the list starts expanded,
 * because that is the conversation being read.
 */
export function ThreadGroup(props: { latest: ReactNode; older: ReactNode[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const count = props.older.length;

  return (
    <div className="thread-group">
      {props.latest}
      {count > 0 ? (
        <>
          <button type="button" className="thread-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <ChevronIcon open={open} />
            <span>{open ? "Hide earlier" : count === 1 ? "1 earlier message" : `${count} earlier messages`}</span>
          </button>
          {open ? <div className="thread-older">{props.older}</div> : null}
        </>
      ) : null}
    </div>
  );
}
