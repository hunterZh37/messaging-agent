import { describe, it, expect } from "vitest";
import { contentDisposition } from "../lib/disposition";

describe("contentDisposition", () => {
  it("keeps a plain ASCII name in both forms", () => {
    expect(contentDisposition("attachment", "menu.pdf")).toBe("attachment; filename=\"menu.pdf\"; filename*=UTF-8''menu.pdf");
  });

  it("uses the type it is given", () => {
    expect(contentDisposition("inline", "photo.png")).toMatch(/^inline; /);
  });

  it("neutralises a CRLF header injection attempt", () => {
    const header = contentDisposition("attachment", 'evil.pdf"\r\nSet-Cookie: a=b');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toBe("attachment; filename=\"evil.pdfSet-Cookie: a=b\"; filename*=UTF-8''evil.pdfSet-Cookie%3A%20a%3Db");
  });

  it("drops quotes and backslashes that would end the quoted string early", () => {
    expect(contentDisposition("attachment", 'a"b\\c.txt')).toBe("attachment; filename=\"abc.txt\"; filename*=UTF-8''abc.txt");
  });

  it("keeps a non-ASCII name in filename* and substitutes it in the fallback", () => {
    const header = contentDisposition("attachment", "réçu 提案.pdf");
    expect(header).toContain("filename=\"r__u __.pdf\"");
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent("réçu 提案.pdf")}`);
  });

  it("falls back to a usable name when nothing survives stripping", () => {
    expect(contentDisposition("attachment", '"""')).toBe("attachment; filename=\"attachment\"; filename*=UTF-8''");
  });

  it("percent-encodes the characters RFC 5987 disallows bare", () => {
    expect(contentDisposition("attachment", "a'b(c)*d!.txt")).toContain("filename*=UTF-8''a%27b%28c%29%2Ad%21.txt");
  });
});
