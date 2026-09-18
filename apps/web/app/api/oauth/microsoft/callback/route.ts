import { NextRequest, NextResponse } from "next/server";
import { completeOutlookAuth } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { requestOrigin } from "@/lib/origin";

const COOKIE_NAME = "celeste_oauth_ms";

export async function GET(req: NextRequest) {
  const { cfg, db } = core();
  const url = new URL(req.url);
  const origin = requestOrigin(req);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/inboxes?error=${encodeURIComponent(error)}`, origin), 302);
  }

  const raw = req.cookies.get(COOKIE_NAME)?.value;
  let saved: { state: string; codeVerifier: string } | null = null;
  try {
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }

  if (!saved || !state || !code || saved.state !== state) {
    return NextResponse.redirect(new URL("/inboxes?error=state_mismatch", origin), 302);
  }

  try {
    const account = await completeOutlookAuth(cfg, db, {
      code,
      codeVerifier: saved.codeVerifier,
      redirectUri: `${origin}/api/oauth/microsoft/callback`,
    });
    const res = NextResponse.redirect(new URL(`/connecting/${account.id}`, origin), 302);
    res.cookies.delete(COOKIE_NAME);
    return res;
  } catch (err) {
    return NextResponse.redirect(new URL(`/inboxes?error=${encodeURIComponent((err as Error).message)}`, origin), 302);
  }
}
