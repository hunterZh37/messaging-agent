import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBlob, writeBlob } from "../../src/attachments/blobs";
import type { Config } from "../../src/config";

let dir: string;
let cfg: Config;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "blobs-test-"));
  cfg = { blobsDir: path.join(dir, "blobs") } as Config;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeBlob", () => {
  it("stores the bytes at a path named for their sha256", async () => {
    const bytes = Buffer.from("hello attachment");
    const { sha256, path: file } = await writeBlob(cfg, bytes);
    expect(sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(file).toBe(path.join(cfg.blobsDir, sha256));
    expect(await readBlob(file)).toEqual(bytes);
  });

  it("dedupes identical bytes into one file", async () => {
    const a = await writeBlob(cfg, Buffer.from("same"));
    const b = await writeBlob(cfg, Buffer.from("same"));
    expect(b.path).toBe(a.path);
    expect(await readdir(cfg.blobsDir)).toEqual([a.sha256]);
  });

  it("leaves no temp files behind", async () => {
    const { sha256 } = await writeBlob(cfg, Buffer.from("tidy"));
    expect(await readdir(cfg.blobsDir)).toEqual([sha256]);
  });

  it("keeps different bytes in different files", async () => {
    const a = await writeBlob(cfg, Buffer.from("one"));
    const b = await writeBlob(cfg, Buffer.from("two"));
    expect(a.sha256).not.toBe(b.sha256);
    expect((await readdir(cfg.blobsDir)).sort()).toEqual([a.sha256, b.sha256].sort());
  });
});

describe("readBlob", () => {
  it("throws when the file is missing", async () => {
    await expect(readBlob(path.join(cfg.blobsDir, "nope"))).rejects.toThrow();
  });

  it("reads back whatever is on disk, even when it is corrupt", async () => {
    const { path: file } = await writeBlob(cfg, Buffer.from("original"));
    await writeFile(file, "tampered");
    expect((await readBlob(file)).toString()).toBe("tampered");
  });
});
