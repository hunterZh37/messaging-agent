import { describe, it, expect } from "vitest";
import { deleteInWhatsapp, whatsappDeleteScript as deleteScript, sendInWhatsapp, whatsappSendScript as sendScript } from "../../src/whatsapp/app";
import { whatsappSender } from "../../src/whatsapp/sender";
import type { WaChat, WaMessage, WhatsappSource } from "../../src/whatsapp/types";

const person: WaChat = { jid: "14155550111@s.whatsapp.net", name: "Ada Lovelace", kind: "person", phone: "14155550111" };
const group: WaChat = { jid: "120363100000000001@g.us", name: "Team Standup", kind: "group", phone: null };

describe("sendScript", () => {
  it("opens a person by link with the text, checks the Block item names them, and clicks Send", () => {
    const s = sendScript(person, "See you at 6 & 7?");
    expect(s).toContain("whatsapp://send?phone=14155550111&text=See%20you%20at%206%20%26%207%3F");
    expect(s).toContain('if blockName is not "Ada Lovelace" then return my done("wrong chat: " & blockName)');
    expect(s).toContain("key code 36");
    // Celeste comes back to the front afterwards, whatever the script returns.
    expect(s).toContain("tell application prevApp to activate");
    expect(s).toContain('return my done("sent")');
    expect(s).toContain('return my done("wrong chat: " & blockName)');
    expect(s).not.toContain("clipboard");
  });

  it("opens a group by Search and its row, pastes the text, and checks the group is on screen", () => {
    const s = sendScript(group, "on my way");
    expect(s).toContain('ends with "Search"');
    expect(s).toContain('search not focused, " & focusedRole & " had it: "');
    expect(s).toContain('keystroke "Team Standup"');
    expect(s.indexOf("search not focused")).toBeLessThan(s.indexOf('keystroke "Team Standup"'));
    expect(s).toContain('lbl is "Team Standup"');
    expect(s).toContain("key code 36");
    expect(s).toContain('set the clipboard to "on my way"');
    expect(s).toContain('if blockName is not "" then return my done("wrong chat, a person is open: " & blockName)');
    expect(s).toContain('set seen to (shown contains "Team Standup")');
  });

  // The result row is one cell carrying name, last message, time and badge,
  // so its label is never just the name (2026-09-16: "no row named …").
  // WhatsApp is a Catalyst app: `entire contents` returned no rows at all,
  // not merely no matching one (2026-09-16). Return opens the top hit.
  it("opens the top hit with Return when the tree offers no row", () => {
    const s = sendScript(group, "on my way");
    expect(s).toContain("if theRow is missing value then");
    expect(s).toContain('lbl starts with "Team Standup"');
    // The Return that opens the hit comes before the text is ever pasted.
    expect(s.indexOf("key code 36")).toBeLessThan(s.indexOf("set the clipboard to"));
  });

  // A different group is the one thing the Block item cannot rule out, so the
  // name still has to be confirmed before anything is sent.
  it("refuses to send to a group it cannot confirm, and says what it saw", () => {
    const s = sendScript(group, "x");
    expect(s).toContain('wrong chat, could not confirm " & "Team Standup"');
    expect(s).toContain('"; saw: " & shown');
    expect(s.indexOf("could not confirm")).toBeLessThan(s.indexOf("set the clipboard to"));
  });

  // `entire contents` returns nothing on this Catalyst app, which is what
  // blinded the guard; the tree is walked a level at a time instead, bounded
  // so a deep one cannot hang the send (2026-09-16).
  it("walks UI elements rather than asking for entire contents", () => {
    const s = sendScript(group, "x");
    expect(s).toContain("repeat with c in UI elements of e");
    expect(s).toContain("repeat while depth < 12");
    expect(s).toContain("visited < 4000");
    // The walk happens before anything is pasted or sent.
    expect(s.indexOf("UI elements of e")).toBeLessThan(s.indexOf("set the clipboard to"));
  });

  // The focused element sits several levels inside the window, so asking the
  // window for a focused child found nothing and the guard tripped on every
  // group send (2026-09-16). It is the process that knows.
  it("asks the process which element has the focus, not the window's own children", () => {
    const s = sendScript(group, "on my way");
    expect(s).toContain('value of attribute "AXFocusedUIElement" of it');
    expect(s).not.toContain("first UI element of window 1 whose focused is true");
  });

  // Clicking Search does not always land the focus at once; before it does,
  // the focus is on the compose box. Checked once, the send died there.
  it("waits for the search field rather than checking the focus once", () => {
    const s = sendScript(group, "on my way");
    expect(s).toContain("repeat while waits < 20");
    expect(s).toContain('if focusedDesc contains "Search" then exit repeat');
    expect(s.indexOf("repeat while waits < 20")).toBeLessThan(s.indexOf('keystroke "Team Standup"'));
  });

  // WhatsApp reports the field as AXGenericElement, so a role allow-list
  // rejected the very thing it was meant to accept (2026-09-16).
  it("identifies the field by its description, not by a role allow-list", () => {
    const s = sendScript(group, "on my way");
    expect(s).not.toContain("AXSearchField");
    expect(s).toContain('focusedDesc does not contain "Search"');
  });

  // Failing closed is the whole point: a name typed into an open chat's box
  // is a message to whoever that chat belongs to.
  it("still refuses to type the name unless a search field has the focus", () => {
    const s = sendScript(group, "on my way");
    const refuse = s.indexOf("search not focused,");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(s.indexOf('keystroke "Team Standup"'));
    expect(s).toContain('if focusedDesc does not contain "Search"');
  });
});

