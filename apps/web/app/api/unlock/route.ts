import { NextResponse } from "next/server";
import { Attempts, MIN_PASSCODE_LENGTH, passcodeMatches, SESSION_COOKIE, SESSION_DAYS, signSession } from "@/lib/lock";
import { loadRepoEnv } from "@/lib/env";

const attempts = new Attempts();

/** Typing the passcode (2026-09-14): a session cookie for this phone, or a reason. */
export async function POST(req: Request) {
  loadRepoEnv();
  const passcode = process.env.CELESTE_PASSCODE;
  if (!passcode || passcode.length < MIN_PASSCODE_LENGTH) {
    return NextResponse.json({ error: `No passcode is set on the Mac. Add CELESTE_PASSCODE, at least ${MIN_PASSCODE_LENGTH} characters, to the .env file, then restart Celeste.` }, { status: 503 });
  }
  const client = req.headers.get("tailscale-user-login") ?? req.headers.get("x-forwarded-for") ?? "unknown";
  if (attempts.blocked(client)) return NextResponse.json({ error: "Too many wrong tries. Wait ten minutes, then try again." }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { passcode?: unknown };
  const typed = typeof body.passcode === "string" ? body.passcode : "";
  if (!passcodeMatches(typed, passcode)) {
    attempts.fail(client);
    return NextResponse.json({ error: "That passcode is not right." }, { status: 401 });
  }
  attempts.clear(client);
  const expiresAt = Date.now() + SESSION_DAYS * 86_400_000;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await signSession(passcode, expiresAt), {
    httpOnly: true,
    secure: new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https",
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
  return res;
}
