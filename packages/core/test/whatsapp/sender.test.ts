import { describe, it, expect } from "vitest";
import { whatsappSender } from "../../src/whatsapp/sender";
import type { WaChat, WhatsappSource } from "../../src/whatsapp/types";

function sourceFor(chat: WaChat, own: { stanzaId: string } | null = null): WhatsappSource {
  return {
    chat: () => chat,
    latestOwnMessage: () => own,
  } as unknown as WhatsappSource;
}

describe("whatsappSender", () => {
  // WhatsApp.app exposes its menus and the focused control to accessibility
  // but not its window contents, so nothing on screen names the group that is
  // open. A one-to-one chat is named by the Chat menu's "Block <name>" item
  // and can be confirmed before anything is typed; a group has no such item.
  // Rather than send into a chat it cannot identify, it does not send at all
  // (operator, 2026-09-16).
  it("refuses a group rather than send into a chat it cannot identify", async () => {
    const ran: string[] = [];
    const sender = whatsappSender(sourceFor({ jid: "120363100000000001@g.us", name: "Team Standup", kind: "group", phone: null }), async (s) => {
      ran.push(s);
      return "sent";
    });
    await expect(sender.sendReply({ providerThreadId: "120363100000000001@g.us", body: "hi" } as never)).rejects.toThrow(/not supported/);
    // It never reached WhatsApp at all: no script was run.
    expect(ran).toEqual([]);
  });

  it("still sends to a person, whose chat the Block item confirms", async () => {
    const ran: string[] = [];
    const sender = whatsappSender(sourceFor({ jid: "14155550111@s.whatsapp.net", name: "Ada Lovelace", kind: "person", phone: "14155550111" }, { stanzaId: "s1" }), async (s) => {
      ran.push(s);
      return "sent";
    });
    await expect(sender.sendReply({ providerThreadId: "14155550111@s.whatsapp.net", body: "hi" } as never)).resolves.toEqual({ id: "s1" });
    expect(ran).toHaveLength(1);
  });
});
