import { describe, it, expect } from "vitest";
import { deleteConversation, deleteConversationScript, handleOfChat, openConversationScript, titleNamesChat } from "../../src/imessage/delete";

describe("handleOfChat", () => {
  it("is the part of the chat guid after the service", () => {
    expect(handleOfChat("any;-;+14155550100")).toBe("+14155550100");
    expect(handleOfChat("iMessage;-;sam@example.com")).toBe("sam@example.com");
    expect(handleOfChat("22395")).toBe("22395");
  });
});

describe("deleteConversationScript", () => {
  it("opens the chat by its imessage URL, chooses Delete Conversation, and presses Delete on the sheet", () => {
    const s = deleteConversationScript("+14155550100");
    expect(s).toContain('open location "imessage://+14155550100"');
    expect(s).toContain('menu item "Delete Conversation…" of menu "Conversation"');
    expect(s).toContain('(title of b as text) is "Delete"');
    // Never the spam button, and Escape when Delete is not there.
    expect(s).not.toContain("Report Spam");
    expect(s).toContain("key code 53");
  });

  it("looks for Delete in every window, sheet and dialog for a few seconds, and never indexes a window blindly (2026-09-14)", () => {
    const s = deleteConversationScript("+14155550100");
    expect(s).not.toContain("sheets of window 1");
    expect(s).not.toContain("sheet 1 of window 1");
    expect(s).toContain("repeat with w in windows");
    expect(s).toContain("set places to (sheets of w) as list");
    expect(s).toContain("repeat while looks < 10");
    expect(s).toContain('return my done("window gone")');
  });

  /**
   * Messages running with every window closed is the common way for it to sit
   * on a Mac, and `activate` alone does not open one: the script waited its
   * ten seconds and gave up, twenty-five times across ten chats in the
   * operator's own log, each one a row that came back with no reason given
   * (operator, 2026-10-06: "some messages for mobile views just seem to be
   * unable to be deleted").
   */
  it("asks Messages for a window before waiting for one", () => {
    const s = deleteConversationScript("+14155550100");
    expect(s).toContain('tell application "Messages" to reopen');
    // Before the chat is asked for, and before anything waits on a window.
    expect(s.indexOf("reopen")).toBeLessThan(s.indexOf("open location"));
    expect(s.indexOf("reopen")).toBeLessThan(s.indexOf("count of windows"));
  });

  it("escapes a handle for AppleScript", () => {
    expect(deleteConversationScript('a"b')).toContain('"imessage://a\\"b"');
  });
});

describe("titleNamesChat", () => {
  it("knows a number however Messages punctuates it, and a name as written", () => {
    expect(titleNamesChat("+1 (415) 555-0144", ["+14155550144"])).toBe(true);
    expect(titleNamesChat("24273", ["24273"])).toBe(true);
    expect(titleNamesChat("Partiful", ["partiful_a1b2c3d4_agent@rbm.goog", "", "Partiful"])).toBe(true);
    expect(titleNamesChat("Grace Hopper", ["+14155550122", "Grace Hopper"])).toBe(true);
    expect(titleNamesChat("Grace Hopper", ["+14155550122"])).toBe(false);
    expect(titleNamesChat("New Message", ["+14155550144"])).toBe(false);
    expect(titleNamesChat("+1 (415) 555-0122", ["+14155550144"])).toBe(false);
  });
});

describe("openConversationScript", () => {
  it("asks for a window the same way the delete does", () => {
    const s = openConversationScript("+14155550100");
    expect(s).toContain('tell application "Messages" to reopen');
    expect(s.indexOf("reopen")).toBeLessThan(s.indexOf("count of windows"));
  });

  it("waits for a window and answers with the title of every one of them", () => {
    const s = openConversationScript("+14155550100");
    expect(s).toContain('open location "imessage://+14155550100"');
    expect(s).toContain("repeat while (count of windows) = 0 and tries < 20");
    // Never window 1 alone: it was a Quick Look panel the one time it
    // mattered (their log, 2026-10-06).
    expect(s).not.toContain("title of window 1");
    expect(s).toContain("repeat with w in windows");
    expect(s).toContain("(title of w as text)");
    expect(s).toContain('"titles:"');
    expect(s).toContain("tell application prevApp to activate");
  });
});

