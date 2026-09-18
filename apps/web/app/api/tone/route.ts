import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/origin";
import { startToneRun, stopToneRun, toneState } from "@/lib/toneRun";

export const dynamic = "force-dynamic";

/** How far the reading has got, asked every couple of seconds while it runs. */
export async function GET(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(toneState());
}

/**
 * Start the reading, or stop one that is going. A route rather than a server
 * action because it runs for minutes and a page's server actions are
 * serialized behind each other.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { stop?: boolean };
  return NextResponse.json(body.stop ? stopToneRun() : startToneRun());
}
