import { appleScriptString } from "../imessage/send";
import type { AppleScriptRunner } from "../imessage/types";
import type { WaChat } from "./types";
import { returningToFront } from "../imessage/front";

/**
 * Driving WhatsApp.app (spec 10g, 2026-09-11). The app has no scripting
 * dictionary, so everything goes through System Events: the Chat menu (the
 * fifth menu, its item names carry an invisible left-to-right mark, so they
 * are matched by their ending), the sidebar's rows, which are buttons named
 * after the chat, and the confirmation dialogs. Every script runs in one
 * piece, activating the app first: WhatsApp may live on another Space.
 */

/** Waits for WhatsApp's window, up to about five seconds. */
const WAIT_FOR_WINDOW = [
  `  set tries to 0`,
  `  repeat while (count of windows) = 0 and tries < 20`,
  `    delay 0.5`,
  `    set tries to tries + 1`,
  `  end repeat`,
  `  if (count of windows) = 0 then return "no window"`,
];

/** Which chat the Chat menu is about: the person the Block item names, or none for a group. */
const READ_BLOCK = [
  `  set blockName to ""`,
  `  repeat with mi in menu items of menu 5 of menu bar 1`,
  `    try`,
  `      set n to name of mi as text`,
  `      if n contains "Block " then set blockName to text ((offset of "Block " in n) + 6) thru -1 of n`,
  `    end try`,
  `  end repeat`,
];

/** Clicks the menu item of the Chat menu whose name ends with the words given. */
function clickChatMenuItem(ending: string): string[] {
  // The Chat menu fills in a moment after a chat opens (2026-09-12): looked
  // at too soon, the item is not there yet.
  return [
    `  set theItem to missing value`,
    `  set waits to 0`,
    `  repeat while theItem is missing value and waits < 8`,
    `    repeat with mi in menu items of menu 5 of menu bar 1`,
    `      try`,
    `        if (name of mi as text) ends with ${appleScriptString(ending)} then set theItem to mi`,
    `      end try`,
    `    end repeat`,
    `    if theItem is missing value then delay 0.5`,
    `    set waits to waits + 1`,
    `  end repeat`,
    `  if theItem is missing value then return "no menu item ${ending}"`,
    `  click theItem`,
  ];
}

/**
 * Opens a chat: a person by the whatsapp:// link (with the text to send, when
 * there is one), a group or a person without a number by Search and a click
 * on the row that carries the chat's name.
 */
