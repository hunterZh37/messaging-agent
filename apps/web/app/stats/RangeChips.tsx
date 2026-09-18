"use client";

import { useRouter } from "next/navigation";
import { useTransition, useState } from "react";

/**
 * The range chips. Plain links left the page looking dead for as long as the
 * server took to answer, which reads as a click that did not land rather than
 * as one that is working (operator, 2026-09-17: cannot click on this year,
 * not snappy).
 *
 * The chip takes its selected look the moment it is pressed and the page
 * dims while the new numbers are on their way, so the click is always
 * answered at once even when the answer takes a second.
 */
export function RangeChips({ ranges, active }: { ranges: { key: string; label: string }[]; active: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [wanted, setWanted] = useState<string | null>(null);

  // While a click is in flight the pressed chip leads; afterwards the URL is
  // the truth again, so a Back press does not leave the wrong chip lit.
  const shown = pending && wanted ? wanted : active;

  return (
    <div className={`chips${pending ? " chips-busy" : ""}`} aria-busy={pending}>
      {ranges.map((r) => (
        <button
          key={r.key}
          type="button"
          className={`chip${r.key === shown ? " on" : ""}`}
          aria-pressed={r.key === shown}
          onClick={() => {
            if (r.key === active) return;
            setWanted(r.key);
            startTransition(() => router.push(`/stats?range=${r.key}`));
          }}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
