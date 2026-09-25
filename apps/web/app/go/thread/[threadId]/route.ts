import { landingFor } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { requestOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/**
 * The address that goes to Alex (2026-09-23). One per thread, steady for as
 * long as the thread exists, and it decides here rather than when the link
 * was written: the draft while one is waiting, the conversation once it has
 * gone. A link in a to-do outlives the draft that prompted it.
 *
 * The second hop is built from the host the browser actually asked for, not
 * from Next's own idea of this request: on the phone the first hop arrives
 * over the tailnet and `req.url` says localhost, which on a phone means the
 * phone (review, 2026-09-24). Every other redirect in this app reads the
 * forwarded host the same way.
 *
 * It is behind the same lock as everything else: on the phone, Tailscale and
 * the passcode stand between this and anybody else.
 */
export async function GET(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const { db } = core();
  // Next has already decoded the segment. Decoding it again turned a lone
  // "%" into a 500 instead of the inbox (review, 2026-09-24).
  const to = landingFor(db, threadId);
  return Response.redirect(new URL(to, requestOrigin(req)), 302);
}