function openChat(chat: WaChat, text: string | null): string[] {
  if (chat.kind === "person" && chat.phone) {
    const url = `whatsapp://send?phone=${chat.phone}${text !== null ? `&text=${encodeURIComponent(text)}` : ""}`;
    return [`do shell script "open " & quoted form of ${appleScriptString(url)}`, `delay 1.5`];
  }
  // Search brings the row into view; the row is the button named after the
  // chat. Nothing is typed until the search field has the focus: typed into
  // the open chat's box instead, a name is a message (2026-09-11, a probe
  // sent "Bond" to a friend that way).
  return [
    `tell application "System Events" to tell process "WhatsApp"`,
    `  set searchItem to missing value`,
    `  repeat with mi in menu items of menu 3 of menu bar 1`,
    `    try`,
    `      if (name of mi as text) ends with "Search" then set searchItem to mi`,
    `    end try`,
    `  end repeat`,
    `  if searchItem is missing value then return "no search item"`,
    `  click searchItem`,
    `  delay 0.8`,
    // Which element has the focus, asked of the process (`of it`) rather than
    // of the window's own children: the search field sits several levels down,
    // so `first UI element of window 1 whose focused is true` never matched and
    // this failed with an empty name every time (2026-09-16).
    //
    // It is waited for rather than checked once. Clicking Search does not
    // always land the focus straight away, and the element it lands on before
    // then is "Compose message" — the box where a typed name becomes a message
    // to whoever is open. The description is what identifies the field:
    // WhatsApp reports its role as AXGenericElement, and its description
    // carries an invisible left-to-right mark, so it is matched by containing
    // "Search" rather than by equality.
    `  set focusedRole to ""`,
    `  set focusedDesc to ""`,
    `  set waits to 0`,
    `  repeat while waits < 20`,
    `    try`,
    `      set fe to value of attribute "AXFocusedUIElement" of it`,
    `      set focusedRole to role of fe as text`,
    `      set focusedDesc to description of fe as text`,
    `    end try`,
    `    if focusedDesc contains "Search" then exit repeat`,
    `    delay 0.25`,
    `    set waits to waits + 1`,
    `  end repeat`,
    `  if focusedDesc does not contain "Search" then`,
    `    key code 53`,
    `    return "search not focused, " & focusedRole & " had it: " & focusedDesc`,
    `  end if`,
    `  keystroke ${appleScriptString(chat.name)}`,
    `  delay 1.5`,
    // WhatsApp is a Catalyst app and its chat list does not come back through
    // `entire contents` (2026-09-16: the failure listed no rows at all, not
    // merely no matching one). So the row is not hunted for. Typing the name
    // and pressing Return opens the top hit, which is what a person does.
    //
    // A row is still clicked when the tree does happen to offer one, since
    // that is exact where Return is only very likely. Either way `guard`
    // re-checks which chat actually opened before a word is typed or sent.
    `  set theRow to missing value`,
    `  try`,
    `    repeat with e in (entire contents of window 1)`,
    `      try`,
    `        set r to role of e as text`,
    `        if r is "AXButton" or r is "AXRow" or r is "AXCell" then`,
    `          set lbl to ""`,
    `          try`,
    `            set lbl to description of e as text`,
    `          end try`,
    `          if lbl is "" then`,
    `            try`,
    `              set lbl to title of e as text`,
    `            end try`,
    `          end if`,
    `          if lbl is ${appleScriptString(chat.name)} or lbl starts with ${appleScriptString(chat.name)} then`,
    `            set theRow to e`,
    `            exit repeat`,
    `          end if`,
    `        end if`,
    `      end try`,
    `    end repeat`,
    `  end try`,
    `  if theRow is missing value then`,
    `    key code 36`,
    `  else`,
    `    click theRow`,
    `  end if`,
    `  delay 1.2`,
    `end tell`,
  ];
}

/**
 * Every static text the app is showing, gathered by walking `UI elements`
 * level by level rather than asking for `entire contents` (2026-09-16).
 * WhatsApp is a Catalyst app: `entire contents` came back empty on it every
 * time, which is what left the guard blind and every group send refused.
 * The walk is bounded in depth and in nodes, so a deep tree cannot hang it.
 */
const COLLECT_TEXTS = [
  `  set shown to ""`,
  `  set frontier to {}`,
  `  try`,
  `    repeat with w in windows`,
  `      set end of frontier to w`,
  `    end repeat`,
  `  end try`,
  `  set depth to 0`,
  `  set visited to 0`,
  `  repeat while depth < 12 and (count of frontier) > 0 and visited < 4000`,
  `    set nextFrontier to {}`,
  `    repeat with e in frontier`,
  `      set visited to visited + 1`,
  `      if visited > 4000 then exit repeat`,
  `      try`,
  `        set v to ""`,
  `        try`,
  `          set v to value of e as text`,
  `        end try`,
  `        if v is "" then`,
  `          try`,
  `            set v to description of e as text`,
  `          end try`,
  `        end if`,
  `        if v is not "" and (count of shown) < 1200 then set shown to shown & "|" & v`,
  `      end try`,
  `      try`,
  `        repeat with c in UI elements of e`,
  `          set end of nextFrontier to c`,
  `        end repeat`,
  `      end try`,
  `    end repeat`,
  `    set frontier to nextFrontier`,
  `    set depth to depth + 1`,
  `  end repeat`,
];

