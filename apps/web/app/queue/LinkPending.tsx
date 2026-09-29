"use client";

import { useEffect } from "react";
import { useLinkStatus } from "next/link";
import { navPending } from "@/lib/navPending";

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
 *
 * It also counts itself into `navPending` while it waits, which is what puts
 * the glass over the page when a wait runs long (operator, 2026-09-29). The
 * count comes back off in the effect's own cleanup, so a row that leaves the
 * screen mid-flight — which is most of them, since the page it asked for
 * replaces it — takes its share of the waiting with it.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  useEffect(() => {
    if (!pending) return;
    return navPending.start();
  }, [pending]);
  return pending ? <span className="link-pending" aria-hidden="true" /> : null;
}
