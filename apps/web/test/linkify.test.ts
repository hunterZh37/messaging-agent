import { describe, it, expect } from "vitest";
import { linkLabel, linkSegments } from "../lib/linkify";

describe("linkSegments", () => {
  it("turns a bracketed label and its URL into one link", () => {
    expect(linkSegments("Follow us [Instagram]<https://x.example.com/a/b> today")).toEqual([
      { kind: "text", text: "Follow us " },
      { kind: "link", text: "Instagram", href: "https://x.example.com/a/b" },
      { kind: "text", text: " today" },
    ]);
  });

  it("links the word glued to a URL, and a name to its mailto", () => {
    expect(linkSegments("Share on X<https://x.example.com/s> | Victoria<mailto:v@example.com>")).toEqual([
      { kind: "text", text: "Share on " },
      { kind: "link", text: "X", href: "https://x.example.com/s" },
      { kind: "text", text: " | " },
      { kind: "link", text: "Victoria", href: "mailto:v@example.com" },
    ]);
  });

  it("shows a bare URL as its host, with or without angle brackets", () => {
    expect(linkSegments("<https://www.example.com/long/path?x=1>\nhttps://docs.google.com/d/abc.")).toEqual([
      { kind: "link", text: "example.com", href: "https://www.example.com/long/path?x=1" },
      { kind: "text", text: "\n" },
      { kind: "link", text: "docs.google.com", href: "https://docs.google.com/d/abc" },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves text without links alone and refuses other schemes", () => {
    expect(linkSegments("plain words")).toEqual([{ kind: "text", text: "plain words" }]);
    expect(linkSegments("run<javascript:alert(1)>")).toEqual([{ kind: "text", text: "run<javascript:alert(1)>" }]);
  });

  it("names a link by its host", () => {
    expect(linkLabel("https://ee5e595f.click.convertkit-mail.com/x/y")).toBe("ee5e595f.click.convertkit-mail.com");
    expect(linkLabel("mailto:a@b.co")).toBe("a@b.co");
  });
});
