import { landingFor } from "@messaging-agent/core";
import { core } from "@/lib/core";

export const dynamic = "force-dynamic";

/**
 * The address that goes to Alex (2026-09-23). One per thread, steady for as
 * long as the thread exists, and it decides here rather than when the link
 * was written: the draft while one is waiting, the conversation once it has
 * gone. A link in a to-do outlives the draft that prompted it.
 *
 * It is behind the same lock as everything else: on the phone, Tailscale and
 * the passcode stand between this and anybody else.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const { db } = core();
  const to = landingFor(db, decodeURIComponent(threadId));
  return Response.redirect(new URL(to, _req.url), 302);
}
