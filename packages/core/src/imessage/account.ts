import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { now, type Db } from "../db/client";
import { accounts, type AccountRow } from "../db/schema";
import type { ImessageSource } from "./types";

export const IMESSAGE_EMAIL_PREFIX = "messages:";

/** The one Messages account on this Mac, if connected. */
export function imessageAccount(db: Db): AccountRow | null {
  return db.select().from(accounts).where(eq(accounts.provider, "imessage")).get() ?? null;
}

/**
 * Connects Messages on this Mac as an account (2026-09-11). Its "email" is
 * the handle Messages sends as, behind a prefix so it can never collide
 * with a mail inbox that uses the same address (the Outlook inbox does).
 */
export function connectImessageAccount(db: Db, source: ImessageSource, clock: () => number = now): AccountRow {
  const existing = imessageAccount(db);
  if (existing) return existing;
  const handle = source.ownHandle() ?? "this-mac";
  const id = randomUUID();
  db.insert(accounts)
    .values({ id, provider: "imessage", email: `${IMESSAGE_EMAIL_PREFIX}${handle}`, displayName: "Messages", createdAt: clock(), status: "ok" })
    .run();
  return db.select().from(accounts).where(eq(accounts.id, id)).get()!;
}
