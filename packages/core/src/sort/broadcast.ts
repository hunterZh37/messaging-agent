import type { SortInput } from "./types";

/**
 * Mail sent to a list rather than to the operator (operator, 2026-09-18).
 *
 * The sorter was shown From, Subject and the body and nothing else, so for a
 * mailing-list announcement reading "[RSVP] Fireside Chat … on 10/8" the one
 * fact that settles it was missing: the only recipient is the list, and the
 * operator is not addressed at all. The local model read "RSVP", called it a
 * scheduling request, and put it in Need to reply.
 *
 * Judged here rather than asked of the model, because it is a fact about the
 * envelope and not a matter of opinion. The model still decides whether the
 * mail is worth keeping; this only stops it claiming the operator owes a
 * personal answer to a message that was never addressed to them.
 */

/** An address, lowercased and stripped of the display name around it. */
function bare(address: string): string {
  const inside = address.match(/<([^>]+)>/);
  return (inside?.[1] ?? address).trim().toLowerCase();
}

function domainOf(address: string): string {
  const at = bare(address).lastIndexOf("@");
  return at === -1 ? "" : bare(address).slice(at + 1);
}

function localOf(address: string): string {
  const at = bare(address).lastIndexOf("@");
  return at === -1 ? bare(address) : bare(address).slice(0, at);
}

/** Is this inbox's own address among the recipients? Unknown counts as yes, so nothing is suppressed on a guess. */
export function addressedToOperator(input: SortInput): boolean {
  const me = input.operatorAddress ? bare(input.operatorAddress) : null;
  if (!me) return true;
  const everyone = [...(input.toAddresses ?? []), ...(input.ccAddresses ?? [])].map(bare);
  if (everyone.length === 0) return true;
  return everyone.includes(me);
}

/**
 * Does this mail carry the marks of a mailing list?
 *
 * `via` in the display name is the strongest of these and the one that caught
 * the message this was written for: a list that rewrites the sender leaves
 * "Max Zimo Fan via ases-public" behind, and a person never writes their own
 * name that way. The rest are the addresses lists are sent from and to.
 */
export function looksLikeList(input: SortInput): boolean {
  const name = (input.fromName ?? "").toLowerCase();
  if (/\svia\s\S/.test(name)) return true;

  const addresses = [input.fromAddress, ...(input.toAddresses ?? []), ...(input.ccAddresses ?? [])];
  for (const address of addresses) {
    const domain = domainOf(address);
    const local = localOf(address);
    if (domain.startsWith("lists.") || domain.startsWith("list.") || domain.startsWith("mailman.")) return true;
    if (local.endsWith("-bounces") || local.endsWith("-request") || local.endsWith("-owner")) return true;
    if (local.startsWith("bounce-") || local.startsWith("bounces+")) return true;
  }
  return false;
}

/**
 * List mail the operator was not addressed on: a broadcast. Everyone on the
 * list got it, so nobody in particular owes an answer.
 */
export function isBroadcast(input: SortInput): boolean {
  return looksLikeList(input) && !addressedToOperator(input);
}
