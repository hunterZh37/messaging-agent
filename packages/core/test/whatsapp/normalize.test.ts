import { describe, it, expect } from "vitest";
import { normalizeWhatsapp, renderMentions } from "../../src/whatsapp/normalize";
import { coreDataToMs, msToCoreData, phoneOfChat } from "../../src/whatsapp/chatstore";
import type { WaMessage } from "../../src/whatsapp/types";

const self = { jid: "12025550100@s.whatsapp.net", lid: "20250000000001@lid", phone: "12025550100" };
const names = new Map([["20250000000002@lid", "Alan Turing"], ["14155550111@s.whatsapp.net", "Ada"]]);

describe("renderMentions", () => {
  it("names the mentioned person, and says @you for the operator", () => {
    expect(renderMentions("hey @20250000000002 and @20250000000001", self, names)).toEqual({ text: "hey @Alan Turing and @you", mentionsOperator: true });
    expect(renderMentions("@14155550111 ping", self, names)).toEqual({ text: "@Ada ping", mentionsOperator: false });
    expect(renderMentions("@12025550100 via number", self, names).mentionsOperator).toBe(true);
    expect(renderMentions("mail me @ noon", self, names)).toEqual({ text: "mail me @ noon", mentionsOperator: false });
  });
});

describe("chatstore helpers", () => {
  it("converts Core Data seconds both ways", () => {
    expect(coreDataToMs(0)).toBe(978307200000);
    expect(msToCoreData(coreDataToMs(812345678))).toBeCloseTo(812345678, 3);
  });
  it("finds the phone behind either of a chat's ids", () => {
    expect(phoneOfChat("14155550111@s.whatsapp.net", "202500000000003@lid")).toBe("14155550111");
    expect(phoneOfChat("20250000000004@lid", "14155550155@s.whatsapp.net")).toBe("14155550155");
    expect(phoneOfChat("120363100000000002@g.us", null)).toBeNull();
  });
});

function msg(p: Partial<WaMessage>): WaMessage {
  return {
    pk: 1,
    stanzaId: "ABC",
    chat: { jid: "14155550111@s.whatsapp.net", name: "Ada Lovelace", kind: "person", phone: "14155550111" },
    text: "hi",
    isFromMe: false,
    sentAt: 1_700_000_000_000,
    senderJid: "14155550111@s.whatsapp.net",
    senderName: "Ada Lovelace",
    media: null,
    ...p,
  };
}

describe("normalizeWhatsapp", () => {
  it("files a person's text under the chat, from them to me", () => {
    const n = normalizeWhatsapp(msg({}), self, names);
    expect(n.folder).toBe("messages");
    expect(n.providerThreadId).toBe("14155550111@s.whatsapp.net");
    expect(n.subject).toBe("Ada Lovelace");
    expect(n.fromAddress).toBe("14155550111@s.whatsapp.net");
    expect(n.fromName).toBe("Ada Lovelace");
    expect(n.toAddresses).toEqual([self.jid]);
    expect(n.isFromOperator).toBe(false);
    expect(n.mentionsOperator).toBe(false);
  });

  it("files my own text as mine, to the chat", () => {
    const n = normalizeWhatsapp(msg({ isFromMe: true, senderJid: null, senderName: null }), self, names);
    expect(n.fromAddress).toBe(self.jid);
    expect(n.toAddresses).toEqual(["14155550111@s.whatsapp.net"]);
    expect(n.isFromOperator).toBe(true);
  });

  it("names the group member who wrote, and marks a mention of me", () => {
    const n = normalizeWhatsapp(
      msg({ chat: { jid: "120363100000000002@g.us", name: "Alan's Launchpad Group", kind: "group", phone: null }, senderJid: "20250000000002@lid", senderName: "Alan Turing", text: "@20250000000001 are you in?" }),
      self,
      names,
    );
    expect(n.subject).toBe("Alan's Launchpad Group");
    expect(n.fromName).toBe("Alan Turing");
    expect(n.bodyText).toBe("@you are you in?");
    expect(n.mentionsOperator).toBe(true);
  });

  it("carries a media file as an attachment, with the caption as the text", () => {
    const n = normalizeWhatsapp(msg({ text: "look", media: { path: "Media/x/1.jpg", filename: "1.jpg", size: 10 } }), self, names);
    expect(n.attachments).toEqual([{ index: 0, filename: "1.jpg", mimeType: "image/jpeg", size: 10, providerAttachmentId: "Media/x/1.jpg", bytes: null }]);
    expect(n.snippet).toBe("look");
    expect(normalizeWhatsapp(msg({ text: null, media: { path: "Media/x/1.jpg", filename: "1.jpg", size: 10 } }), self, names).snippet).toBe("An attachment");
  });
});
