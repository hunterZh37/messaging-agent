import { describe, it, expect } from "vitest";
import { hasMarkup, markupSpans, markupToHtml, stripMarkup } from "../../src/text/markup";

/**
 * The two marks a reply is allowed (operator, 2026-09-20). What matters most
 * here is that nobody is ever shown the asterisks: a reader on HTML sees
 * emphasis, a reader on plain text sees the words, and neither sees the marks.
 */
describe("stripping the marks", () => {
  it("leaves the words and takes the marks", () => {
    expect(stripMarkup("send the **signed** copy before __Friday__")).toBe("send the signed copy before Friday");
  });

  it("leaves a lone asterisk or underscore alone", () => {
    expect(stripMarkup("a * b and snake_case_name")).toBe("a * b and snake_case_name");
  });

  it("leaves an empty pair alone, which is somebody typing, not marking", () => {
    expect(stripMarkup("**")).toBe("**");
    expect(stripMarkup("____")).toBe("____");
  });

  it("says whether there is anything to strip", () => {
    expect(hasMarkup("plain words")).toBe(false);
    expect(hasMarkup("a **mark**")).toBe(true);
    expect(hasMarkup("an __underline__")).toBe(true);
  });
});

describe("the HTML part", () => {
  it("marks bold and underline", () => {
    expect(markupToHtml("the **signed** copy")).toBe("<p>the <strong>signed</strong> copy</p>");
    expect(markupToHtml("by __Friday__")).toBe("<p>by <u>Friday</u></p>");
  });

  /** A draft that mentions a tag must say it, not make one. */
  it("escapes before it marks", () => {
    expect(markupToHtml("use <div> & \"quotes\"")).toBe('<p>use &lt;div&gt; &amp; &quot;quotes&quot;</p>');
  });

  it("cannot be talked into a tag through the marks", () => {
    expect(markupToHtml("**<script>alert(1)</script>**")).toBe("<p><strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong></p>");
  });

  it("makes a paragraph of a blank line and a break of a single one", () => {
    expect(markupToHtml("Hi there\nsecond line\n\nNew paragraph")).toBe("<p>Hi there<br>second line</p>\n<p>New paragraph</p>");
  });

  it("drops the empty blocks trailing whitespace leaves behind", () => {
    expect(markupToHtml("One\n\n\n\nTwo")).toBe("<p>One</p>\n<p>Two</p>");
  });
});

describe("the draft as spans, for a card that draws it", () => {
  it("splits the marked from the unmarked", () => {
    expect(markupSpans("send the **signed** copy")).toEqual([
      { text: "send the ", bold: false, underline: false },
      { text: "signed", bold: true, underline: false },
      { text: " copy", bold: false, underline: false },
    ]);
  });

  it("puts plain text through as one span", () => {
    expect(markupSpans("nothing marked")).toEqual([{ text: "nothing marked", bold: false, underline: false }]);
  });

  it("holds both kinds in one line, in the order they were written", () => {
    expect(markupSpans("**a** and __b__").map((s) => s.text)).toEqual(["a", " and ", "b"]);
    expect(markupSpans("**a** and __b__").map((s) => s.underline)).toEqual([false, false, true]);
  });

  it("rebuilds the stripped text exactly", () => {
    const text = "Hi Saravan,\n\nMonday works. Send the **signed** copy before __Friday__.";
    expect(markupSpans(text).map((s) => s.text).join("")).toBe(stripMarkup(text));
  });
});
