"use client";

import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";
import { openedHere, stillUnread } from "@/lib/openedHere";

/**
 * A list row's link, which knows whether its thread was opened in this tab
 * since the page was read (2026-09-15), so the unopened dot goes the moment
 * the operator comes back from the thread rather than on the next page read.
 */
export function RowLink(props: { href: string; threadId: string; unread: boolean; receivedAt: number; selected: boolean; children: ReactNode }) {
  useSyncExternalStore(openedHere.subscribe, openedHere.version, () => 0);
  const unread = !props.selected && stillUnread(props.unread, props.receivedAt, openedHere.at(props.threadId));
  return (
    <Link
      href={props.href}
      // The panes scroll on their own; the page has nothing to scroll to.
      scroll={false}
      data-thread-id={props.threadId}
      // The open thread reads as read the moment it is on screen, without
      // waiting for the server to say so (operator, 2026-09-11).
      className={`inbox-row${unread ? " unread" : ""}${props.selected ? " selected" : ""}`}
    >
      {props.children}
    </Link>
  );
}
