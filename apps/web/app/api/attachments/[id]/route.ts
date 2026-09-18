import { NextRequest, NextResponse } from "next/server";
import { AccountAuthError, connectorForAccount, ensureAttachmentBytes, NotFoundError } from "@messaging-agent/core";
import { attachmentHeaders, needsJpegConversion } from "@/lib/attachments";
import { core } from "@/lib/core";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * HEIC to JPEG with the Mac's own sips (2026-09-11): the photo an iPhone
 * sends over Messages is HEIC, which no browser shows. Only for a preview;
 * a download hands over the file as it came. Kept to 2000px on its long
 * side: a preview, not the 12-megapixel original.
 */
async function toJpeg(bytes: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "celeste-heic-"));
  try {
    const src = path.join(dir, "in.heic");
    const out = path.join(dir, "out.jpg");
    await writeFile(src, bytes);
    await new Promise<void>((resolve, reject) => {
      execFile("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", "2000", src, "--out", out], { timeout: 20_000 }, (err) => (err ? reject(err) : resolve()));
    });
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const dynamic = "force-dynamic";

/**
 * The bytes of one attachment, from disk when they are cached and from the
 * provider on the first open (spec 11a). Only the five previewable types are
 * served with their own MIME type; everything else is an octet-stream
 * download, so an HTML or SVG attachment can never run in this origin.
 *
 * `next.config.ts` deliberately leaves this route out of the app's CSP: that
 * policy applied to a PDF response blanks out Chrome's built-in viewer. The
 * headers helper states the right policy per response instead.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { cfg, db } = core();
  const { id: rawId } = await ctx.params;
  // Attachment ids are `${accountId}:${providerMessageId}:${index}`.
  const id = decodeURIComponent(rawId);

  try {
    const { row, bytes } = await ensureAttachmentBytes(db, cfg, (account) => connectorForAccount(cfg, db, account), id);
    const forceDownload = new URL(req.url).searchParams.get("download") === "1";

    if (!forceDownload && needsJpegConversion(row.mimeType, row.filename)) {
      try {
        const jpeg = await toJpeg(Buffer.from(bytes));
        const filename = row.filename.replace(/\.hei[cf]$/i, "") + ".jpg";
        return new NextResponse(new Uint8Array(jpeg), { headers: attachmentHeaders({ mimeType: "image/jpeg", filename, size: jpeg.byteLength, forceDownload: false }) });
      } catch (err) {
        console.error(`heic preview for ${id}:`, (err as Error).message);
      }
    }

    // A plain Uint8Array copy: Buffer's SharedArrayBuffer-capable type is not a BodyInit.
    return new NextResponse(new Uint8Array(bytes), {
      headers: attachmentHeaders({ mimeType: row.mimeType, filename: row.filename, size: bytes.byteLength, forceDownload }),
    });
  } catch (err) {
    // This route is excluded from the app's own CSP (see next.config.ts), so
    // its error bodies state their own.
    const headers = { "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" };
    if (err instanceof NotFoundError) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
    if (err instanceof AccountAuthError) return NextResponse.json({ error: "needs_signin" }, { status: 409, headers });
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502, headers });
  }
}
