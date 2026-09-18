import { writeBlob } from "./blobs";
import type { Config } from "../config";

/**
 * Taking one file the operator handed over, wherever they handed it over
 * (spec 11a). A draft's attachment and a file given to a conversation are the
 * same act as far as the bytes are concerned: they go to the content-addressed
 * blob store, and whatever text can be read out of them is kept beside the row
 * so Celeste can say what the file is without the bytes ever leaving this Mac.
 */

/** How much of a PDF Celeste is shown. A contract is not worth the whole prompt. */
export const ATTACHMENT_EXCERPT_LIMIT = 20_000;

/**
 * The text layer of a PDF, or null when there is none: a scan is pixels, and
 * pretending otherwise would put an empty fence in Celeste's prompt. A file
 * that cannot be parsed at all is still a file the operator meant to give her,
 * so it is kept without an excerpt rather than refused.
 */
async function pdfText(bytes: Buffer): Promise<string | null> {
  try {
    // Imported here rather than at the top: pdf-parse pulls pdfjs in behind
    // it, and a file that is not a PDF should not pay for that.
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const result = await parser.getText({ pageJoiner: "\n" });
      const text = result.text.trim();
      return text === "" ? null : text.slice(0, ATTACHMENT_EXCERPT_LIMIT);
    } finally {
      await parser.destroy();
    }
  } catch {
    return null;
  }
}

/** What one file leaves behind once it is in: where the bytes are, and what could be read of them. */
export interface IngestedFile {
  sha256: string;
  path: string;
  textExcerpt: string | null;
}

/**
 * The bytes first, then the excerpt: a row written after this can never point
 * at a file that is not on disk. Called by everything that takes a file from
 * the operator, so a PDF reads the same on a draft as it does in a
 * conversation.
 */
export async function ingestFile(cfg: Config, file: { mimeType: string; bytes: Buffer }): Promise<IngestedFile> {
  const { sha256, path } = await writeBlob(cfg, file.bytes);
  const textExcerpt = file.mimeType.toLowerCase() === "application/pdf" ? await pdfText(file.bytes) : null;
  return { sha256, path, textExcerpt };
}

/** Sizes as a refusal states them, so "25 MB" reads like the limit rather than like a byte count. */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
