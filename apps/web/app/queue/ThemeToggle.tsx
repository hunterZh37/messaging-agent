"use client";

import { useEffect, useState } from "react";

type Theme = "day" | "night";

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

/**
 * Flips `document.documentElement.dataset.theme` between "day" and "night"
 * and persists the choice to localStorage under "celeste-theme". The initial
 * value is set synchronously by an inline script in the root layout so there
 * is no flash of the wrong theme; this component just reads it back on mount.
 * `withLabel` adds the name of the theme the click switches to, for the
 * labelled sidebar (spec 10a).
 */
export function ThemeToggle(props: { className?: string; withLabel?: boolean }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === "day" ? "day" : "night");
  }, []);

  function toggle() {
    const next: Theme = theme === "day" ? "night" : "day";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("celeste-theme", next);
    } catch {
      // localStorage unavailable (private mode, etc.) — theme still applies for this load.
    }
    setTheme(next);
  }

  const isDay = theme === "day";
  return (
    <button type="button" className={props.className} onClick={toggle} aria-label={isDay ? "Switch to night" : "Switch to day"}>
      {isDay ? <MoonIcon /> : <SunIcon />}
      {props.withLabel ? <span className="tree-label">{isDay ? "Night" : "Day"}</span> : null}
    </button>
  );
}
