import { describe, it, expect } from "vitest";
import { detectProvider } from "../../src/imap/detect";

const never = async () => {
  throw new Error("MX lookup should not run for a known domain");
};

describe("detectProvider", () => {
  it("recognises consumer Gmail domains without an MX lookup", async () => {
    for (const address of ["Hunter@Gmail.com", "h@googlemail.com"]) {
      const r = await detectProvider(address, never);
      expect(r.provider).toBe("gmail");
      expect(r.settings).toEqual({ imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465, kind: "gmail" });
    }
  });

  it("recognises Microsoft consumer domains without an MX lookup", async () => {
    for (const address of ["h@outlook.com", "h@hotmail.com", "h@live.com", "h@MSN.com"]) {
      const r = await detectProvider(address, never);
      expect(r.provider).toBe("outlook");
      expect(r.settings).toBeUndefined();
    }
  });

  it("treats a custom domain on Google Workspace as gmail", async () => {
    const r = await detectProvider("hunter@northwind.co", async (domain) => {
      expect(domain).toBe("northwind.co");
      return ["aspmx.l.google.com", "alt1.aspmx.l.google.com"];
    });
    expect(r.provider).toBe("gmail");
    expect(r.settings?.kind).toBe("gmail");
    expect(r.settings?.imapHost).toBe("imap.gmail.com");
  });

  it("treats a custom domain on Microsoft 365 as outlook", async () => {
    const r = await detectProvider("hunter@northwind.co", async () => ["northwind-co.mail.protection.outlook.com"]);
    expect(r.provider).toBe("outlook");
    expect(r.settings).toBeUndefined();
  });

  it("falls back to generic with no settings when the MX records are someone else's", async () => {
    const r = await detectProvider("hunter@northwind.co", async () => ["mx1.fastmail.com"]);
    expect(r.provider).toBe("generic");
    expect(r.settings).toBeUndefined();
  });

  it("falls back to generic when the MX lookup fails", async () => {
    const r = await detectProvider("hunter@northwind.co", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(r.provider).toBe("generic");
  });

  it("matches an MX host only on a domain boundary", async () => {
    const r = await detectProvider("hunter@northwind.co", async () => ["mx.notgoogle.com"]);
    expect(r.provider).toBe("generic");
  });

  it("rejects an address with no domain", async () => {
    await expect(detectProvider("not-an-address", never)).rejects.toThrow(/address/i);
  });
});