describe("deleteScript", () => {
  it("deletes a person's chat and clears a group's, confirming with the dialog's own button", () => {
    expect(deleteScript(person)).toContain('ends with "Delete chat"');
    expect(deleteScript(person)).toContain('label starts with "Delete"');
    expect(deleteScript(group)).toContain('ends with "Clear chat"');
    expect(deleteScript(group)).toContain('label starts with "Clear"');
    expect(deleteScript(group)).not.toContain("Delete chat");
  });
});

describe("sendInWhatsapp / deleteInWhatsapp", () => {
  it("is done on the script's word, and throws with its answer otherwise", async () => {
    await expect(sendInWhatsapp(async () => "sent\n", person, "x")).resolves.toBeUndefined();
    await expect(sendInWhatsapp(async () => "wrong chat: Sam", person, "x")).rejects.toThrow(/did not send to Ada Lovelace: wrong chat: Sam/);
    await expect(deleteInWhatsapp(async () => "confirmed", group)).resolves.toBeUndefined();
    await expect(deleteInWhatsapp(async () => "no confirm button", group)).rejects.toThrow(/did not clear the chat with Team Standup: no confirm button/);
  });
});

function source(sent: WaMessage[]): WhatsappSource {
  return {
    own: () => ({ jid: "1@s.whatsapp.net", lid: null, phone: "1" }),
    messagesAfter: () => [],
    latestOwnMessage: (jid, after, text) => sent.find((m) => m.chat.jid === jid && m.sentAt > after && m.text === text) ?? null,
    chatState: () => ({ exists: true, removed: false, count: 1 }),
    chat: (jid) => (jid === person.jid ? person : jid === group.jid ? group : null),
    pushNames: () => new Map(),
    close() {},
  };
}

describe("whatsappSender", () => {
  it("sends to the draft's chat and answers with the message WhatsApp stored", async () => {
    const scripts: string[] = [];
    const stored: WaMessage = { pk: 9, stanzaId: "3EB0", chat: person, text: "on my way", isFromMe: true, sentAt: 5000, senderJid: null, senderName: null, media: null };
    const sender = whatsappSender(source([stored]), async (s) => (scripts.push(s), "sent"), () => 4000);
    const r = await sender.sendReply({ replyToProviderMessageId: "x", providerThreadId: person.jid, from: "me", to: [person.jid], cc: [], subject: "", inReplyTo: null, body: "on my way" });
    expect(r).toEqual({ id: "3EB0" });
    expect(scripts[0]).toContain("whatsapp://send?phone=14155550111");
  });

  it("refuses a chat WhatsApp does not have, and a send the store never shows", async () => {
    const sender = whatsappSender(source([]), async () => "sent", () => 4000);
    await expect(sender.sendReply({ replyToProviderMessageId: "x", providerThreadId: "nope@g.us", from: "me", to: [], cc: [], subject: "", inReplyTo: null, body: "hi" })).rejects.toThrow(/no chat/);
    await expect(sender.sendReply({ replyToProviderMessageId: "x", providerThreadId: person.jid, from: "me", to: [], cc: [], subject: "", inReplyTo: null, body: "hi" })).rejects.toThrow(/shows no message sent/);
  }, 15_000);
});
