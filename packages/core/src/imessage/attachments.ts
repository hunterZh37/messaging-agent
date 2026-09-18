import { readFile } from "node:fs/promises";
import type { AttachmentRow } from "../db/schema";

/**
 * The bytes of a text's attachment, read from where Messages keeps them on
 * this Mac (2026-09-11). The row's provider id is that path. A file
 * Messages has not downloaded yet, or has since removed, reads as gone.
 */
export async function fetchImessageAttachment(att: AttachmentRow): Promise<Buffer> {
  const file = att.providerAttachmentId;
  if (!file || !file.startsWith("/")) throw new Error(`"${att.filename}" is not downloaded in Messages on this Mac`);
  try {
    return await readFile(file);
  } catch {
    throw new Error(`"${att.filename}" is no longer in Messages on this Mac`);
  }
}
