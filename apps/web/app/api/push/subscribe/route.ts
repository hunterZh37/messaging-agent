import { NextResponse } from "next/server";
import { saveSubscription } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { isSameOrigin } from "@/lib/origin";
import { sendNotices } from "@/lib/push";

/** A phone asking for notifications (2026-09-14). It gets one straight away, so the operator sees it works. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = typeof body?.endpoint === "string" && body.endpoint.startsWith("https://") ? body.endpoint : null;
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : null;
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : null;
  if (!endpoint || !p256dh || !auth) return NextResponse.json({ error: "That is not a push subscription." }, { status: 400 });
  saveSubscription(core().db, { endpoint, keys: { p256dh, auth } }, req.headers.get("user-agent"));
  await sendNotices([{ title: "Celeste", body: "Notifications are on. New messages that need a reply will show here.", url: "/inbox?status=needs_reply", tag: "celeste-hello" }]);
  return NextResponse.json({ ok: true });
}
