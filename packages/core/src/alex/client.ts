/**
 * The scheduling agent (spec 10e), reached over MCP. It exposes a Streamable
 * HTTP server, and this is the client: one POST carries
 * one JSON-RPC call and gets one answer back. The server is stateless, so
 * there is no `initialize` handshake to do and no session to hold.
 *
 * Every tool here is deterministic code over Alex's own database. Celeste
 * calls them after the operator has pressed Add; no model on either side
 * talks to the other ("Not agent-to-agent", spec 10e).
 */

/**
 * The two items Celeste hands over, and what each needs (Alex's own schemas).
 * An actionable is Alex's own word for a day-scoped to-do; an event is a slot
 * already agreed. Reminders are Alex's to make, not Celeste's to push
 * (operator, 2026-09-16: "just do actionable, event").
 */
export type AlexItem =
  | { kind: "actionable"; title: string; dayISO: string; startISO?: string; endISO?: string; items?: string[]; link?: string }
  | { kind: "event"; title: string; startISO: string; endISO: string; location?: string; description?: string; link?: string };

export type AlexKind = AlexItem["kind"];

/** Which of Alex's private tools each kind is written with. */
export const ALEX_TOOL: Record<AlexKind, string> = {
  actionable: "create_actionable",
  event: "create_event",
};

/** What Alex hands back: the id it filed the item under, whatever it calls it. */
export interface AlexWrite {
  /** `todoId` or `eventId`, so the thread can show and chase it. */
  id: string;
  /** Everything Alex answered, kept as it came for the thread to read later. */
  raw: Record<string, unknown>;
}

export interface AlexConfig {
  /** The scheduling agent's MCP endpoint; undefined when none is configured. */
  url: string | undefined;
  token: string | undefined;
}

/**
 * No scheduling agent to write to: either no address, or no token for the
 * private tier the write tools live on. There is no default address on
 * purpose, so an unconfigured install calls nobody.
 */
export class AlexNotConnected extends Error {
  constructor() {
    super("No scheduling agent is connected. Set ALEX_MCP_URL and ALEX_MCP_TOKEN in .env, then restart.");
    this.name = "AlexNotConnected";
  }
}

/** Whether both halves are present, which is what the button reads to say so. */
export function alexConnected(config: AlexConfig): boolean {
  return Boolean(config.url && config.token);
}

/** Alex answered, and said no. The message is Alex's own, fit to show. */
export class AlexRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlexRefused";
  }
}

import { LINK_LABEL } from "./link";

const TIMEOUT_MS = 20_000;

/** The arguments each kind goes over the wire as. */
export function argumentsFor(item: AlexItem): Record<string, unknown> {
  // The way back to the mail this came from (2026-09-23). An event has a
  // description to hold it; an actionable has only its list, so the link is
  // a line of that list. Neither kind has a field meant for a link, so it
  // goes in labelled, rather than as a bare address in the middle of prose.
  const line = item.link ? `${LINK_LABEL}: ${item.link}` : null;
  if (item.kind === "actionable") {
    // Both times or neither: Alex rejects half a range.
    const timed = item.startISO && item.endISO ? { startISO: item.startISO, endISO: item.endISO } : {};
    const items = [...(item.items ?? []), ...(line ? [line] : [])];
    return { title: item.title, dayISO: item.dayISO, ...timed, ...(items.length > 0 ? { items } : {}) };
  }
  const description = [item.description, line].filter(Boolean).join("\n\n");
  return {
    title: item.title,
    startISO: item.startISO,
    endISO: item.endISO,
    ...(item.location ? { location: item.location } : {}),
    ...(description ? { description } : {}),
  };
}

/** The id Alex returns, under whichever name that tool uses. */
function idOf(result: Record<string, unknown>): string | null {
  for (const key of ["todoId", "eventId", "id"]) {
    const v = result[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** One slot Alex says is free, as it came back: UTC instants. */
export interface AlexSlot {
  startISO: string;
  endISO: string;
}

/**
 * The slots Alex will let a stranger book in a range, which is the best answer
 * it has to "when am I free" (operator, 2026-09-16). These are *bookable*
 * slots, so the owner's working hours, minimum notice and buffers apply: the
 * picker offers them as suggestions and still lets any time be typed, because
 * an actionable at 8pm is the operator's business and not a meeting.
 *
 * `get_availability` is Alex's public tier, so this works with or without the
 * token; an empty list is an answer, not a failure.
 */
export async function freeTimes(
  range: { startISO: string; endISO: string; minutes: number },
  config: AlexConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ slots: AlexSlot[]; timezone: string }> {
  const result = await callAlex(
    "get_availability",
    { startISO: range.startISO, endISO: range.endISO, durationMinutes: range.minutes },
    config,
    fetchImpl,
  );
  const slots = Array.isArray(result.slots) ? result.slots : [];
  return {
    slots: slots
      .map((s) => s as { start?: unknown; end?: unknown })
      .filter((s) => typeof s.start === "string" && typeof s.end === "string")
      .map((s) => ({ startISO: s.start as string, endISO: s.end as string })),
    timezone: typeof result.timezone === "string" ? result.timezone : "UTC",
  };
}

/**
 * Writes one item to Alex. Throws `AlexNotConnected` when no token is set and
 * `AlexRefused` when Alex answers with a refusal: a tool that fails comes back
 * as a normal result carrying `isError`, not as a JSON-RPC error, so both have
 * to be read.
 */
export async function addToAlex(item: AlexItem, config: AlexConfig, fetchImpl: typeof fetch = fetch): Promise<AlexWrite> {
  if (!alexConnected(config)) throw new AlexNotConnected();
  const parsed = await callAlex(ALEX_TOOL[item.kind], argumentsFor(item), config, fetchImpl);
  const id = idOf(parsed);
  if (!id) throw new AlexRefused("Alex did not say what it filed the item under.");
  return { id, raw: parsed };
}

/**
 * One `tools/call`, and the JSON Alex answered with. A tool that refuses comes
 * back as an ordinary result carrying `isError` rather than a JSON-RPC error,
 * so both have to be read.
 */
async function callAlex(
  name: string,
  args: Record<string, unknown>,
  config: AlexConfig,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  if (!config.url) throw new AlexNotConnected();
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };

  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // get_availability is public; a token only unlocks the write tools.
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: control.signal,
    });
  } catch (e) {
    throw new AlexRefused(e instanceof Error && e.name === "AbortError" ? "Alex did not answer in time." : "Alex could not be reached.");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) throw new AlexRefused("The scheduling agent would not take the token. Check ALEX_MCP_TOKEN.");
  if (!response.ok) throw new AlexRefused(`Alex answered ${response.status}.`);

  const payload = (await response.json().catch(() => null)) as
    | { result?: { content?: { type?: string; text?: string }[]; isError?: boolean }; error?: { message?: string } }
    | null;
  if (!payload) throw new AlexRefused("Alex answered something that was not JSON.");
  if (payload.error) throw new AlexRefused(payload.error.message ?? "Alex refused the call.");

  // An MCP tool result is content blocks; Alex puts its JSON in the first as text.
  const text = payload.result?.content?.find((c) => c.type === "text" || typeof c.text === "string")?.text ?? "";
  if (payload.result?.isError) throw new AlexRefused(text || "Alex could not do it.");

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AlexRefused(text || "Alex answered with nothing to read.");
  }
}
