import { NextRequest, NextResponse } from "next/server";
import { addDraftAttachment, removeDraftAttachment } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { isSameOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** Every answer here states its own policy: nothing this route returns is meant to render. */
const HEADERS = { "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" };

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: HEADERS });
}

/** A refusal from core, read for what the operator should be told and how loudly. */
function statusFor(message: string): number {
  if (/not found/.test(message)) return 404;
  if (/not pending/.test(message)) return 409;
  return 400;
}

/**
 * A file onto a draft (spec 8, 2026-09-10): dropped on the Ask panel or the
 * card, or picked with the paperclip. The bytes stop here — they go to the
 * blob store on this Mac and onto the draft, and reach a provider only when
 * the operator presses Send.
 *
 * Same-origin only. Any page in the browser can reach a local route, and this
 * one writes.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return fail("cross_site", 403);
  const { cfg, db } = core();
  const draftId = decodeURIComponent((await ctx.params).id);

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return fail("Attach a file to the `file` field.", 400);
    const row = await addDraftAttachment(db, cfg, draftId, {
      filename: file.name || "attachment",
      // A browser that cannot name the type still hands over a file the
      // operator meant to send; the provider will sniff it at the other end.
      mimeType: file.type || "application/octet-stream",
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return NextResponse.json(row, { headers: HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, statusFor(message));
  }
}

/** The × on a chip. The row goes; the bytes stay, because blobs are shared (spec 11a). */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return fail("cross_site", 403);
  const { db } = core();
  const draftId = decodeURIComponent((await ctx.params).id);
  const attachmentId = new URL(req.url).searchParams.get("attachment");
  if (!attachmentId) return fail("Name the file to remove in `attachment`.", 400);

  try {
    removeDraftAttachment(db, draftId, attachmentId);
    return NextResponse.json({ ok: true }, { headers: HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, statusFor(message));
  }
}
