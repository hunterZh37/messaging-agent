import { NextResponse } from "next/server";
import { deleteSubscription } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { isSameOrigin } from "@/lib/origin";

/** A phone turning notifications off (2026-09-14). */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { endpoint?: unknown } | null;
  if (typeof body?.endpoint !== "string") return NextResponse.json({ error: "No endpoint." }, { status: 400 });
  deleteSubscription(core().db, body.endpoint);
  return NextResponse.json({ ok: true });
}
