import { NextRequest, NextResponse } from "next/server";
import { createOutlookAuthRequest } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { requestOrigin } from "@/lib/origin";

const COOKIE_NAME = "celeste_oauth_ms";

export async function GET(req: NextRequest) {
  const { cfg } = core();
  const origin = requestOrigin(req);

  if (!cfg.microsoft.clientId) {
    return NextResponse.redirect(new URL("/inboxes?error=missing_microsoft_client_id", origin), 302);
  }

  const { url, codeVerifier, state } = await createOutlookAuthRequest(cfg, `${origin}/api/oauth/microsoft/callback`);

  const res = NextResponse.redirect(url, 302);
  res.cookies.set(COOKIE_NAME, JSON.stringify({ state, codeVerifier }), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return res;
}
