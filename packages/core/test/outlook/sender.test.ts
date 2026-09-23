import { describe, it, expect } from "vitest";
import { FakeOutlookClient } from "../helpers/fakeOutlook";
import { outlookSender } from "../../src/outlook/sender";

describe("outlookSender", () => {
  it("creates a reply draft, updates it with the operator-approved recipients and body, then sends it, in that order", async () => {
    const client = new FakeOutlookClient();
    const calls: string[] = [];
    const originalCreateReply = client.createReply.bind(client);
    const originalUpdateDraft = client.updateDraft.bind(client);
    const originalSendDraft = client.sendDraft.bind(client);
    client.createReply = async (id) => { calls.push("createReply"); return originalCreateReply(id); };
    client.updateDraft = async (id, p) => { calls.push("updateDraft"); return originalUpdateDraft(id, p); };
    client.sendDraft = async (id) => { calls.push("sendDraft"); return originalSendDraft(id); };

    const sender = outlookSender(client);
    const r = await sender.sendReply({
      replyToProviderMessageId: "m2",
      providerThreadId: "t1",
      from: "me@example.com",
      to: ["bob@x.com"],
      cc: ["carol@x.com"],
      subject: "Re: Lunch",
      inReplyTo: "<m2@x>",
      body: "Yes, Friday.",
    });

    expect(calls).toEqual(["createReply", "updateDraft", "sendDraft"]);
    expect(r.id).toBe("draft_1");
    const draft = client.drafts.get("draft_1")!;
    expect(draft.forMessageId).toBe("m2");
    expect(draft.body).toBe("Yes, Friday.");
    expect(draft.to).toEqual(["bob@x.com"]);
    expect(draft.cc).toEqual(["carol@x.com"]);
    expect(draft.sent).toBe(true);
  });

  it("puts every file on the draft before it sends, and never after", async () => {
    const client = new FakeOutlookClient();
    const calls: string[] = [];
    const originalAddAttachment = client.addAttachment.bind(client);
    const originalSendDraft = client.sendDraft.bind(client);
    client.addAttachment = async (id, file) => { calls.push(`add:${file.filename}`); return originalAddAttachment(id, file); };
    client.sendDraft = async (id) => { calls.push("sendDraft"); return originalSendDraft(id); };

    await outlookSender(client).sendReply({
      replyToProviderMessageId: "m2",
      providerThreadId: "t1",
      from: "me@example.com",
      to: ["bob@x.com"],
      cc: [],
      subject: "Re: Lunch",
      inReplyTo: "<m2@x>",
      body: "Attached.",
      attachments: [
        { filename: "invoice.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4") },
        { filename: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("hello") },
      ],
    });

    expect(calls).toEqual(["add:invoice.pdf", "add:notes.txt", "sendDraft"]);
    expect(client.drafts.get("draft_1")?.attachments.map((a) => a.filename)).toEqual(["invoice.pdf", "notes.txt"]);
  });
});

/** A message with nothing above it (compose, 2026-09-22): createMessage instead of createReply. */
describe("outlookSender.sendNew", () => {
  it("creates a fresh draft, updates it with the recipients and body, then sends it, in that order", async () => {
    const client = new FakeOutlookClient();
    const calls: string[] = [];
    const originalCreateMessage = client.createMessage.bind(client);
    const originalUpdateDraft = client.updateDraft.bind(client);
    const originalSendDraft = client.sendDraft.bind(client);
    client.createMessage = async (p) => { calls.push("createMessage"); return originalCreateMessage(p); };
    client.updateDraft = async (id, p) => { calls.push("updateDraft"); return originalUpdateDraft(id, p); };
    client.sendDraft = async (id) => { calls.push("sendDraft"); return originalSendDraft(id); };

    const sender = outlookSender(client);
    const r = await sender.sendNew!({
      from: "me@example.com",
      to: ["bob@x.com"],
      cc: ["carol@x.com"],
      subject: "Let's talk",
      body: "Hi Bob,",
    });

    expect(calls).toEqual(["createMessage", "updateDraft", "sendDraft"]);
    expect(r.id).toBe("draft_1");
    const draft = client.drafts.get("draft_1")!;
    expect(draft.forMessageId).toBeNull();
    expect(draft.subject).toBe("Let's talk");
    expect(draft.body).toBe("Hi Bob,");
    expect(draft.to).toEqual(["bob@x.com"]);
    expect(draft.cc).toEqual(["carol@x.com"]);
    expect(draft.sent).toBe(true);
  });

  it("puts every file on the draft before it sends, in the operator's order", async () => {
    const client = new FakeOutlookClient();
    const calls: string[] = [];
    const originalCreateMessage = client.createMessage.bind(client);
    const originalAddAttachment = client.addAttachment.bind(client);
    const originalSendDraft = client.sendDraft.bind(client);
    client.createMessage = async (p) => { calls.push("createMessage"); return originalCreateMessage(p); };
    client.addAttachment = async (id, file) => { calls.push(`add:${file.filename}`); return originalAddAttachment(id, file); };
    client.sendDraft = async (id) => { calls.push("sendDraft"); return originalSendDraft(id); };

    await outlookSender(client).sendNew!({
      from: "me@example.com",
      to: ["bob@x.com"],
      cc: [],
      subject: "Let's talk",
      body: "Attached.",
      attachments: [
        { filename: "invoice.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4") },
        { filename: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("hello") },
      ],
    });

    expect(calls).toEqual(["createMessage", "add:invoice.pdf", "add:notes.txt", "sendDraft"]);
    expect(client.drafts.get("draft_1")?.attachments.map((a) => a.filename)).toEqual(["invoice.pdf", "notes.txt"]);
  });

  it("passes the marked HTML through, when there is any", async () => {
    const client = new FakeOutlookClient();
    await outlookSender(client).sendNew!({
      from: "me@example.com",
      to: ["bob@x.com"],
      cc: [],
      subject: "Let's talk",
      body: "Hi Bob,",
      html: "<p>Hi <strong>Bob</strong>,</p>",
    });
    const draft = client.drafts.get("draft_1")!;
    expect(draft.body).toBe("Hi Bob,");
    expect(draft.html).toBe("<p>Hi <strong>Bob</strong>,</p>");
  });
});
