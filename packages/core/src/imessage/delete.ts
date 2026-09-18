import type { AppleScriptRunner } from "./types";
import { appleScriptString } from "./send";
import { returningToFront } from "./front";

/** The handle a one-to-one chat's guid names: the part after ";-;". */
export function handleOfChat(chatGuid: string): string {
  const at = chatGuid.indexOf(";-;");
  return at < 0 ? chatGuid : chatGuid.slice(at + 3);
}

/**
 * The script that deletes one conversation in Messages.app (operator,
 * 2026-09-11: "the messages on the phone are still there"). Messages has
 * no AppleScript command for it, so this drives the app: bring it up, open
 * the chat by its imessage: URL, choose Delete Conversation… from the
 * Conversation menu, and press Delete on the sheet that asks "Delete from
 * all your devices?" (its buttons carry their words as titles; their
 * descriptions only say "button", 2026-09-11). The conversation goes to
 * Messages' Recently Deleted
 * for thirty days and, with Messages in iCloud on, leaves the phone too.
 *
 * Everything happens in one script: Messages may live on another Space,
 * where System Events cannot see its window between scripts. The first run
 * makes macOS ask, once, whether the app may control the computer
 * (Accessibility), on top of controlling Messages.
 */
/** Waits for Messages' window, up to about ten seconds: after a delete the app is busy for a moment (2026-09-11: "no window"). */
const WAIT_FOR_WINDOW = [
  `  set tries to 0`,
  `  repeat while (count of windows) = 0 and tries < 20`,
  `    delay 0.5`,
  `    set tries to tries + 1`,
  `  end repeat`,
  `  if (count of windows) = 0 then return "no window"`,
];

/** Opens the chat and says what Messages titled its window, so the delete that follows is checked against the chat it is meant for. */
export function openConversationScript(handle: string): string {
  const url = appleScriptString(`imessage://${handle}`);
  return returningToFront([
    `tell application "Messages" to activate`,
    `delay 0.8`,
    `tell application "Messages" to open location ${url}`,
    `delay 1.5`,
    `tell application "System Events" to tell process "Messages"`,
    ...WAIT_FOR_WINDOW,
    `  return "title:" & (title of window 1)`,
    `end tell`,
  ]);
}

export function deleteConversationScript(handle: string): string {
  const url = appleScriptString(`imessage://${handle}`);
  return returningToFront([
    `tell application "Messages" to activate`,
    `delay 0.8`,
    `tell application "Messages" to open location ${url}`,
    `delay 1.5`,
    `tell application "System Events" to tell process "Messages"`,
    ...WAIT_FOR_WINDOW,
    `  set theItem to menu item "Delete Conversation…" of menu "Conversation" of menu bar 1`,
    // The item enables a moment after the chat opens (2026-09-12: read too
    // soon, it said "nothing to delete" of a chat with texts in it).
    `  set waits to 0`,
    `  repeat while not (enabled of theItem) and waits < 8`,
    `    delay 0.5`,
    `    set waits to waits + 1`,
    `  end repeat`,
    `  if not (enabled of theItem) then return "nothing to delete"`,
    `  click theItem`,
    // The confirmation takes a moment, and can come up as a sheet on the
    // window or as a dialog of its own; for that moment Messages on another
    // Space may show no window at all (2026-09-14: "Can't get window 1", and
    // the chat was reported kept). So look for Delete in every window, sheet
    // and dialog, for up to five seconds, and never index a window blindly.
    `  set seenWindow to false`,
    `  set looks to 0`,
    `  repeat while looks < 10`,
    `    delay 0.5`,
    `    set looks to looks + 1`,
    `    try`,
    `      repeat with w in windows`,
    `        set seenWindow to true`,
    `        set places to (sheets of w) as list`,
    `        set end of places to w`,
    `        repeat with p in places`,
    `          repeat with b in buttons of p`,
    `            if (title of b as text) is "Delete" then`,
    `              click b`,
    `              return "deleted"`,
    `            end if`,
    `          end repeat`,
    `        end repeat`,
    `      end repeat`,
    `    end try`,
    `  end repeat`,
    `  if not seenWindow then return "window gone"`,
    `  key code 53`,
    `  return "no sheet"`,
    `end tell`,
  ]);
}

/** What the script says when the conversation is gone, or was never there. */
const DONE = new Set(["deleted", "no sheet", "nothing to delete"]);

/**
 * Whether Messages' window title names this chat: a number however Messages
 * punctuates it ("+1 (415) 555-0144" for +14155550144), or a name or
 * handle as written, case aside.
 */
export function titleNamesChat(title: string, names: string[]): boolean {
  const digits = (s: string) => s.replace(/\D/g, "");
  const t = title.trim().toLowerCase();
  for (const n of names) {
    const name = n.trim();
    if (!name) continue;
    if (t === name.toLowerCase()) return true;
    const d = digits(name);
    if (d.length >= 5 && /^\+?[\d\s().-]+$/.test(title) && digits(title).endsWith(d.slice(-10))) return true;
  }
  return false;
}

/**
 * Deletes one conversation in Messages.app, or throws with what stood in the
 * way. The chat is opened first and its window's title checked against the
 * names the chat goes by, so a link that lands somewhere else never has
 * another conversation deleted in its place.
 *
 * When Messages does not say it deleted (2026-09-14), `isGone` asks chat.db
 * whether the chat went anyway, and if it did not, the whole thing, title
 * check included, runs once more before giving up.
 */
export async function deleteConversation(
  run: AppleScriptRunner,
  handle: string,
  names: string[] = [handle],
  opts: { isGone?: () => Promise<boolean>; attempts?: number } = {},
): Promise<string> {
  const attempts = opts.attempts ?? 2;
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const opened = (await run(openConversationScript(handle))).trim();
    if (!opened.startsWith("title:")) throw new Error(`Messages did not open the chat with ${handle}: ${opened || "no answer"}`);
    const title = opened.slice("title:".length);
    if (!titleNamesChat(title, names)) throw new Error(`Messages opened "${title}" for ${handle}, not this chat`);
    const out = (await run(deleteConversationScript(handle))).trim();
    if (DONE.has(out)) return out;
    last = out;
    if (opts.isGone && (await opts.isGone())) return "deleted";
  }
  throw new Error(`Messages did not delete the chat with ${handle}: ${last || "no answer"}`);
}
