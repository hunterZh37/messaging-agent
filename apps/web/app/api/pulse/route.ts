import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { hasNetwork, schema } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { isSameOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/**
 * "Anything new?" (operator, 2026-09-11: Need to reply should show a new
 * message on its own). The newest moment anything was stored, which the
 * open page compares with what it last saw and reads itself again when it
 * moves. One number, one index, cheap enough to ask every few seconds.
 */
export async function GET(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { db } = core();
  const latest = db.select({ at: sql<number | null>`max(${schema.messages.receivedAt})` }).from(schema.messages).get()?.at ?? 0;
  // Whether this Mac is on a network, which the page cannot work out for
  // itself: Celeste is on the same machine, so loopback keeps answering long
  // after the wifi has gone (operator, 2026-09-17).
  return NextResponse.json({ latest, net: hasNetwork() });
}
