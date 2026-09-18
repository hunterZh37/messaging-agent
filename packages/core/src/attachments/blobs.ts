import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config";

/**
 * Attachment bytes live on disk, content-addressed by sha256 (spec 11a):
 * the same file attached to twenty messages costs one copy, and a blob is
 * never rewritten once it exists.
 */
export async function writeBlob(cfg: Config, bytes: Buffer): Promise<{ sha256: string; path: string }> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = path.join(cfg.blobsDir, sha256);
  await mkdir(cfg.blobsDir, { recursive: true });

  try {
    await stat(file);
    return { sha256, path: file };
  } catch {
    /* not there yet: write it */
  }

  // Write under a temp name and rename, so a crash mid-write never leaves a
  // half file where a reader would trust it as the whole attachment.
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { sha256, path: file };
}

export async function readBlob(file: string): Promise<Buffer> {
  return readFile(file);
}
