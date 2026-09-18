import { NextResponse, type NextRequest } from "next/server";
import { isLocalRequest, isOpenPath, SESSION_COOKIE, verifySession } from "@/lib/lock";
import { loadRepoEnv } from "@/lib/env";
import { requestOrigin } from "@/lib/origin";

/**
 * The lock (2026-09-14). This Mac's own browser goes straight through, as it
 * always has. Anything else, the phone through Tailscale above all, needs a
 * session from /unlock, and with no passcode set on the Mac nothing else gets
 * in at all: the page says how to set one.
 */
export async function proxy(req: NextRequest) {
  if (isLocalRequest(req.headers) || isOpenPath(req.nextUrl.pathname)) return NextResponse.next();
  loadRepoEnv();
  const passcode = process.env.CELESTE_PASSCODE;
  if (await verifySession(passcode, req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "locked" }, { status: 401 });
  // To the name the phone came in on, not the 127.0.0.1 the proxy reached.
  const to = new URL("/unlock", requestOrigin(req));
  const back = req.nextUrl.pathname + req.nextUrl.search;
  if (back !== "/") to.searchParams.set("next", back);
  return NextResponse.redirect(to);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
