"use client";

import { type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "../Dialog";

/**
 * The header's editors, as a dialog over the page rather than a panel wedged
 * into it (spec 10a). Opening one used to push the list down and take the
 * header's height with it; a dialog moves nothing. Which editor is open is
 * still a URL param, so a link still opens it, and closing clears the param.
 *
 * The scrim, the focus and Escape are `Dialog`'s; what this adds is that
 * closing is a navigation.
 */
export function EditorDialog({
  title,
  labelledBy,
  closeHref,
  returnFocusTo,
  children,
}: {
  title: string;
  /** The id of the heading this dialog is named by. */
  labelledBy: string;
  /** Where closing goes: this view without `?edit=`. */
  closeHref: string;
  /** The id of the control that opened it, to hand focus back to. */
  returnFocusTo: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <Dialog title={title} labelledBy={labelledBy} onClose={() => router.push(closeHref)} returnFocusTo={returnFocusTo}>
      {children}
    </Dialog>
  );
}
