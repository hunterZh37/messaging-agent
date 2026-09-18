"use client";

import { useEffect, useState } from "react";

/**
 * "New" on a row that arrived since the operator last looked at this list
 * (operator, 2026-09-11). What "last looked" means lives in the browser:
 * ListSeen keeps, per list, the moment the previous visit ended, and the
 * threads opened since. A row is new when it was stored after that moment
 * and has not been opened. Nothing shows on the first visit ever, or on the
 * server: the badge is decided after mount, from local storage alone.
 */
export const SEEN_KEY = (listKey: string) => `celeste-seen:${listKey}`;
export const OPENED_KEY = "celeste-opened-threads";

export function readSeen(listKey: string): number | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY(listKey));
    const v = raw ? JSON.parse(raw) : null;
    return typeof v?.since === "number" ? v.since : null;
  } catch {
    return null;
  }
}

export function openedThreads(): Set<string> {
  try {
    const raw = localStorage.getItem(OPENED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function noteOpened(threadId: string): void {
  try {
    const set = openedThreads();
    set.add(threadId);
    // Bounded: the last few hundred opened threads are all the badge needs.
    localStorage.setItem(OPENED_KEY, JSON.stringify([...set].slice(-400)));
  } catch {
    /* no storage, no badge */
  }
}

export function NewBadge({ listKey, threadId, receivedAt, selected }: { listKey: string; threadId: string; receivedAt: number; selected: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (selected) {
      noteOpened(threadId);
      setShow(false);
      return;
    }
    const since = readSeen(listKey);
    setShow(since !== null && receivedAt > since && !openedThreads().has(threadId));
  }, [listKey, threadId, receivedAt, selected]);
  if (!show) return null;
  return <span className="tag new">New</span>;
}
