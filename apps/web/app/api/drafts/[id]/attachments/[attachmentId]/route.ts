import { NextRequest, NextResponse } from "next/server";
import { getDraftAttachment, readBlob } from "@messaging-agent/core";
import { attachmentHeaders } from "@/lib/attachments";
import { core } from "@/lib/core";

export const dynamic = "force-dynamic";

/**
 * The bytes of one file the operator put on a draft, so a PDF on the way out
 * can be opened before it goes (operator, 2026-09-10: "should be able to
 * click on the PDF and see the content").
 *
 * The rules are the inbound route's, unchanged: only the five previewable
 * types are served with their own MIME type, everything else is an
 * octet-stream download, and `?download=1` forces the download for any of
 * them. The id must be on this draft, so a guessed one reaches nothing.
 *
 * No same-origin check, unlike the POST beside it: an `<img>` or `<iframe>`
 * sends no `Origin`, and this reads bytes the operator chose themselves.
 * `next.config.ts` leaves this route out of the app's CSP for the same reason
 * as the inbound one — that policy blanks out Chrome's PDF viewer.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; attachmentId: string }> }) {
  const { db } = core();
  const { id: rawDraftId, attachmentId: rawAttachmentId } = await ctx.params;
  const draftId = decodeURIComponent(rawDraftId);
  const attachmentId = decodeURIComponent(rawAttachmentId);

  // This route is excluded from the app's own CSP, so its error bodies state their own.
  const headers = { "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" };

  const row = getDraftAttachment(db, draftId, attachmentId);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404, headers });

  try {
    const bytes = await readBlob(row.path);
    const forceDownload = new URL(req.url).searchParams.get("download") === "1";
    // A plain Uint8Array copy: Buffer's SharedArrayBuffer-capable type is not a BodyInit.
    return new NextResponse(new Uint8Array(bytes), {
      headers: attachmentHeaders({ mimeType: row.mimeType, filename: row.filename, size: bytes.byteLength, forceDownload }),
    });
  } catch (err) {
    // The row is there and the blob is not: the file went missing off this Mac.
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404, headers });
  }
}
