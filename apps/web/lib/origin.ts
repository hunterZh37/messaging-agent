/**
 * `new URL(req.url).origin` resolves through Next's internal routing and can
 * report `localhost` even when the browser is on `127.0.0.1` (or vice
 * versa), which breaks the OAuth start/callback pair: the PKCE cookie is set
 * on one origin, Google redirects to the other, and the callback can't see
 * it. Read the actual `Host` header the browser sent instead so both routes
 * always agree. The app only ever binds 127.0.0.1 over plain http, so the
 * scheme is fixed.
 */
export function requestOrigin(req: Request): string {
  // Through Tailscale (2026-09-14) the phone is on https and a name of its
  // own, and the proxy says so in the forwarding headers.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "127.0.0.1:3100";
  const proto = req.headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

/**
 * Is this request the app's own page talking to itself?
 *
 * The routes that write something — attaching a file to a draft, taking one
 * off — are reachable by any page in a browser that has this app open, so
 * they check before they act. `Sec-Fetch-Site` is the browser's own account
 * of where the request came from and cannot be set by script, so it decides
 * when it is there; `Origin` is the fallback for a browser that does not send
 * it. Nothing gets through without one of the two: every fetch that writes
 * sends `Origin`, so a request with neither is not a page of ours.
 */
export function isSameOrigin(req: Request): boolean {
  // A same-origin GET from a page of ours carries Sec-Fetch-Site and no
  // Origin (2026-09-13: the live pulse answered 403 to every browser, and
  // the counts never moved on their own).
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (origin !== null && origin !== requestOrigin(req)) return false;
  if (site !== null && site !== "same-origin") return false;
  return origin !== null || site !== null;
}
