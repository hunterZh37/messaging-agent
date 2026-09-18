/** Inbox label shown on chips and meta lines: the domain after the @ (operator decision 2026-09-07). */
export function shortAccount(email: string): string {
  // Messages on this Mac (2026-09-11) is named, not addressed.
  if (email.startsWith("messages:")) return "Messages";
  if (email.startsWith("whatsapp:")) return "WhatsApp";
  const at = email.indexOf("@");
  return at >= 0 ? email.slice(at + 1) : email;
}

/**
 * Which glyph sits before the account name on a row, a card and a thread
 * header (operator, 2026-09-11): a text says which app it came from, an
 * Apple mark for Messages and the WhatsApp mark for WhatsApp; mail keeps
 * the envelope whichever provider carried it.
 */
export type ChannelGlyph = "apple" | "whatsapp" | "mail";

export function channelGlyph(provider: string): ChannelGlyph {
  if (provider === "imessage") return "apple";
  if (provider === "whatsapp") return "whatsapp";
  return "mail";
}

/**
 * "10:34 AM" today, "Sep 9, 4:41 PM" earlier this year, "Sep 9, 2025"
 * before that. The full locale string with seconds it used to fall back to
 * read as a log line (desktop audit, 2026-09-11).
 */
export function formatTime(ts: number, now: Date = new Date()): string {
  const d = new Date(ts);
  const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (isToday) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/** Up to two letters for an avatar: first letters of the first two words of the name, else the address's first letter. */
export function initials(name: string, address: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length >= 2) return (firstChar(words[0]!) + firstChar(words[1]!)).toUpperCase();
  if (words.length === 1 && name !== address) return firstChar(words[0]!).toUpperCase();
  return firstChar(address).toUpperCase() || "?";
}

function firstChar(s: string): string {
  const m = s.match(/[\p{L}\p{N}]/u);
  return m ? m[0] : "";
}

/** "a@x.com, b@y.com" or "a@x.com, b@y.com +3" — the first two recipients (To then Cc), the rest counted. */
export function recipientsLine(to: string[], cc: string[]): string {
  const all = [...new Set([...to, ...cc])];
  if (all.length === 0) return "(no recipients)";
  const shown = all.slice(0, 2).join(", ");
  return all.length > 2 ? `${shown} +${all.length - 2}` : shown;
}

/** "just now", "4 min ago", "2 h ago", or the date for anything older than a day. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * The addresses in a To or Cc field that cannot be sent to: one @ with
 * something on both sides and no whitespace, the same test the sender
 * applies (packages/core/src/connectors/mime.ts). Caught on the card, so a
 * typo is said before the six seconds start rather than after them (stress
 * audit, 2026-09-11: "nope" went through the preview and failed at send).
 */
export function invalidAddresses(list: string[]): string[] {
  return list.filter((a) => {
    const at = a.indexOf("@");
    return at <= 0 || at !== a.lastIndexOf("@") || at === a.length - 1 || /\s/.test(a);
  });
}

/**
 * Why a draft cannot go out yet, or undefined when it can (stress audit,
 * 2026-09-11): nothing goes to nobody, to an address that cannot be one, or
 * with nothing in it. Worded for the card, in the order the operator would
 * fix them.
 */
export function sendBlockFor(text: string, to: string[], cc: string[], channel: "mail" | "text" = "mail"): string | undefined {
  // A text goes to a handle Messages already knows, a number or an Apple ID
  // the card does not let the operator change, so only mail is checked for
  // the shape of an address (first send, 2026-09-11: the gate held a text).
  const bad = channel === "text" ? [] : invalidAddresses([...to, ...cc]);
  if (to.length === 0) return "Needs someone in To.";
  if (bad.length > 0) return `Not an address: ${bad.join(", ")}`;
  if (text.trim() === "") return "The reply is empty.";
  return undefined;
}

/** A stored snippet, minus the invisible preheader padding senders hide in it (stress loop, 2026-09-11). */
export function cleanSnippet(text: string | null | undefined): string {
  return (text ?? "").replace(/[\u034F\u00AD\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}
