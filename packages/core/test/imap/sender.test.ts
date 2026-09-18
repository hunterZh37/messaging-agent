import { describe, it, expect } from "vitest";
import { FakeSmtpClient } from "../helpers/fakeImap";
import { imapSender } from "../../src/imap/sender";

const reply = {
  replyToProviderMessageId: "INBOX:2",
  providerThreadId: "<root@x>",
  from: "me@example.com",
  to: ["bob@x.com"],
  cc: ["carol@x.com"],
  subject: "Re: Lunch",
  inReplyTo: "<m2@x>",
  body: "Yes, Friday.",
};

describe("imapSender", () => {
  it("sends over SMTP with threading headers and returns the server's message id", async () => {
    const smtp = new FakeSmtpClient();

    const r = await imapSender(smtp).sendReply(reply);

    expect(r.id).toBe("<sent-1@example.com>");
    expect(smtp.sent[0]).toEqual({
      from: "me@example.com",
      to: ["bob@x.com"],
      cc: ["carol@x.com"],
      subject: "Re: Lunch",
      text: "Yes, Friday.",
      inReplyTo: "<m2@x>",
      references: "<m2@x>",
    });
  });

  it("leaves the threading headers unset for a message with no parent", async () => {
    const smtp = new FakeSmtpClient();

    await imapSender(smtp).sendReply({ ...reply, inReplyTo: null });

    expect(smtp.sent[0]?.inReplyTo).toBeNull();
    expect(smtp.sent[0]?.references).toBeNull();
  });

  it("hands the draft's files to nodemailer as attachments", async () => {
    const smtp = new FakeSmtpClient();

    await imapSender(smtp).sendReply({
      ...reply,
      attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4") }],
    });

    expect(smtp.sent[0]?.attachments).toEqual([{ filename: "invoice.pdf", content: Buffer.from("%PDF-1.4"), contentType: "application/pdf" }]);
  });

  it("sends a reply with no files without an attachments field at all", async () => {
    const smtp = new FakeSmtpClient();

    await imapSender(smtp).sendReply({ ...reply, attachments: [] });

    expect(smtp.sent[0]).not.toHaveProperty("attachments");
  });

  it("rejects an invalid recipient before anything reaches the server", async () => {
    const smtp = new FakeSmtpClient();

    await expect(imapSender(smtp).sendReply({ ...reply, to: ["not an address"] })).rejects.toThrow(/invalid recipient/);
    expect(smtp.sent).toHaveLength(0);
  });
});
