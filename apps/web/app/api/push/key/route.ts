import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/origin";
import { vapidPublicKey } from "@/lib/push";

/** The public key a phone subscribes with, or null when push is not set up on the Mac. */
export async function GET(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ key: vapidPublicKey() });
}
