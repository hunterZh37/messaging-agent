import { describe, it, expect } from "vitest";
import { normalizeImapMessage } from "../../src/imap/normalize";
import type { ImapMessage } from "../../src/imap/types";

const CRLF = "\r\n";

/** A small but real RFC822 message: multipart/mixed > multipart/alternative + one attachment, with Cc. */
function rawSource(overrides: { messageId?: string; references?: string; inReplyTo?: string } = {}): Buffer {
  const lines = [
    "From: Bob Smith <Bob@Example.com>",
    "To: me@example.com, Carol <CAROL@example.com>",
    "Cc: dave@example.com",
    "Subject: Lunch?",
    "Date: Fri, 06 Sep 2024 10:00:00 +0000",
    `Message-ID: ${overrides.messageId ?? "<m1@mail.example.com>"}`,
    ...(overrides.references ? [`References: ${overrides.references}`] : []),
    ...(overrides.inReplyTo ? [`In-Reply-To: ${overrides.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="OUTER"',
    "",
    "--OUTER",
    'Content-Type: multipart/alternative; boundary="INNER"',
    "",
    "--INNER",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello there",
    "",
    "Lunch Friday?",
    "--INNER",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Hello there</p><p>Lunch Friday?</p>",
    "--INNER--",
    "--OUTER",
    "Content-Type: application/pdf; name=\"menu.pdf\"",
    "Content-Disposition: attachment; filename=\"menu.pdf\"",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 fake").toString("base64"),
    "--OUTER--",
    "",
  ];
  return Buffer.from(lines.join(CRLF), "utf8");
}

function msg(p: Partial<ImapMessage> = {}): ImapMessage {
  return { uid: 42, source: rawSource(), ...p };
}

describe("normalizeImapMessage", () => {
  it("parses headers, prefers the text/plain part, and lists attachments", async () => {
    const n = await normalizeImapMessage(msg(), "INBOX");
    expect(n.providerMessageId).toBe("INBOX:42");
    expect(n.rfcMessageId).toBe("<m1@mail.example.com>");
    expect(n.fromAddress).toBe("bob@example.com");
    expect(n.fromName).toBe("Bob Smith");
    expect(n.toAddresses).toEqual(["me@example.com", "carol@example.com"]);
    expect(n.ccAddresses).toEqual(["dave@example.com"]);
    expect(n.subject).toBe("Lunch?");
    expect(n.bodyText).toBe("Hello there\n\nLunch Friday?");
    expect(n.snippet).toBe("Hello there\n\nLunch Friday?");
    expect(n.attachmentNames).toEqual(["menu.pdf"]);
    expect(n.attachments).toEqual([
      {
        index: 0,
        filename: "menu.pdf",
        mimeType: "application/pdf",
        size: Buffer.from("%PDF-1.4 fake").length,
        providerAttachmentId: null,
        bytes: Buffer.from("%PDF-1.4 fake"),
      },
    ]);
    expect(n.sentAt).toBe(Date.parse("Fri, 06 Sep 2024 10:00:00 +0000"));
    expect(n.labelIds).toEqual([]);
    expect(n.bodyHtml).toBe("<p>Hello there</p><p>Lunch Friday?</p>");
  });

  it("sanitizes the html part before storing it as bodyHtml", async () => {
    const source = Buffer.from(
      [
        "From: bob@example.com",
        "To: me@example.com",
        "Subject: Scripted",
        "Message-ID: <s1@x>",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p onclick="alert(1)">Hi</p><script>alert(2)</script>',
        "",
      ].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage({ uid: 20, source }, "INBOX");
    expect(n.bodyHtml).not.toBeNull();
    expect(n.bodyHtml).not.toContain("onclick");
    expect(n.bodyHtml).not.toContain("<script");
    expect(n.bodyHtml).toContain("Hi");
  });

  it("sets bodyHtml to null when the message has no genuine html part", async () => {
    const source = Buffer.from(
      ["From: bob@example.com", "To: me@example.com", "Subject: Plain", "Message-ID: <p2@x>", "", "Just text", ""].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage({ uid: 21, source }, "INBOX");
    expect(n.bodyHtml).toBeNull();
  });

  it("sets bodyHtml to null when the html-looking part is really a mislabeled text/plain body", async () => {
    const source = Buffer.from(
      [
        "From: invoices@bill.com",
        "To: me@example.com",
        "Subject: Invoice",
        "Message-ID: <inv2@x>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Invoice: 08/30<br>Amount: $1,060",
        "",
      ].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage({ uid: 22, source }, "INBOX");
    expect(n.bodyHtml).toBeNull();
  });

  it("uses the folder path in the provider id so Inbox and Sent uids never collide", async () => {
    const inbox = await normalizeImapMessage(msg({ uid: 7 }), "INBOX");
    const sent = await normalizeImapMessage(msg({ uid: 7 }), "[Gmail]/Sent Mail");
    expect(inbox.providerMessageId).toBe("INBOX:7");
    expect(sent.providerMessageId).toBe("[Gmail]/Sent Mail:7");
  });

  it("prefers Gmail's thread id and labels when the server supplied them", async () => {
    const n = await normalizeImapMessage(msg({ gmailThreadId: "thr-9", gmailLabels: ["\\Inbox", "agent/important"] }), "INBOX");
    expect(n.providerThreadId).toBe("thr-9");
    expect(n.labelIds).toEqual(["\\Inbox", "agent/important"]);
  });

  it("threads on the first References id, then In-Reply-To, then its own Message-ID", async () => {
    const withRefs = await normalizeImapMessage(
      { uid: 1, source: rawSource({ references: "<root@x> <mid@x>", inReplyTo: "<mid@x>" }) },
      "INBOX",
    );
    expect(withRefs.providerThreadId).toBe("<root@x>");

    const withInReplyTo = await normalizeImapMessage({ uid: 2, source: rawSource({ inReplyTo: "<mid@x>" }) }, "INBOX");
    expect(withInReplyTo.providerThreadId).toBe("<mid@x>");

    const standalone = await normalizeImapMessage({ uid: 3, source: rawSource() }, "INBOX");
    expect(standalone.providerThreadId).toBe("<m1@mail.example.com>");
  });

  it("falls back to stripped html when there is no text/plain part", async () => {
    const source = Buffer.from(
      [
        "From: bob@example.com",
        "To: me@example.com",
        "Subject: HTML only",
        "Date: Fri, 06 Sep 2024 10:00:00 +0000",
        "Message-ID: <h1@x>",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Hi <b>Bob</b></p><br>Bye",
        "",
      ].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage({ uid: 5, source }, "INBOX");
    expect(n.bodyText).toBe("Hi Bob\n\nBye");
  });

  it("strips markup out of a text/plain part that is really HTML", async () => {
    // Some senders (Bill.com invoices, for one) label an HTML body text/plain.
    const source = Buffer.from(
      [
        "From: invoices@bill.com",
        "To: me@example.com",
        "Subject: Invoice",
        "Message-ID: <inv1@x>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Invoice: 08/30<br>Amount: $1,060<br><table cellspacing='0'><tr><td>x</td></tr></table>",
        "",
      ].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage({ uid: 11, source }, "INBOX");
    expect(n.bodyText).not.toContain("<");
    expect(n.bodyText).toContain("Invoice: 08/30");
    expect(n.bodyText).toContain("Amount: $1,060");
    expect(n.bodyText.split("\n")[0]).toBe("Invoice: 08/30");
    expect(n.bodyText).toMatch(/Invoice: 08\/30\nAmount: \$1,060/);
    expect(n.snippet).toBe(n.bodyText.slice(0, 200));
  });

  it("prefers the stripped html part when a message carries both bodies", async () => {
    const n = await normalizeImapMessage(msg(), "INBOX");
    expect(n.bodyText).toBe("Hello there\n\nLunch Friday?");
  });

  it("leaves a genuine plain-text body alone", async () => {
    const source = Buffer.from(
      [
        "From: bob@example.com",
        "To: me@example.com",
        "Subject: Plain",
        "Message-ID: <p1@x>",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hi Hunter,",
        "",
        "Friday works. 3 < 5 and 10 > 2.",
        "",
        "Bob",
        "",
      ].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage({ uid: 12, source }, "INBOX");
    expect(n.bodyText).toBe("Hi Hunter,\n\nFriday works. 3 < 5 and 10 > 2.\n\nBob");
  });

  it("collapses runs of blank lines in a plain-text body", async () => {
    const source = Buffer.from(
      ["From: bob@example.com", "To: me@example.com", "Subject: Gaps", "Message-ID: <g1@x>", "", "One", "", "", "", "Two", ""].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage({ uid: 13, source }, "INBOX");
    expect(n.bodyText).toBe("One\n\nTwo");
  });

  it("caps the snippet at 200 characters", async () => {
    const body = "x".repeat(500);
    const source = Buffer.from(
      ["From: bob@example.com", "To: me@example.com", "Subject: Long", "Message-ID: <l1@x>", "", body, ""].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage({ uid: 6, source }, "INBOX");
    expect(n.snippet).toHaveLength(200);
    expect(n.bodyText).toHaveLength(500);
  });

  it("falls back to the clock when the message carries no Date header", async () => {
    const source = Buffer.from(
      ["From: bob@example.com", "To: me@example.com", "Subject: No date", "Message-ID: <d1@x>", "", "body", ""].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage({ uid: 8, source }, "INBOX", () => 1234);
    expect(n.sentAt).toBe(1234);
  });
});

/** multipart/mixed with one inline part of `inlineBytes` and one real attachment. */
function sourceWithInline(inlineBytes: number): Buffer {
  const inline = Buffer.alloc(inlineBytes, 7);
  const lines = [
    "From: bob@example.com",
    "To: me@example.com",
    "Subject: Signed",
    "Message-ID: <i1@x>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="OUTER"',
    "",
    "--OUTER",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body",
    "--OUTER",
    'Content-Type: image/png; name="sig.png"',
    'Content-Disposition: inline; filename="sig.png"',
    "Content-Transfer-Encoding: base64",
    "",
    inline.toString("base64"),
    "--OUTER",
    'Content-Type: application/pdf; name="menu.pdf"',
    'Content-Disposition: attachment; filename="menu.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 fake").toString("base64"),
    "--OUTER--",
    "",
  ];
  return Buffer.from(lines.join(CRLF), "utf8");
}

describe("normalizeImapMessage attachments", () => {
  it("drops inline parts under 20 KB from both lists and renumbers what is kept", async () => {
    const n = await normalizeImapMessage(msg({ source: sourceWithInline(1024) }), "INBOX");
    expect(n.attachmentNames).toEqual(["menu.pdf"]);
    expect(n.attachments.map((a) => ({ index: a.index, filename: a.filename }))).toEqual([{ index: 0, filename: "menu.pdf" }]);
  });

  it("keeps inline parts of 20 KB and over", async () => {
    const n = await normalizeImapMessage(msg({ source: sourceWithInline(20480) }), "INBOX");
    expect(n.attachmentNames).toEqual(["sig.png", "menu.pdf"]);
    expect(n.attachments.map((a) => a.index)).toEqual([0, 1]);
    expect(n.attachments[0]).toMatchObject({ filename: "sig.png", mimeType: "image/png", size: 20480 });
    expect(n.attachments[0]!.bytes).toHaveLength(20480);
  });

  it("names an unnamed part attachment-<index> and falls back to octet-stream", async () => {
    const source = Buffer.from(
      [
        "From: bob@example.com",
        "To: me@example.com",
        "Subject: Nameless",
        "Message-ID: <n1@x>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="OUTER"',
        "",
        "--OUTER",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Body",
        "--OUTER",
        "Content-Type: application/octet-stream",
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("raw bytes").toString("base64"),
        "--OUTER--",
        "",
      ].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage(msg({ source }), "INBOX");
    expect(n.attachments[0]).toMatchObject({ index: 0, filename: "attachment-0", mimeType: "application/octet-stream" });
    expect(n.attachmentNames).toEqual(["attachment-0"]);
  });
});

describe("normalizeImapMessage body alternatives", () => {
  it("drops a nameless text/x-amp-html part instead of storing it as attachment-0", async () => {
    const amp = "<html amp4email>" + "x".repeat(2000) + "</html>";
    const source = Buffer.from(
      [
        "From: bob@example.com",
        "To: me@example.com",
        "Subject: Amp",
        "Message-ID: <amp1@x>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="ALT"',
        "",
        "--ALT",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Plain body",
        "--ALT",
        "Content-Type: text/x-amp-html; charset=utf-8",
        "",
        amp,
        "--ALT",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Plain body</p>",
        "--ALT--",
        "",
      ].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage(msg({ source }), "INBOX");
    expect(n.attachments).toEqual([]);
    expect(n.attachmentNames).toEqual([]);
    expect(n.bodyText).toContain("Plain body");
  });

  it("still keeps a named text file the sender really attached", async () => {
    const source = Buffer.from(
      [
        "From: bob@example.com",
        "To: me@example.com",
        "Subject: Notes",
        "Message-ID: <txt1@x>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="OUTER"',
        "",
        "--OUTER",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "See notes",
        "--OUTER",
        'Content-Type: text/plain; name="notes.txt"',
        'Content-Disposition: attachment; filename="notes.txt"',
        "",
        "the notes",
        "--OUTER--",
        "",
      ].join(CRLF),
      "utf8",
    );
    const n = await normalizeImapMessage(msg({ source }), "INBOX");
    expect(n.attachmentNames).toEqual(["notes.txt"]);
  });
});
