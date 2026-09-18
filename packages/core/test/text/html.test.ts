import { describe, it, expect } from "vitest";
import { stripInvisible, stripHtml } from "../../src/text/html";

describe("stripHtml", () => {
  it("drops tags, decodes entities, and keeps one blank line between blocks", () => {
    expect(stripHtml("<p>One</p><p>Two</p><p>Three</p>")).toBe("One\n\nTwo\n\nThree");
    expect(stripHtml("<p>Hi <b>Bob</b></p><br>Bye")).toBe("Hi Bob\n\nBye");
    expect(stripHtml("<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f</p>")).toBe("a & b <c> \"d\" 'e' f");
  });

  it("removes style and script content entirely", () => {
    expect(stripHtml("<style>p{color:red}</style><script>alert(1)</script><p>Body</p>")).toBe("Body");
  });

  it("drops the invisible spacing entities marketing mail pads with", () => {
    // A real Bill.com body ended "Review and pay your invoice. &zwnj; &zwnj; &zwnj;".
    expect(stripHtml("<p>Review and pay your invoice. &zwnj; &zwnj; &zwnj;</p>")).toBe("Review and pay your invoice.");
    expect(stripHtml("<p>soft&shy;hyphen and zero&zwj;width</p>")).toBe("softhyphen and zerowidth");
  });

  it("decodes numeric entities, decimal and hex alike", () => {
    expect(stripHtml("<p>It&#8217;s here</p>")).toBe("It’s here");
    expect(stripHtml("<p>It&#x27;s here</p>")).toBe("It's here");
    expect(stripHtml("<p>&#x2014; dash</p>")).toBe("— dash");
  });

  it("decodes the named entities that show up in real mail", () => {
    expect(stripHtml("<p>A &mdash; B</p>")).toBe("A — B");
    expect(stripHtml("<p>A &ndash; B</p>")).toBe("A – B");
    expect(stripHtml("<p>Wait&hellip;</p>")).toBe("Wait…");
    expect(stripHtml("<p>&lsquo;a&rsquo; &ldquo;b&rdquo;</p>")).toBe("‘a’ “b”");
    expect(stripHtml("<p>&copy; &reg; &trade;</p>")).toBe("© ® ™");
    expect(stripHtml("<p>&bull; item &middot; two</p>")).toBe("• item · two");
    expect(stripHtml("<p>it&apos;s</p>")).toBe("it's");
  });

  it("leaves an entity it does not know alone rather than mangling it", () => {
    expect(stripHtml("<p>&notanentity; stays</p>")).toBe("&notanentity; stays");
  });

  it("collapses runs of spaces and trims each line", () => {
    expect(stripHtml("<p>too    many     spaces</p>")).toBe("too many spaces");
    expect(stripHtml("<p>  padded  </p><p>  lines  </p>")).toBe("padded\n\nlines");
  });
});

describe("stripInvisible", () => {
  it("removes zero-width and soft-hyphen padding, inside stripHtml too", () => {
    expect(stripInvisible("Snack\u200c\u00ad Foods\u034f")).toBe("Snack Foods");
    expect(stripHtml("<p>Delivered\u200b 2 items</p><div>\u034f \u200c \u00ad</div>")).toBe("Delivered 2 items");
  });
});