/** A fake Messages: the titles its windows show, then what the delete says. */
function messagesThat(titles: string | string[], answer: string) {
  const ran: string[] = [];
  const run = async (script: string) => {
    ran.push(script);
    return script.includes('"titles:"') ? `titles:${[titles].flat().join("\n")}\n` : answer;
  };
  return { run, ran };
}

describe("deleteConversation", () => {
  /**
   * The operator's own log, 2026-10-06: `Messages opened "Quick Look" for
   * +1833…, not this chat`. A Quick Look panel was window 1 and the
   * conversation sat behind it, so a delete they had asked for was refused.
   */
  it("finds the chat in any window, not just the first one", async () => {
    const m = messagesThat(["Quick Look", "+1 (415) 555-0100"], "deleted\n");
    await expect(deleteConversation(m.run, "+14155550100", ["+14155550100"])).resolves.toBe("deleted");
  });

  it("still refuses when no window shows the chat, and says what it did see", async () => {
    const m = messagesThat(["Quick Look", "Ben Brooks"], "deleted\n");
    await expect(deleteConversation(m.run, "+14155550100", ["+14155550100"])).rejects.toThrow(/"Quick Look", "Ben Brooks".*not this chat/);
  });

  it("is done when Messages deleted, or had nothing to delete", async () => {
    for (const answer of ["deleted", "no sheet", "nothing to delete"]) {
      const m = messagesThat("+1 (415) 555-0100", `${answer}\n`);
      await expect(deleteConversation(m.run, "+14155550100")).resolves.toBe(answer);
      expect(m.ran.length).toBe(2);
    }
  });

  it("never deletes when the window Messages opened is another chat", async () => {
    const m = messagesThat("Grace Hopper", "deleted");
    await expect(deleteConversation(m.run, "+14155550144", ["+14155550144"])).rejects.toThrow(/opened "Grace Hopper" for \+14155550144, not this chat/);
    expect(m.ran.length).toBe(1);
    await expect(deleteConversation(async () => "no window", "+1")).rejects.toThrow(/did not open the chat with \+1: no window/);
  });

  it("asks chat.db when Messages did not say deleted, and counts a chat that went anyway", async () => {
    const m = messagesThat("+1 (415) 555-0100", "window gone");
    await expect(deleteConversation(m.run, "+14155550100", ["+14155550100"], { isGone: async () => true })).resolves.toBe("deleted");
    expect(m.ran.length).toBe(2);
  });

  it("tries once more, title check included, when the chat is still there, then gives up with the last answer", async () => {
    const answers = ["window gone", "deleted"];
    const ran: string[] = [];
    const run = async (script: string) => {
      ran.push(script);
      return script.includes('"titles:"') ? "titles:+1 (415) 555-0100\n" : answers.shift()!;
    };
    await expect(deleteConversation(run, "+14155550100", ["+14155550100"], { isGone: async () => false })).resolves.toBe("deleted");
    expect(ran.length).toBe(4);
    const stuck = messagesThat("+1 (415) 555-0100", "window gone");
    await expect(deleteConversation(stuck.run, "+14155550100", ["+14155550100"], { isGone: async () => false })).rejects.toThrow(/window gone/);
    expect(stuck.ran.length).toBe(4);
  });

  it("throws with Messages' answer when the chat stayed", async () => {
    await expect(deleteConversation(messagesThat("+1 (415) 555-0100", "no window").run, "+14155550100")).rejects.toThrow(/did not delete the chat with \+14155550100: no window/);
    await expect(deleteConversation(messagesThat("+1", "").run, "+1")).rejects.toThrow(/no answer/);
    await expect(deleteConversation(async () => Promise.reject(new Error("not allowed assistive access")), "+1")).rejects.toThrow(/assistive/);
  });
});
