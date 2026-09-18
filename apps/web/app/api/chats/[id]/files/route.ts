import { NextRequest, NextResponse } from "next/server";
import { addChatFile, removeChatFile } from "@messaging-agent/core";
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
  return 400;
}

/**
 * A file into the conversation (spec 10c, 2026-09-10): the + on the Ask panel
 * or a drop on it, when no draft is open. Operator, 2026-09-10: "cannot click
 * on the plus button". The bytes stop here — the blob store on this Mac, and
 * Celeste's prompt. Nothing on a conversation is going out with a mail until
 * the operator attaches it to a draft themselves.
 *
 * Same-origin only. Any page in the browser can reach a local route, and this
 * one writes.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return fail("cross_site", 403);
  const { cfg, db } = core();
  const chatId = decodeURIComponent((await ctx.params).id);

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return fail("Attach a file to the `file` field.", 400);
    const row = await addChatFile(db, cfg, chatId, {
      filename: file.name || "attachment",
      // A browser that cannot name the type still hands over a file the
      // operator meant Celeste to read.
      mimeType: file.type || "application/octet-stream",
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    // Only what the chip needs. The excerpt and the path on disk stay here:
    // a PDF's text belongs in Celeste's prompt, not in a browser (spec 10c).
    return NextResponse.json({ id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size }, { headers: HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, statusFor(message));
  }
}

/** The × on a chip. The row goes; the bytes stay, because blobs are shared (spec 11a). */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return fail("cross_site", 403);
  const { db } = core();
  const chatId = decodeURIComponent((await ctx.params).id);
  const fileId = new URL(req.url).searchParams.get("file");
  if (!fileId) return fail("Name the file to remove in `file`.", 400);

  try {
    removeChatFile(db, chatId, fileId);
    return NextResponse.json({ ok: true }, { headers: HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, statusFor(message));
  }
}
