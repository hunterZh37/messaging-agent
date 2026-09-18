"use client";

import { useEffect } from "react";

/**
 * Keeps the theme on the root element after the page has settled. The inline
 * script in layout.tsx stamps it before the first paint, but a render that
 * rebuilds the root (Next's not-found and error pages do) came up without it
 * and painted the night palette over a day setting (stress audit,
 * 2026-09-11). This reads the same stored choice and puts it back.
 */
export function ThemeGuard() {
  useEffect(() => {
    try {
      const stored = localStorage.getItem("celeste-theme");
      const theme = stored === "day" || stored === "night" ? stored : window.matchMedia("(prefers-color-scheme: light)").matches ? "day" : "night";
      if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
    } catch {
      /* storage may be unavailable; the script's choice stands */
    }
  }, []);
  return null;
}
