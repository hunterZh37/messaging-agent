import { describe, it, expect } from "vitest";
import { asksSomething, splitQuoted, stripQuoted } from "../../src/text/quoted";

describe("stripQuoted", () => {
  it("keeps a message that quotes nothing", () => {
    expect(stripQuoted("Could you send the deck?\n\nThanks,\nHunter")).toBe("Could you send the deck?\n\nThanks,\nHunter");
  });

  it("cuts at an On … wrote: line", () => {
    const text = ["Sounds good.", "", "On Mon, 1 Sep 2026 at 09:00, Bob <bob@x.com> wrote:", "Can you confirm the time?"].join("\n");
    expect(stripQuoted(text)).toBe("Sounds good.");
  });

  it("cuts at a forwarded From: header", () => {
    const text = ["Passing this on.", "", "From: Bob <bob@x.com>", "Subject: Deck", "Any thoughts?"].join("\n");
    expect(stripQuoted(text)).toBe("Passing this on.");
  });

  it("cuts at an Original Message separator", () => {
    const text = ["No problem.", "-----Original Message-----", "Would you mind sending it?"].join("\n");
    expect(stripQuoted(text)).toBe("No problem.");
  });

  it("cuts at quoted lines", () => {
    const text = ["Agreed.", "", "> what do you think?", "> let me know"].join("\n");
    expect(stripQuoted(text)).toBe("Agreed.");
  });

  it("returns an empty string when the message is only quoted text", () => {
    expect(stripQuoted("> can you confirm?")).toBe("");
  });
});

describe("asksSomething", () => {
  it("is false for a plain thank-you", () => {
    expect(asksSomething("Thanks!")).toBe(false);
  });

  it("is true for a question mark", () => {
    expect(asksSomething("Are we still on for Tuesday")).toBe(false);
    expect(asksSomething("Are we still on for Tuesday?")).toBe(true);
  });

  it("is true for a request phrase without a question mark", () => {
    expect(asksSomething("Could you send the deck")).toBe(true);
    expect(asksSomething("Please confirm the address")).toBe(true);
    expect(asksSomething("Let me know when the invoice is out")).toBe(true);
  });

  it("is false for a statement that merely mentions a reply", () => {
    expect(asksSomething("I have replied to the vendor and closed the ticket.")).toBe(false);
  });

  it("ignores quoted text when the caller strips it first", () => {
    const sent = ["Done, shipped this morning.", "", "> could you ship it today?"].join("\n");
    expect(asksSomething(stripQuoted(sent))).toBe(false);
  });
});

describe("splitQuoted", () => {
  it("cuts at a bare From:, which is how some clients start a header block", () => {
    // The label and the name land in separate elements, so the line is "From:"
    // alone once the HTML is text. Requiring a name after it kept the history.
    const body = ["Please ignore it, thank you.", "", "From:", "Joscelyn Grotenhuis", "Date: Thursday", "To: Hunter"].join("\n");
    expect(splitQuoted(body).own).toBe("Please ignore it, thank you.");
    expect(splitQuoted(body).quoted).toContain("Joscelyn Grotenhuis");
  });

  it("hands back what the sender typed and the history under it", () => {
    const body = ["Friday works for me.", "", "On Mon, 1 Sep 2026 at 09:12, Carol wrote:", "> Does Friday suit?"].join("\n");
    expect(splitQuoted(body)).toEqual({
      own: "Friday works for me.",
      quoted: "On Mon, 1 Sep 2026 at 09:12, Carol wrote:\n> Does Friday suit?",
    });
  });

  it("has no history to hand back when nothing is quoted", () => {
    expect(splitQuoted("  Just a note.  ")).toEqual({ own: "Just a note.", quoted: "" });
  });

  it("says so when a message is nothing but history", () => {
    // A bare forward: the caller shows the quoted part rather than nothing.
    const body = "-----Original Message-----\nFrom: bob@x.com\nThe invoice is attached.";
    expect(splitQuoted(body).own).toBe("");
    expect(splitQuoted(body).quoted).toContain("The invoice is attached.");
  });

  it("agrees with stripQuoted, which is the same cut", () => {
    const body = "Yes.\n\nFrom: bob@x.com\n> anything";
    expect(splitQuoted(body).own).toBe(stripQuoted(body));
  });
});
