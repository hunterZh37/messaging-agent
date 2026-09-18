import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/origin";
import { declareType } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { psychState, startPsychRun, stopPsychRun } from "@/lib/psychRun";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json(psychState());
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { stop?: boolean; type?: string };
  if (body.stop) return NextResponse.json(stopPsychRun());
  // Claiming a type and testing it are one press: nobody sets a type in order
  // to leave it unexamined.
  if (body.type) {
    try {
      declareType(core().db, body.type);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
  }
  return NextResponse.json(startPsychRun());
}
