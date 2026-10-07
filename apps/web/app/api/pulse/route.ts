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
  // The same question for Ask Celeste (operator, 2026-10-07: two tabs open on
  // Celeste should "only share one ground truth" of the conversation).
  // `chats.updatedAt` is already bumped by every turn, so it is a free index
  // to piggyback on rather than a second table to scan: a tab asks something
  // in one window, and the pulse already running in every other tab and on
  // the phone is what tells them to read the conversation again.
  const chat = db.select({ at: sql<number | null>`max(${schema.chats.updatedAt})` }).from(schema.chats).get()?.at ?? 0;
  // Whether this Mac is on a network, which the page cannot work out for
  // itself: Celeste is on the same machine, so loopback keeps answering long
  // after the wifi has gone (operator, 2026-09-17).
  return NextResponse.json({ latest, chat, net: hasNetwork() });
}
