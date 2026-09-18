import { readFile } from "node:fs/promises";

export type Blocklist = Set<string>;

export function normalizeAddress(a: string): string {
  const t = a.trim().toLowerCase();
  if (t.includes("@")) return t;
  return t.replace(/[^\d+]/g, "");
}

export function parseBlocklist(text: string): Blocklist {
  const out: Blocklist = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line) out.add(normalizeAddress(line));
  }
  return out;
}

export function isBlocked(list: Blocklist, address: string): boolean {
  return list.has(normalizeAddress(address));
}

export async function loadBlocklist(file: string): Promise<Blocklist> {
  try {
    return parseBlocklist(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw err;
  }
}
