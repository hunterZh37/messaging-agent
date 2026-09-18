import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../../src/config";
import { openDb, type Db } from "../../src/db/client";
import type { AccountRow } from "../../src/db/schema";

/** Config on a throwaway data dir, so a test that writes blobs never touches ~/messaging-agent. */
export function testConfig(): Config {
  const dir = mkdtempSync(path.join(tmpdir(), "core-test-"));
  return loadConfig({ MESSAGING_AGENT_DATA_DIR: dir }, dir);
}

export function testDb(): Db {
  return openDb(":memory:");
}

/** A complete AccountRow with every optional column filled in, so tests only state what they care about. */
export function accountRow(p: Partial<AccountRow> & Pick<AccountRow, "id" | "provider" | "email">): AccountRow {
  return {
    displayName: null,
    createdAt: 1,
    status: "ok",
    lastError: null,
    imapHost: null,
    imapPort: null,
    smtpHost: null,
    smtpPort: null,
    kind: null,
    backfilledSince: null,
    ...p,
  };
}
