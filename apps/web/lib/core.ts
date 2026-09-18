import path from "node:path";
import { backfillFolders, backfillSearchIndex, convertLegacyHides, loadConfig, openDb, seedCategoriesIfEmpty, type Db, type Config } from "@messaging-agent/core";

export const ENV_PATH = path.resolve(process.cwd(), "../../.env");

let cached: { cfg: Config; db: Db } | null = null;

export function core(): { cfg: Config; db: Db } {
  if (!cached) {
    // The CLI loads the repo-root .env via tsx's --env-file-if-exists flag;
    // Next.js has no equivalent flag, so load it here before reading config.
    try {
      process.loadEnvFile(ENV_PATH);
    } catch {
      /* no root .env */
    }
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    // First run has no sub-categories; the starter list is what the editor opens on.
    seedCategoriesIfEmpty(db);
    // Mail stored before folders existed still needs one (spec 10a).
    backfillFolders(db);
    // Threads hidden before 2026-09-15 sat in Deleted items; Hide now keeps them in Inbox.
    convertLegacyHides(db);
    // Mail stored before the keyword index existed is not findable until it
    // is in there, and Ask Celeste searches through it (spec 10c).
    backfillSearchIndex(db);
    cached = { cfg, db };
  }
  return cached;
}

/** Forces the next core() call to reload config (and reopen the db). */
export function resetCore(): void {
  cached = null;
}
