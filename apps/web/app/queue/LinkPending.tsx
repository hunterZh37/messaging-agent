"use client";

import { useLinkStatus } from "next/link";

/**
 * A row says it heard the click (operator, 2026-09-20: "why all chat tab not
 * openable?").
 *
 * It was openable. Reading a folder takes between a third and half a second
 * on this mailbox, and in that time nothing anywhere moved: the row the
 * operator pressed did not light, the old list stayed, and the only honest
 * reading of that is that the click missed. They pressed again, and the
 * second press raced the first.
 *
 * Rendered inside the Link itself, so it knows about that Link's own
 * navigation rather than about the router in general: pressing Archive does
 * not set every row spinning.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return pending ? <span className="link-pending" aria-hidden="true" /> : null;
}
