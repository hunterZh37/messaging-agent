import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/origin";
import { syncAll } from "@/lib/syncAll";

/**
 * Sync every inbox now. A route rather than a server action so that a slow
 * sync never holds up the page's other actions (see lib/syncAll.ts). Only
 * the app itself may call it.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await syncAll());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
