import { cookies, headers } from "next/headers";
import { isLocalRequest, SESSION_COOKIE, verifySession } from "@/lib/lock";
import { loadRepoEnv } from "@/lib/env";

/**
 * Whether the page being rendered is for someone allowed in: this Mac's own
 * browser, or a phone that has unlocked (2026-09-14). The root layout asks,
 * because it puts the Ask panel's conversation into every page, and the
 * unlock screen must carry none of it.
 */
export async function requestIsUnlocked(): Promise<boolean> {
  const h = await headers();
  if (isLocalRequest(h)) return true;
  loadRepoEnv();
  return verifySession(process.env.CELESTE_PASSCODE, (await cookies()).get(SESSION_COOKIE)?.value);
}
