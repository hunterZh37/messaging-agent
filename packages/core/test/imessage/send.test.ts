import { describe, it, expect } from "vitest";
import { appleScriptString, imessageSender, isHandle, sendScript, serviceFor } from "../../src/imessage/send";
import type { ImessageSource, TextRow } from "../../src/imessage/types";

describe("sendScript", () => {
  it("escapes the text and picks the service", () => {
    expect(appleScriptString('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
    expect(serviceFor("iMessage")).toBe("iMessage");
    expect(serviceFor("SMS")).toBe("SMS");
    expect(serviceFor("RCS")).toBe("SMS");
    expect(sendScript("+14155550100", "iMessage", "On my way")).toContain('send "On my way" to theBuddy');
    expect(sendScript("+14155550100", "SMS", "x")).toContain("service type = SMS");
  });
});

describe("imessageSender", () => {
  it("runs the script and returns the guid Messages wrote for it", async () => {
    const scripts: string[] = [];
    let t = 1000;
    const own: TextRow = { rowid: 9, guid: "sent-guid", chatGuid: "SMS;-;+14155550100", handle: "+14155550100", service: "SMS", text: "On my way", isFromMe: true, sentAt: 1500, attachments: [] };
    const source: ImessageSource = { ownHandle: () => "me", textsAfter: () => [], latestOwnText: () => own, contactNames: () => new Map(), close() {} };
    const sender = imessageSender(source, async (s) => { scripts.push(s); return ""; }, () => (t += 100));
    const r = await sender.sendReply({ replyToProviderMessageId: "g1", providerThreadId: "SMS;-;+14155550100", from: "me", to: ["+14155550100"], cc: [], subject: "", inReplyTo: null, body: "On my way" });
    expect(r).toEqual({ id: "sent-guid" });
    expect(scripts[0]).toContain("service type = SMS");
    expect(scripts[0]).toContain('participant "+14155550100"');
  });

  it("files the send under a local id when chat.db has not caught up", async () => {
    const source: ImessageSource = { ownHandle: () => "me", textsAfter: () => [], latestOwnText: () => null, contactNames: () => new Map(), close() {} };
    const sender = imessageSender(source, async () => "", () => 5000);
    const r = await sender.sendReply({ replyToProviderMessageId: "g1", providerThreadId: "any;-;+14155550100", from: "me", to: ["+14155550100"], cc: [], subject: "", inReplyTo: null, body: "hey" });
    expect(r.id).toBe("local-5000");
  }, 10_000);

  it("refuses a handle that is neither a number nor an Apple ID, and a second person", async () => {
    const sender = imessageSender(null, async () => "");
    const base = { replyToProviderMessageId: "g1", providerThreadId: "x", from: "me", cc: [], subject: "", inReplyTo: null, body: "hey" };
    await expect(sender.sendReply({ ...base, to: ["not a handle"] })).rejects.toThrow(/Not a number or an Apple ID/);
    await expect(sender.sendReply({ ...base, to: ['+1"\n'] })).rejects.toThrow(/Not a number/);
    await expect(sender.sendReply({ ...base, to: ["+14155550100", "+14155550101"] })).rejects.toThrow(/one person/);
    await expect(sender.sendReply({ ...base, to: ["+14155550100"], cc: ["a@b.co"] })).rejects.toThrow(/one person/);
  });

  it("knows a handle", () => {
    expect(isHandle("+14155550122")).toBe(true);
    expect(isHandle("14155550122")).toBe(true);
    expect(isHandle("grace@icloud.com")).toBe(true);
    expect(isHandle("nope")).toBe(false);
    expect(isHandle("a@b@c")).toBe(false);
  });

  it("refuses a reply with nobody to text", async () => {
    const sender = imessageSender(null, async () => "");
    await expect(sender.sendReply({ replyToProviderMessageId: "g1", providerThreadId: "x", from: "me", to: [], cc: [], subject: "", inReplyTo: null, body: "hey" })).rejects.toThrow(/No one to text/);
  });
});
