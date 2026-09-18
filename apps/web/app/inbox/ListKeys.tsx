"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { listStep, nextThreadRow } from "@/lib/keys";

/**
 * j and k, or the arrows, walk the list beside the thread (stress audit,
 * 2026-09-11): the rows on screen are the order, the selected one is where
 * the operator is, and with nothing selected the first row is next. Reads
 * the rendered links rather than a copy of the list, so what moves is
 * exactly what is on screen, older rows included.
 */
export function ListKeys() {
  const router = useRouter();
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const step = listStep(ev);
      if (step === 0) return;
      const rows = Array.from(document.querySelectorAll<HTMLAnchorElement>(".inbox-rows a.inbox-row[data-thread-id]")).map((el) => ({
        el,
        threadId: el.getAttribute("data-thread-id") ?? "",
        selected: el.classList.contains("selected"),
      }));
      const next = nextThreadRow(rows, step)?.el;
      if (!next) return;
      ev.preventDefault();
      next.scrollIntoView({ block: "nearest" });
      router.push(next.getAttribute("href") ?? next.href, { scroll: false });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}
