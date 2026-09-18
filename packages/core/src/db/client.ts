import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sqliteVec from "sqlite-vec";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & {
  /** The better-sqlite3 handle, for the vec0 statements drizzle cannot express. */
  $client: Database.Database;
  /** False when the sqlite-vec extension would not load; every projects function then refuses. */
  vecAvailable: boolean;
};

/** Dimensions of `nomic-embed-text`, and so of the vec0 column (spec 11a). */
export const EMBEDDING_DIMENSIONS = 768;

/** drizzle-kit cannot express a virtual table, so this one is created by hand after the migrations. */
const VECTOR_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS message_embeddings USING vec0(message_id TEXT PRIMARY KEY, embedding float[${EMBEDDING_DIMENSIONS}])`;

/**
 * Keyword search over the mailbox, the tool behind Ask Celeste (spec 10c).
 * Virtual too, so drizzle cannot express it either; unlike the vector table
 * it needs no extension, so it is always there.
 */
const SEARCH_TABLE_SQL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, subject, from_name, from_address, body, tokenize='unicode61')";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../drizzle");

// One line per process, not one per opened database: the reason is the
// machine, so repeating it for every connection says nothing new.
let warnedAboutVec = false;

export function openDb(file: string): Db {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // A backfill or a sync writing in another process must not turn a hide or
  // a delete in the app into "database is locked" (stress loop, 2026-09-11):
  // a write waits up to five seconds for the lock instead of failing at once.
  sqlite.pragma("busy_timeout = 5000");

  let vecAvailable = true;
  try {
    sqliteVec.load(sqlite);
  } catch (err) {
    // An unsupported platform costs the operator projects, nothing else:
    // mail still syncs, sorts, and drafts without vectors.
    vecAvailable = false;
    if (!warnedAboutVec) {
      warnedAboutVec = true;
      console.warn(`sqlite-vec failed to load, so projects are off: ${(err as Error).message}`);
    }
  }

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  if (vecAvailable) sqlite.exec(VECTOR_TABLE_SQL);
  sqlite.exec(SEARCH_TABLE_SQL);
  return Object.assign(db, { vecAvailable }) as Db;
}

export function now(): number {
  return Date.now();
}
