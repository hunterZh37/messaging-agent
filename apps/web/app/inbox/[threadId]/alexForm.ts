import type { AlexItem } from "@messaging-agent/core";

/** `2026-09-18T17:00` in the browser's own zone, which is the operator's. */
export function localValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` or `date` value as the instant it names here, in ISO. */
export function iso(value: string): string {
  return new Date(value).toISOString();
}

export interface AlexForm {
  kind: AlexItem["kind"];
  title: string;
  /** An actionable's Day field, `YYYY-MM-DD`: the one place its date lives. */
  day: string;
  /** An actionable's clock, `HH:MM`, used only when `timed`. */
  time: string;
  /** An event's Starts field, `YYYY-MM-DDTHH:MM`; it carries its own date. */
  start: string;
  minutes: number;
  timed: boolean;
}

/**
 * The item the panel sends, or the reason it cannot. An actionable's date
 * comes from the Day field whether or not it has a clock: the panel used to
 * read a timed actionable's date from a separate date-time field that began
 * on today, so picking a day and then giving it a time landed it on today
 * (operator, 2026-10-06).
 */
export function buildAlexItem(f: AlexForm): AlexItem | string {
  const text = f.title.trim();
  if (!text) return "Give it a title.";
  // A cleared date or time field would make an Invalid Date, and toISOString
  // on that throws instead of showing a reason.
  if (f.kind === "event") {
    if (!f.start) return "Give it a start.";
    const from = new Date(f.start);
    const to = new Date(from.getTime() + f.minutes * 60_000);
    return { kind: "event", title: text, startISO: from.toISOString(), endISO: to.toISOString() };
  }
  // An actionable is the day it belongs to, and only carries a clock when asked.
  if (!f.day) return "Give it a day.";
  if (f.timed && !f.time) return "Give it a time.";
  if (!f.timed) return { kind: "actionable", title: text, dayISO: iso(`${f.day}T12:00`) };
  const from = new Date(`${f.day}T${f.time}`);
  const to = new Date(from.getTime() + f.minutes * 60_000);
  return { kind: "actionable", title: text, dayISO: from.toISOString(), startISO: from.toISOString(), endISO: to.toISOString() };
}
