import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The way back (operator, 2026-09-23: "whenever we add an action to Alex,
 * there should be a backlink pointing to the thread, the queue, or the draft
 * of the email ... when I'm in Alex I can just click on a link and that link
 * will take me back to Celeste's email, selected already").
 *
 * The link is not to a draft or a list but to one steady address per thread,
 * `/go/thread/<id>`, which decides on arrival where to land: the draft while
 * one is waiting, the conversation once it has been sent or deleted. An item
 * in Alex outlives the draft that prompted it, and a link that dead-ends a
 * week later would be worse than none.
 *
 * It carries the tailnet name rather than 127.0.0.1, because Alex is read on
 * the phone as often as on the Mac, and only the tailnet name answers on both.
 */

// A tailnet name is worth a second, not a hung Add button: the local address
// is a fine answer when tailscale does not come back (review, 2026-09-24).
const TAILSCALE_TIMEOUT_MS = 2_000;
const run = promisify(execFile);

/** One steady address for a thread, wherever the operator opens it. */
export function celesteLink(base: string, threadId: string): string {
  return `${base.replace(/\/+$/, "")}/go/thread/${encodeURIComponent(threadId)}`;
}

/** What a link says above itself, in an item that has no field for one. */
export const LINK_LABEL = "Open in Celeste";

let held: { at: number; base: string } | null = null;
const HOLD_MS = 10 * 60_000;

/**
 * Where this Celeste answers from, for a link somebody else will click.
 *
 * `CELESTE_PUBLIC_URL` settles it when it is set. Otherwise the tailnet name
 * is asked of the running Tailscale, which is where the phone reaches this
 * Mac; the answer is held for ten minutes, since it changes about never.
 * With no Tailscale at all the local address is used: on the Mac it works,
 * and on the phone it is at least honest about what this install has.
 */
export async function publicBase(
  cfg: { publicUrl?: string | undefined },
  clock: () => number = Date.now,
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string }> = (cmd, args) => run(cmd, args, { timeout: TAILSCALE_TIMEOUT_MS }),
): Promise<string> {
  const set = cfg.publicUrl?.trim();
  if (set) return set.replace(/\/+$/, "");
  if (held && clock() - held.at < HOLD_MS) return held.base;

  let base = "http://127.0.0.1:3100";
  try {
    const { stdout } = await exec("tailscale", ["status", "--json"]);
    const name = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
    if (name) base = `https://${name}`;
  } catch {
    // No Tailscale, or it is not running: the local address stands.
  }
  held = { at: clock(), base };
  return base;
}

/** Forget the held name: for a test, or after the tailnet changes. */
export function forgetPublicBase(): void {
  held = null;
}