/** The check that the chat on screen is this one, or the script stops before it sends or deletes anything. */
function guard(chat: WaChat): string[] {
  if (chat.kind === "person") {
    return [...READ_BLOCK, `  if blockName is not ${appleScriptString(chat.name)} then return "wrong chat: " & blockName`];
  }
  // A group has no Block item, so the Chat menu says "not a person" and no
  // more. Its name is looked for in the window title and in any static text,
  // and the tree may answer neither: WhatsApp is a Catalyst app and its
  // contents often do not come back at all (2026-09-16).
  //
  // So the two are weighed rather than required. A group whose name is
  // nowhere and whose Block item is absent is still not proof of the wrong
  // chat, but a Block item naming a person is proof, and that is the case
  // that matters: it means a person's chat is open, and a group's message
  // must never go there.
  return [
    ...READ_BLOCK,
    `  if blockName is not "" then return "wrong chat, a person is open: " & blockName`,
    ...COLLECT_TEXTS,
    `  set seen to (shown contains ${appleScriptString(chat.name)})`,
    // Still failing closed. A different group is the one thing the Block item
    // cannot rule out, so the name has to be confirmed somewhere before a
    // message goes anywhere. What the walk did find rides back with the
    // refusal, because that is what says how to recognise the chat next time.
    `  if not seen then return "wrong chat, could not confirm " & ${appleScriptString(chat.name)} & "; saw: " & shown`,
  ];
}

export function whatsappSendScript(chat: WaChat, text: string): string {
  const byLink = chat.kind === "person" && Boolean(chat.phone);
  return returningToFront([
    `tell application "WhatsApp" to activate`,
    `delay 0.8`,
    ...openChat(chat, byLink ? text : null),
    `tell application "System Events" to tell process "WhatsApp"`,
    ...WAIT_FOR_WINDOW,
    ...guard(chat),
    ...(byLink
      ? []
      : [
          // No link carries text to a group: the text goes in through the
          // clipboard, into the box the opened chat leaves focused.
          `  set the clipboard to ${appleScriptString(text)}`,
          `  keystroke "v" using command down`,
          `  delay 0.8`,
        ]),
    // The message box is not exposed to System Events, and the Chat menu's
    // Send does nothing for it (2026-09-11: the operator had to press Send
    // in WhatsApp). Return in the box is what sends; the store is read
    // afterwards to see that it did.
    `  key code 36`,
    `  return "sent"`,
    `end tell`,
  ]);
}

/** Delete chat for a person, Clear chat for a group (spec 10g), then the dialog's own button, never Cancel. */
export function whatsappDeleteScript(chat: WaChat): string {
  const item = chat.kind === "group" ? "Clear chat" : "Delete chat";
  return returningToFront([
    `tell application "WhatsApp" to activate`,
    `delay 0.8`,
    ...openChat(chat, null),
    `tell application "System Events" to tell process "WhatsApp"`,
    ...WAIT_FOR_WINDOW,
    ...guard(chat),
    ...clickChatMenuItem(item),
    `  delay 1.2`,
    `  set confirmed to false`,
    `  repeat with w in windows`,
    `    repeat with e in (entire contents of w)`,
    `      try`,
    `        if role of e is "AXButton" then`,
    `          set label to ""`,
    `          try`,
    `            set label to title of e as text`,
    `          end try`,
    `          if label is "" then set label to description of e as text`,
    `          if (label starts with "${chat.kind === "group" ? "Clear" : "Delete"}") and not confirmed then`,
    `            click e`,
    `            set confirmed to true`,
    `          end if`,
    `        end if`,
    `      end try`,
    `    end repeat`,
    `  end repeat`,
    `  if not confirmed then`,
    `    key code 53`,
    `    return "no confirm button"`,
    `  end if`,
    `  return "confirmed"`,
    `end tell`,
  ]);
}

export async function sendInWhatsapp(run: AppleScriptRunner, chat: WaChat, text: string): Promise<void> {
  const out = (await run(whatsappSendScript(chat, text))).trim();
  if (out !== "sent") throw new Error(`WhatsApp did not send to ${chat.name}: ${out || "no answer"}`);
}

export async function deleteInWhatsapp(run: AppleScriptRunner, chat: WaChat): Promise<void> {
  const out = (await run(whatsappDeleteScript(chat))).trim();
  if (out !== "confirmed") throw new Error(`WhatsApp did not ${chat.kind === "group" ? "clear" : "delete"} the chat with ${chat.name}: ${out || "no answer"}`);
}
