import { describe, it, expect } from "vitest";
import { Attempts, isLocalRequest, isOpenPath, passcodeMatches, signSession, verifySession } from "../lib/lock";
import { requestOrigin } from "../lib/origin";

const h = (m: Record<string, string>) => ({ get: (k: string) => m[k.toLowerCase()] ?? null });

/** The lock in front of Celeste once the phone can reach it (2026-09-14). */
describe("isLocalRequest", () => {
  it("lets this Mac's own browser straight through, with the forwarding headers Next adds to it", () => {
    expect(isLocalRequest(h({ host: "127.0.0.1:3100" }))).toBe(true);
    expect(isLocalRequest(h({ host: "localhost:3100" }))).toBe(true);
    expect(isLocalRequest(h({ host: "127.0.0.1:3100", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "127.0.0.1:3100", "x-forwarded-proto": "http" }))).toBe(true);
    expect(isLocalRequest(h({ host: "127.0.0.1:3100", "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": "localhost:3100" }))).toBe(true);
  });
  it("never trusts a request that came through a proxy, even from 127.0.0.1", () => {
    expect(isLocalRequest(h({ host: "127.0.0.1:3100", "x-forwarded-for": "100.101.1.2" }))).toBe(false);
    expect(isLocalRequest(h({ host: "127.0.0.1:3100", "x-forwarded-for": "100.101.1.2, 127.0.0.1" }))).toBe(false);
    expect(isLocalRequest(h({ host: "127.0.0.1:3100", "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "mac.tail1234.ts.net" }))).toBe(false);
    expect(isLocalRequest(h({ host: "127.0.0.1:3100", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https" }))).toBe(false);
    expect(isLocalRequest(h({ host: "127.0.0.1:3100", "tailscale-user-login": "me@example.com" }))).toBe(false);
    expect(isLocalRequest(h({ host: "mac.tail1234.ts.net" }))).toBe(false);
    expect(isLocalRequest(h({}))).toBe(false);
  });
});

describe("sessions", () => {
  it("verifies a token made with the passcode until it runs out", async () => {
    const t = await signSession("correct horse", 10_000);
    expect(await verifySession("correct horse", t, 5_000)).toBe(true);
    expect(await verifySession("correct horse", t, 10_001)).toBe(false);
  });
  it("refuses a token from another passcode, a tampered one, or none", async () => {
    const t = await signSession("correct horse", 10_000);
    expect(await verifySession("new passcode!", t, 5_000)).toBe(false);
    expect(await verifySession("correct horse", t.replace(/^10000/, "99999"), 5_000)).toBe(false);
    expect(await verifySession("correct horse", undefined, 5_000)).toBe(false);
    expect(await verifySession(undefined, t, 5_000)).toBe(false);
    expect(await verifySession("correct horse", "junk", 5_000)).toBe(false);
  });
});

describe("passcodeMatches", () => {
  it("matches exactly, and never with no passcode or one too short to be a lock", () => {
    expect(passcodeMatches("correct horse", "correct horse")).toBe(true);
    expect(passcodeMatches("correct hors", "correct horse")).toBe(false);
    expect(passcodeMatches("", undefined)).toBe(false);
    expect(passcodeMatches("1234", "1234")).toBe(false);
  });
});

describe("Attempts", () => {
  it("blocks a client after five wrong tries in ten minutes, and forgets them after", () => {
    const a = new Attempts();
    for (let i = 0; i < 5; i++) a.fail("phone", 1000 + i);
    expect(a.blocked("phone", 2000)).toBe(true);
    expect(a.blocked("laptop", 2000)).toBe(false);
    expect(a.blocked("phone", 1000 + 10 * 60_000 + 10)).toBe(false);
  });
});

describe("isOpenPath", () => {
  it("opens only the lock and what a home-screen icon needs", () => {
    for (const p of ["/unlock", "/api/unlock", "/manifest.webmanifest", "/sw.js", "/icon", "/apple-icon", "/_next/static/x.js"]) expect(isOpenPath(p)).toBe(true);
    for (const p of ["/inbox", "/api/pulse", "/api/attachments/1", "/drafts"]) expect(isOpenPath(p)).toBe(false);
  });
});

describe("requestOrigin through Tailscale", () => {
  it("reads the forwarded name and scheme", () => {
    expect(requestOrigin(new Request("http://127.0.0.1:3100/x", { headers: { host: "127.0.0.1:3100" } }))).toBe("http://127.0.0.1:3100");
    expect(requestOrigin(new Request("http://127.0.0.1:3100/x", { headers: { host: "127.0.0.1:3100", "x-forwarded-host": "mac.tail1234.ts.net", "x-forwarded-proto": "https" } }))).toBe("https://mac.tail1234.ts.net");
  });
});
