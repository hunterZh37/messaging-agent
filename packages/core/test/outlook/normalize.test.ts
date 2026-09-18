import { describe, it, expect } from "vitest";
import { normalizeGraphMessage } from "../../src/outlook/normalize";
import type { GraphMessage } from "../../src/outlook/types";

describe("normalizeGraphMessage", () => {
  it("strips html bodies, lowercases addresses, keeps names, and lists attachments", () => {
    const raw: GraphMessage = {
      id: "m1",
      conversationId: "conv1",
      internetMessageId: "<m1@mail.example.com>",
      subject: "Lunch?",
      bodyPreview: "Hello there",
      body: { contentType: "html", content: "<p>Hello there</p><p>Lunch Friday?</p>" },
      from: { emailAddress: { address: "Bob@Example.com", name: "Bob Smith" } },
      toRecipients: [
        { emailAddress: { address: "Me@Example.com", name: "Me" } },
        { emailAddress: { address: "Carol@Example.com", name: "Carol" } },
      ],
      ccRecipients: [{ emailAddress: { address: "Dave@Example.com", name: "Dave" } }],
      receivedDateTime: "2024-09-06T00:00:00Z",
      sentDateTime: "2024-09-06T00:00:00Z",
      hasAttachments: true,
      attachments: [
        { id: "att1", name: "menu.pdf", size: 1200, contentType: "Application/PDF" },
        { id: "att2", name: "receipt.png", size: 900, contentType: "image/png" },
      ],
      categories: ["agent/important"],
      isDraft: false,
    };
    const n = normalizeGraphMessage(raw);
    expect(n.providerMessageId).toBe("m1");
    expect(n.providerThreadId).toBe("conv1");
    expect(n.rfcMessageId).toBe("<m1@mail.example.com>");
    expect(n.fromAddress).toBe("bob@example.com");
    expect(n.fromName).toBe("Bob Smith");
    expect(n.toAddresses).toEqual(["me@example.com", "carol@example.com"]);
    expect(n.ccAddresses).toEqual(["dave@example.com"]);
    expect(n.subject).toBe("Lunch?");
    expect(n.bodyText).toBe("Hello there\n\nLunch Friday?");
    expect(n.snippet).toBe("Hello there");
    expect(n.attachmentNames).toEqual(["menu.pdf", "receipt.png"]);
    expect(n.attachments).toEqual([
      { index: 0, filename: "menu.pdf", mimeType: "application/pdf", size: 1200, providerAttachmentId: "att1", bytes: null },
      { index: 1, filename: "receipt.png", mimeType: "image/png", size: 900, providerAttachmentId: "att2", bytes: null },
    ]);
    expect(n.sentAt).toBe(Date.parse("2024-09-06T00:00:00Z"));
    expect(n.labelIds).toEqual(["agent/important"]);
    expect(n.bodyHtml).toBe("<p>Hello there</p><p>Lunch Friday?</p>");
  });

  it("keeps a plain-text body as-is and falls back to the message id when there is no conversationId", () => {
    const raw: GraphMessage = {
      id: "m2",
      internetMessageId: "<m2@mail.example.com>",
      subject: "Quick note",
      body: { contentType: "text", content: "just text" },
      from: { emailAddress: { address: "bob@example.com" } },
      toRecipients: [],
      ccRecipients: [],
      sentDateTime: "2024-09-06T01:00:00Z",
    };
    const n = normalizeGraphMessage(raw);
    expect(n.providerThreadId).toBe("m2");
    expect(n.bodyText).toBe("just text");
    expect(n.fromName).toBeNull();
    expect(n.toAddresses).toEqual([]);
    expect(n.attachmentNames).toEqual([]);
    expect(n.snippet).toBeNull();
    expect(n.labelIds).toEqual([]);
    expect(n.bodyHtml).toBeNull();
  });

  it("falls back to receivedDateTime when sentDateTime is absent, and to 0 when both are missing", () => {
    const base: GraphMessage = { id: "m3", body: { contentType: "text", content: "x" } };
    expect(normalizeGraphMessage({ ...base, receivedDateTime: "2024-01-01T00:00:00Z" }).sentAt).toBe(Date.parse("2024-01-01T00:00:00Z"));
    expect(normalizeGraphMessage(base).sentAt).toBe(0);
  });

  it("sanitizes an html body before storing it as bodyHtml", () => {
    const raw: GraphMessage = {
      id: "m4",
      body: { contentType: "html", content: '<p onclick="alert(1)">Hi</p><script>alert(2)</script>' },
      toRecipients: [],
      ccRecipients: [],
    };
    const n = normalizeGraphMessage(raw);
    expect(n.bodyHtml).not.toBeNull();
    expect(n.bodyHtml).not.toContain("onclick");
    expect(n.bodyHtml).not.toContain("<script");
    expect(n.bodyHtml).toContain("Hi");
  });

  it("drops inline attachments under 20 KB and renumbers the rest", () => {
    const n = normalizeGraphMessage({
      id: "m3",
      body: { contentType: "text", content: "hi" },
      from: { emailAddress: { address: "bob@example.com" } },
      sentDateTime: "2024-09-06T00:00:00Z",
      attachments: [
        { id: "sig", name: "sig.png", size: 900, contentType: "image/png", isInline: true },
        { id: "big", name: "chart.png", size: 20480, contentType: "image/png", isInline: true },
        { id: "doc", name: "menu.pdf", size: 10, contentType: "application/pdf" },
      ],
    });
    expect(n.attachmentNames).toEqual(["chart.png", "menu.pdf"]);
    expect(n.attachments.map((a) => [a.index, a.providerAttachmentId])).toEqual([
      [0, "big"],
      [1, "doc"],
    ]);
  });

  it("names an unnamed attachment attachment-<index> and falls back to octet-stream", () => {
    const n = normalizeGraphMessage({
      id: "m4",
      body: { contentType: "text", content: "hi" },
      from: { emailAddress: { address: "bob@example.com" } },
      sentDateTime: "2024-09-06T00:00:00Z",
      attachments: [{ id: "a", size: 5 }],
    });
    expect(n.attachments[0]).toMatchObject({ filename: "attachment-0", mimeType: "application/octet-stream" });
    expect(n.attachmentNames).toEqual(["attachment-0"]);
  });

  it("drops a nameless text/* part, which is a body alternative rather than a file", () => {
    const n = normalizeGraphMessage({
      id: "m5",
      body: { contentType: "text", content: "hi" },
      from: { emailAddress: { address: "bob@example.com" } },
      sentDateTime: "2024-09-06T00:00:00Z",
      attachments: [
        { id: "amp", size: 139_000, contentType: "text/x-amp-html" },
        { id: "doc", name: "menu.pdf", size: 10, contentType: "application/pdf" },
      ],
    });
    expect(n.attachmentNames).toEqual(["menu.pdf"]);
    expect(n.attachments.map((a) => a.index)).toEqual([0]);
  });
});

describe("read state", () => {
  const raw = (extra: Partial<GraphMessage>): GraphMessage => ({ id: "m1", from: { emailAddress: { address: "bob@example.com" } }, sentDateTime: "2024-09-06T00:00:00Z", ...extra });
  it("carries isRead through as read, and says nothing when Graph did not (2026-09-14)", () => {
    expect(normalizeGraphMessage(raw({ isRead: true })).read).toBe(true);
    expect(normalizeGraphMessage(raw({ isRead: false })).read).toBe(false);
    expect(normalizeGraphMessage(raw({}))).not.toHaveProperty("read");
  });
});
