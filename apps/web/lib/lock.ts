/**
 * The lock in front of Celeste once a phone can reach it (operator,
 * 2026-09-14: "how can we make this mobile", option 1). Until then only this
 * Mac could open the app, so it trusted every request. Through Tailscale the
 * phone reaches the same server, and a lost phone must not be a way in, so
 * a request from anywhere but this Mac's own browser needs a session made
 * by typing the passcode, which lives in the repo's .env as CELESTE_PASSCODE.
 *
 * Web Crypto only, no Node imports: the proxy that checks it runs before the
 * app does.
 */

export const SESSION_COOKIE = "celeste-session";
/** How long an unlocked phone stays unlocked. */
export const SESSION_DAYS = 30;
/** Shorter passcodes are refused: the lock is the only thing between a lost phone and every inbox. */
export const MIN_PASSCODE_LENGTH = 8;

type Headers = { get(name: string): string | null };

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const LOOPBACK_IP = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;

/**
 * Is this this Mac's own browser, talking straight to the server? Next puts
 * forwarding headers on every request, a local one included, naming this Mac
 * in each. A request through Tailscale arrives from 127.0.0.1 as well, but its
 * forwarding headers name the phone's address and the Mac's ts.net name, and
 * it carries Tailscale's identity headers. So: local only when every one of
 * them points back at this Mac, and nothing of Tailscale's is present.
 */
export function isLocalRequest(headers: Headers): boolean {
  if (headers.get("tailscale-user-login") || headers.get("tailscale-user-name") || headers.get("forwarded")) return false;
  const host = (headers.get("host") ?? "").toLowerCase();
  if (!LOOPBACK_HOST.test(host)) return false;
  const fwdHost = headers.get("x-forwarded-host");
  if (fwdHost !== null && !fwdHost.split(",").every((h) => LOOPBACK_HOST.test(h.trim().toLowerCase()))) return false;
  const fwdFor = headers.get("x-forwarded-for");
  if (fwdFor !== null && !fwdFor.split(",").every((ip) => LOOPBACK_IP.test(ip.trim()))) return false;
  return headers.get("x-forwarded-proto") !== "https";
}

const enc = new TextEncoder();

async function keyFor(passcode: string): Promise<CryptoKey> {
  // A key derived from the passcode: changing the passcode signs every
  // phone out, which is what changing it is for.
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`celeste-session:${passcode}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A session token good until `expiresAt`: the expiry, and its signature. */
export async function signSession(passcode: string, expiresAt: number): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await keyFor(passcode), enc.encode(String(expiresAt)));
  return `${expiresAt}.${hex(sig)}`;
}

/** Whether a token was made with this passcode and has not run out. */
export async function verifySession(passcode: string | undefined, token: string | undefined, now: number = Date.now()): Promise<boolean> {
  if (!passcode || !token) return false;
  const [exp, sig] = token.split(".");
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || !sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const bytes = new Uint8Array(sig.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", await keyFor(passcode), bytes, enc.encode(String(expiresAt)));
}

/** A typed passcode against the one in .env, in time that does not depend on where they differ. */
export function passcodeMatches(typed: string, passcode: string | undefined): boolean {
  if (!passcode || passcode.length < MIN_PASSCODE_LENGTH) return false;
  const a = enc.encode(typed);
  const b = enc.encode(passcode);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Paths that must open without a session: the lock itself, and what a home-screen icon fetches before it. */
export function isOpenPath(pathname: string): boolean {
  return (
    pathname === "/unlock" ||
    pathname === "/api/unlock" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js" ||
    pathname.startsWith("/icon") ||
    pathname.startsWith("/apple-icon") ||
    pathname.startsWith("/_next/")
  );
}

/**
 * Wrong passcodes, counted per client: five in ten minutes and that client
 * waits out the rest of the ten. In memory, because a restart forgetting
 * them costs a guesser a restart they cannot cause.
 */
export class Attempts {
  private failures = new Map<string, number[]>();
  constructor(private readonly limit = 5, private readonly windowMs = 10 * 60_000) {}

  blocked(client: string, now: number = Date.now()): boolean {
    return this.recent(client, now).length >= this.limit;
  }

  fail(client: string, now: number = Date.now()): void {
    this.failures.set(client, [...this.recent(client, now), now]);
  }

  clear(client: string): void {
    this.failures.delete(client);
  }

  private recent(client: string, now: number): number[] {
    return (this.failures.get(client) ?? []).filter((t) => now - t < this.windowMs);
  }
}
