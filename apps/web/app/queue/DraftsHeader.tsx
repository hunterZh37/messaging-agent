import type { ReactNode } from "react";
import { SyncButton } from "./sync";

/**
 * The header over the Drafts page: the folder pages' first row exactly — the
 * title, then what is being looked at, then refresh at the far right (spec
 * 10a; operator, 2026-09-15: "make the drafts page consistent with this new
 * header design") — and nothing else, since a queue is not a filtered view
 * and there is nothing here to narrow it by. The count is the length of the
 * list beneath, which is also the number beside "Drafts" in the tree, and it
 * moves the moment a draft is skipped or sent rather than waiting for the
 * server to say so.
 */
export function DraftsHeader(props: { count: number; switcher?: ReactNode }) {
  return (
    <header className="content-head">
      <div className="head-row first only">
        <span className="head-title">Drafts</span>
        <span className="head-sub">{props.count === 0 ? "Nothing waiting" : `${props.count} waiting`}</span>
        {props.switcher ? <div className="head-filters">{props.switcher}</div> : null}
        <span className="head-spacer" />
        <SyncButton />
      </div>
    </header>
  );
}
