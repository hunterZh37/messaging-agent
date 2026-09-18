import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../../src/text/sanitize";

describe("sanitizeHtml", () => {
  it("removes script tags and their content", () => {
    const out = sanitizeHtml("<p>Hi</p><script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>Hi</p>");
  });

  it("removes inline event handlers", () => {
    const out = sanitizeHtml('<p onclick="alert(1)">Hi</p>');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("Hi");
  });

  it("removes javascript: hrefs", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("href=");
    expect(out).toContain("click");
  });

  it("keeps http, https, and mailto hrefs", () => {
    expect(sanitizeHtml('<a href="https://example.com">x</a>')).toContain('href="https://example.com"');
    expect(sanitizeHtml('<a href="http://example.com">x</a>')).toContain('href="http://example.com"');
    expect(sanitizeHtml('<a href="mailto:bob@example.com">x</a>')).toContain('href="mailto:bob@example.com"');
  });

  it("keeps a safe style declaration but strips class and id", () => {
    const out = sanitizeHtml('<p style="color:red" class="c" id="i">Hi</p>');
    expect(out).toContain("color:red");
    expect(out).not.toContain("class=");
    expect(out).not.toContain("id=");
    expect(out).toContain("Hi");
  });

  it("drops an unsafe style property (position) entirely while keeping the element", () => {
    const out = sanitizeHtml('<p style="position:fixed">Hi</p>');
    expect(out).not.toContain("position");
    expect(out).toContain("Hi");
  });

  it("removes style tags and their content, iframe, form, input, link, meta", () => {
    const out = sanitizeHtml(
      '<style>p{color:red}</style><iframe src="https://evil.com"></iframe><form><input type="text"></form><link rel="stylesheet"><meta charset="utf-8"><p>Body</p>',
    );
    expect(out).not.toContain("<style");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<input");
    expect(out).not.toContain("<link");
    expect(out).not.toContain("<meta");
    expect(out).toContain("<p>Body</p>");
  });

  it("keeps allowed table markup with colspan/rowspan", () => {
    const out = sanitizeHtml(
      '<table><thead><tr><th colspan="2">H</th></tr></thead><tbody><tr><td rowspan="2">A</td><td>B</td></tr></tbody></table>',
    );
    expect(out).toContain("<table>");
    expect(out).toContain("<thead>");
    expect(out).toContain("<tbody>");
    expect(out).toContain('colspan="2"');
    expect(out).toContain('rowspan="2"');
  });

  it("forces rel=noopener noreferrer and target=_blank on every link", () => {
    const out = sanitizeHtml('<a href="https://example.com" target="_self" rel="something">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
    expect(out).not.toContain('rel="something"');
    expect(out).not.toContain('target="_self"');
  });

  it("drops cid: images (no inline images in v1)", () => {
    const out = sanitizeHtml('<img src="cid:image001.png@01D1" alt="logo">');
    expect(out).not.toContain("cid:");
    expect(out).not.toContain("src=");
  });

  it("drops http (non-https) image sources", () => {
    const out = sanitizeHtml('<img src="http://example.com/a.png" alt="a">');
    expect(out).not.toContain("src=");
  });

  it("keeps https image sources with alt/width/height", () => {
    const out = sanitizeHtml('<img src="https://example.com/a.png" alt="a" width="10" height="20">');
    expect(out).toContain('src="https://example.com/a.png"');
    expect(out).toContain('alt="a"');
    expect(out).toContain('width="10"');
    expect(out).toContain('height="20"');
  });

  it("keeps other allowed formatting tags", () => {
    const out = sanitizeHtml("<div><span><b>b</b><i>i</i><strong>s</strong><em>e</em><u>u</u></span></div>");
    expect(out).toBe("<div><span><b>b</b><i>i</i><strong>s</strong><em>e</em><u>u</u></span></div>");
  });

  it("keeps a safe subset of inline styles (colors, layout, typography weights) for a styled button", () => {
    const out = sanitizeHtml(
      '<div style="background-color:#2c5c7a;border-radius:4px;padding:10px 20px;text-align:center"><a style="color:#fff;font-weight:bold" href="https://x">View</a></div>',
    );
    expect(out).toContain("background-color:#2c5c7a");
    expect(out).toContain("border-radius:4px");
    expect(out).toContain("padding:10px 20px");
    expect(out).toContain("text-align:center");
    expect(out).toContain("color:#fff");
    expect(out).toContain("font-weight:bold");
  });

  it("drops font-family, position, and url()-bearing style declarations", () => {
    const out = sanitizeHtml('<p style="font-family:Comic Sans;position:absolute;background:url(javascript:1)">x</p>');
    expect(out).not.toContain("Comic Sans");
    expect(out).not.toContain("position");
    expect(out).not.toContain("url(");
    expect(out).not.toContain("javascript:");
  });

  it("keeps legacy email layout tags and attributes", () => {
    const out = sanitizeHtml(
      '<center><font color="#333" size="2">Note</font></center><table width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#fff"><tr valign="top" bgcolor="#eee"><td align="center" bgcolor="#ddd">x</td></tr></table>',
    );
    expect(out).toContain("<center>");
    expect(out).toContain('color="#333"');
    expect(out).toContain('size="2"');
    expect(out).not.toContain('width="600"');
    expect(out).toContain("max-width:600px;width:100%");
    expect(out).toContain('cellpadding="0"');
    expect(out).toContain('cellspacing="0"');
    expect(out).toContain('bgcolor="#fff"');
    expect(out).toContain('valign="top"');
    expect(out).toContain('align="center"');
  });

  it("keeps lists, headings, blockquote, pre/code, br, hr", () => {
    const out = sanitizeHtml("<h1>H</h1><ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote><pre><code>c</code></pre><br><hr>");
    expect(out).toContain("<h1>H</h1>");
    expect(out).toContain("<ul><li>a</li></ul>");
    expect(out).toContain("<ol><li>b</li></ol>");
    expect(out).toContain("<blockquote>q</blockquote>");
    expect(out).toContain("<pre><code>c</code></pre>");
    expect(out).toContain("<br");
    expect(out).toContain("<hr");
  });
  it("drops the document title text instead of leaking it into the body", () => {
    const out = sanitizeHtml("<html><head><title>BILL</title></head><body><p>Hi</p></body></html>");
    expect(out).not.toContain("BILL");
    expect(out).toContain("<p>Hi</p>");
  });

  it("turns fixed pixel widths on tables and cells into max-width so layout shrinks to the pane", () => {
    const out = sanitizeHtml(
      '<table width="640"><tr><td width="640" style="width:640px;color:#212121">x</td></tr></table>',
    );
    expect(out).not.toMatch(/width="640"/);
    expect(out).toContain('<table style="max-width:640px;width:100%">');
    // A cell keeps only the cap: no width:100% that could starve a neighbour.
    expect(out).toContain('<td style="max-width:640px;color:#212121">');
    expect(out).not.toMatch(/(^|[;"])width:640px/);
  });

  it("leaves percent and unsized tables alone", () => {
    const out = sanitizeHtml('<table width="100%"><tr><td>x</td></tr></table><table><tr><td>y</td></tr></table>');
    expect(out).toContain('<table width="100%">');
    expect(out).toContain("<table><tr><td>y</td></tr></table>");
  });

  describe("drops a hidden preheader instead of leaving its text as a stray column", () => {
    it("display:none", () => {
      const out = sanitizeHtml('<div style="display:none">Preview text nobody should read</div><p>Body</p>');
      expect(out).not.toContain("Preview text");
      expect(out).toContain("<p>Body</p>");
    });

    it("visibility:hidden", () => {
      const out = sanitizeHtml('<div style="visibility:hidden">Preview text</div><p>Body</p>');
      expect(out).not.toContain("Preview text");
      expect(out).toContain("<p>Body</p>");
    });

    it("opacity:0", () => {
      const out = sanitizeHtml('<div style="opacity:0">Preview text</div><p>Body</p>');
      expect(out).not.toContain("Preview text");
      expect(out).toContain("<p>Body</p>");
    });

    it("font-size:0 with line-height:0", () => {
      const out = sanitizeHtml('<span style="font-size:0;line-height:0">Preview text</span><p>Body</p>');
      expect(out).not.toContain("Preview text");
      expect(out).toContain("<p>Body</p>");
    });

    it("font-size:0px with overflow:hidden", () => {
      const out = sanitizeHtml('<span style="font-size:0px;overflow:hidden">Preview text</span><p>Body</p>');
      expect(out).not.toContain("Preview text");
      expect(out).toContain("<p>Body</p>");
    });

    it("keeps an MJML column wrapper, which is font-size:0 around content that sets its own size", () => {
      // Seen live, 2026-09-11: an Amazon shipping mail rendered as an empty box.
      const out = sanitizeHtml(
        '<div style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%"><table><tr><td style="font-size:16px">Shipped 1 item</td></tr></table></div>',
      );
      expect(out).toContain("Shipped 1 item");
    });

    it("max-height:0", () => {
      const out = sanitizeHtml('<div style="max-height:0">Preview text</div><p>Body</p>');
      expect(out).not.toContain("Preview text");
      expect(out).toContain("<p>Body</p>");
    });

    it("max-height:0px", () => {
      const out = sanitizeHtml('<div style="max-height:0px">Preview text</div><p>Body</p>');
      expect(out).not.toContain("Preview text");
      expect(out).toContain("<p>Body</p>");
    });

    it("width:0 together with overflow:hidden", () => {
      const out = sanitizeHtml('<div style="width:0;overflow:hidden">Preview text</div><p>Body</p>');
      expect(out).not.toContain("Preview text");
      expect(out).toContain("<p>Body</p>");
    });

    it("width:0px together with overflow:hidden", () => {
      const out = sanitizeHtml('<div style="width:0px;overflow:hidden">Preview text</div><p>Body</p>');
      expect(out).not.toContain("Preview text");
      expect(out).toContain("<p>Body</p>");
    });

    it("mso-hide:all", () => {
      const out = sanitizeHtml('<div style="mso-hide:all">Preview text</div><p>Body</p>');
      expect(out).not.toContain("Preview text");
      expect(out).toContain("<p>Body</p>");
    });

    it("a realistic Substack-style preheader with several hiding declarations at once", () => {
      const out = sanitizeHtml(
        '<div style="display:none;font-size:1px;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;mso-hide:all">Don\'t miss today\'s post</div><p>Body</p>',
      );
      expect(out).not.toContain("Don't miss");
      expect(out).toContain("<p>Body</p>");
    });

    it("drops a box of no width or no height on its own: nothing inside it was meant to show", () => {
      // Seen live, 2026-09-11: a preheader kept width:0px once overflow was
      // stripped and rendered as a column of letters; a height:0px wrapper
      // let the mail spill over the buttons under it.
      expect(sanitizeHtml('<div style="width:0">Preview</div><p>Body</p>')).not.toContain("Preview");
      expect(sanitizeHtml('<div style="height:0px">Preview</div><p>Body</p>')).not.toContain("Preview");
      expect(sanitizeHtml('<div style="height:0px">Preview</div><p>Body</p>')).toContain("<p>Body</p>");
    });

    it("does not drop an ordinary styled element", () => {
      const out = sanitizeHtml('<div style="color:red;font-size:14px">Visible</div>');
      expect(out).toContain("Visible");
    });
  });
});
