import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Names for the handles Messages knows people by (2026-09-11). A handle is
 * a phone number or an email; the address book keeps both against a
 * record. Numbers are matched on their digits from the right, so a stored
 * "(415) 555-0100" meets "+14155550100" as it appears in chat.db.
 */
export interface AddressBookEntry {
  handle: string;
  name: string;
}

/** A handle in the one form both sides can be compared in: lower-cased email, or the last ten digits of a number. */
export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  if (h.includes("@")) return h;
  const digits = h.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Every address book file on this Mac: the main one and one per synced source. */
export function addressBookFiles(root: string = path.join(homedir(), "Library/Application Support/AddressBook")): string[] {
  const files: string[] = [];
  const main = path.join(root, "AddressBook-v22.abcddb");
  if (existsSync(main)) files.push(main);
  const sources = path.join(root, "Sources");
  // Names are a courtesy (2026-09-15): a process without access to Contacts,
  // the login service before Full Disk Access, gets none rather than a sync
  // that fails on "operation not permitted".
  try {
    if (existsSync(sources)) {
      for (const dir of readdirSync(sources)) {
        const f = path.join(sources, dir, "AddressBook-v22.abcddb");
        if (existsSync(f)) files.push(f);
      }
    }
  } catch {
    /* no access to the address book folder */
  }
  return files;
}

function displayName(r: { first: string | null; last: string | null; org: string | null; nick: string | null }): string | null {
  const person = [r.first, r.last].filter((x) => x && x.trim()).join(" ").trim();
  if (person) return person;
  if (r.nick && r.nick.trim()) return r.nick.trim();
  if (r.org && r.org.trim()) return r.org.trim();
  return null;
}

/**
 * Reads every address book file read-only and returns one name per
 * normalized handle. A handle under two records keeps the first name met;
 * a file that cannot be opened is skipped, since names are a courtesy and
 * never a reason to stop a sync.
 */
export function readAddressBook(files: string[] = addressBookFiles()): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of files) {
    let db: Database.Database | null = null;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      const records = new Map<number, string>();
      for (const r of db
        .prepare("select Z_PK as pk, ZFIRSTNAME as first, ZLASTNAME as last, ZORGANIZATION as org, ZNICKNAME as nick from ZABCDRECORD")
        .all() as { pk: number; first: string | null; last: string | null; org: string | null; nick: string | null }[]) {
        const name = displayName(r);
        if (name) records.set(r.pk, name);
      }
      const put = (handle: string | null, owner: number) => {
        if (!handle) return;
        const name = records.get(owner);
        if (!name) return;
        const key = normalizeHandle(handle);
        if (key && !names.has(key)) names.set(key, name);
      };
      for (const p of db.prepare("select ZFULLNUMBER as handle, ZOWNER as owner from ZABCDPHONENUMBER").all() as { handle: string | null; owner: number }[]) put(p.handle, p.owner);
      for (const e of db.prepare("select ZADDRESS as handle, ZOWNER as owner from ZABCDEMAILADDRESS").all() as { handle: string | null; owner: number }[]) put(e.handle, e.owner);
    } catch {
      // Unreadable or locked: skip this file.
    } finally {
      db?.close();
    }
  }
  return names;
}
