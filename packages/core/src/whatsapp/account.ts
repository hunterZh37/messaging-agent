import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { now, type Db } from "../db/client";
import { accounts, type AccountRow } from "../db/schema";
import type { WhatsappSource } from "./types";

export const WHATSAPP_EMAIL_PREFIX = "whatsapp:";

export function whatsappAccount(db: Db): AccountRow | null {
  return db.select().from(accounts).where(eq(accounts.provider, "whatsapp")).get() ?? null;
}

/** One WhatsApp account for this Mac (spec 10g), keyed by the operator's number. */
export function connectWhatsappAccount(db: Db, source: WhatsappSource, clock: () => number = now): AccountRow {
  const existing = whatsappAccount(db);
  if (existing) return existing;
  const own = source.own();
  const id = randomUUID();
  db.insert(accounts)
    .values({ id, provider: "whatsapp", email: `${WHATSAPP_EMAIL_PREFIX}${own?.phone ?? "this-mac"}`, displayName: "WhatsApp", createdAt: clock(), status: "ok" })
    .run();
  return db.select().from(accounts).where(eq(accounts.id, id)).get()!;
}
