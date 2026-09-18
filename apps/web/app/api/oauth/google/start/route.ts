import { NextRequest, NextResponse } from "next/server";
import { createGoogleAuthRequest } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { requestOrigin } from "@/lib/origin";

const COOKIE_NAME = "celeste_oauth_g";

/** Sign in with Google (2026-09-11): the Gmail counterpart of the Microsoft start route. */
export async function GET(req: NextRequest) {
  const { cfg } = core();
  const origin = requestOrigin(req);
  if (!cfg.google.clientId || !cfg.google.clientSecret) {
    return NextResponse.redirect(new URL("/inboxes?error=missing_google_client_id", origin), 302);
  }
  const { url, codeVerifier, state } = await createGoogleAuthRequest(cfg, `${origin}/api/oauth/google/callback`);
  const res = NextResponse.redirect(url, 302);
  res.cookies.set(COOKIE_NAME, JSON.stringify({ state, codeVerifier }), { httpOnly: true, sameSite: "lax", maxAge: 600, path: "/" });
  return res;
}
