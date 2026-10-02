"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { hasProjectBar } from "@/lib/folders";
import { SyncButton } from "./sync";

/**
 * The thin bar above the pages that have no bar of their own: the approval
 * queue, the Inboxes page, the connect flow. It holds the refresh control
 * for them, and the needs-sign-in banner above the queue itself, since the
 * Inboxes page already lists each account's status per row. The folder pages
 * and a thread put the refresh control in their project bar instead (spec
 * 10d), so nothing here renders over them.
 */
export function TopBar(props: { accountCount: number; needsSignin: string[] }) {
  const pathname = usePathname();
  // Once there is an inbox, every folder page and thread shows a project bar,
  // and that bar is where the refresh control lives.
  const ownsButton = !(props.accountCount > 0 && hasProjectBar(pathname));
  // On every page, not on Drafts alone: two of the operator's inboxes sat
  // locked out for two and a half days and the only word of it was here, on a
  // page they had no reason to open (operator, 2026-10-01: "right now they're
  // hard to notice and I was wondering why I had not received any emails from
  // these two inboxes").
  const banners = props.needsSignin;
  if (!ownsButton && banners.length === 0) return null;

  return (
    <div className="topbar">
      {ownsButton ? (
        <div className="topbar-row">
          <SyncButton />
        </div>
      ) : null}
      {banners.map((email) => (
        <div key={email} className="error topbar-banner">
          {email} needs sign-in. <Link href="/inboxes">Reconnect</Link>
        </div>
      ))}
    </div>
  );
}
