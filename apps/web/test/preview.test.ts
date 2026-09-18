import { describe, it, expect } from "vitest";
import { previewHeader } from "../lib/preview";

const view = (over: Partial<{ email: string; displayName: string | null; replySubject: string }> = {}) => ({
  account: { email: over.email ?? "me@example.com", displayName: over.displayName ?? null },
  replySubject: over.replySubject ?? "Re: Lunch",
});

describe("previewHeader", () => {
  it("names the account the reply goes from", () => {
    expect(previewHeader(view(), ["bob@x.com"], []).from).toBe("me@example.com");
  });

  it("puts the account's display name in front of the address, as a mail client does", () => {
    expect(previewHeader(view({ displayName: "Robin Doe" }), ["bob@x.com"], []).from).toBe("Robin Doe <me@example.com>");
  });

  it("ignores a display name that is only spaces", () => {
    expect(previewHeader(view({ displayName: "   " }), ["bob@x.com"], []).from).toBe("me@example.com");
  });

  it("lists every recipient, and leaves Cc out when there is none", () => {
    const h = previewHeader(view(), ["bob@x.com", "kim@x.com"], []);
    expect(h.to).toBe("bob@x.com, kim@x.com");
    expect(h.cc).toBeNull();
  });

  it("shows Cc when there is one", () => {
    expect(previewHeader(view(), ["bob@x.com"], ["kim@x.com"]).cc).toBe("kim@x.com");
  });

  it("says so rather than showing a blank To", () => {
    expect(previewHeader(view(), [], []).to).toBe("(nobody)");
  });

  it("shows the subject the send will set, and says when there is none", () => {
    expect(previewHeader(view({ replySubject: "Re: Invoice 42" }), ["bob@x.com"], []).subject).toBe("Re: Invoice 42");
    expect(previewHeader(view({ replySubject: "" }), ["bob@x.com"], []).subject).toBe("(no subject)");
  });

  it("dates the mail in words, so the server and the browser cannot disagree", () => {
    expect(previewHeader(view(), ["bob@x.com"], []).date).toBe("Today, now");
  });
});
