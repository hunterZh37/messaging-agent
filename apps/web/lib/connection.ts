/**
 * Whether the page can still reach Celeste (operator, 2026-09-17: a visual
 * indicator for an online or offline system).
 *
 * Not whether the device has a network. Celeste is reached over the tailnet,
 * so a phone can be on wifi, call itself online, and have no way to this
 * server at all; the only honest question is whether the last few pulses came
 * back.
 */

/**
 * Missed pulses before the app admits it is offline. One is a dropped packet,
 * and flipping on that would flicker the indicator on a perfectly good
 * connection; two in a row, three seconds apart, is the server or the tailnet
 * actually gone.
 */
export const OFFLINE_AFTER = 2;

/**
 * How often the page asks whether it can still reach Celeste.
 */
export const PULSE_MS = 3_000;

/**
 * How long one pulse may take before it counts as missed.
 *
 * A pulse without a deadline is the difference between the desktop, where
 * this worked, and the phone, where it did not (operator, 2026-09-17: the
 * phone still shows green). Stopping the server on this Mac refuses the
 * connection at once and the pulse fails in milliseconds. A phone whose
 * tailnet has gone is not refused by anything: the packets leave and no
 * answer ever comes, so `fetch` sat there for the best part of a minute, the
 * failure was never recorded, and the dot stayed green the whole time.
 *
 * Shorter than the interval, so a hung pulse is counted before the next one
 * is sent and two of them still make six seconds rather than forever.
 */
export const PULSE_TIMEOUT_MS = 2_500;

/**
 * An abort signal that fires after `ms`. `AbortSignal.timeout` is not in
 * older iOS Safari, which is exactly the browser this bug was found in.
 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const control = new AbortController();
  setTimeout(() => control.abort(), ms);
  return control.signal;
}

/**
 * Why the app is not working, when it is not.
 *
 * "unreachable" is the page unable to reach Celeste: over the tailnet, a
 * phone that has wandered off it. "no-network" is Celeste itself with no way
 * out, which on the operator's own Mac is the common one and the one the
 * page cannot see for itself, since loopback answers happily with the wifi
 * off (operator, 2026-09-17).
 */
export type Fault = "unreachable" | "no-network";

export interface Connection {
  /** Consecutive pulses that did not come back. */
  missed: number;
  /** Null until the first pulse has answered either way. */
  online: boolean | null;
  fault: Fault | null;
}

export const UNKNOWN: Connection = { missed: 0, online: null, fault: null };

/** What a pulse came back with. `net` is null when the server did not say. */
export interface Pulse {
  ok: boolean;
  net?: boolean | null;
}

/**
 * The connection after one pulse. A pulse that answers clears the count at
 * once: coming back is believed immediately, going away only after a second
 * failure, because a wrong "offline" is noise and a wrong "online" is a lie
 * about whether mail is arriving.
 */
export function afterPulse(prev: Connection, pulse: Pulse): Connection {
  if (pulse.ok) {
    // Reaching Celeste is not the same as Celeste being able to do anything.
    // A server that says it has no network is reported at once: it is a fact
    // it knows about itself, not a guess from a missed packet.
    if (pulse.net === false) return { missed: 0, online: false, fault: "no-network" };
    return { missed: 0, online: true, fault: null };
  }
  const missed = prev.missed + 1;
  if (missed < OFFLINE_AFTER) return { ...prev, missed };
  return { missed, online: false, fault: "unreachable" };
}

/**
 * The browser saying the device lost its network. Believed at once, since it
 * cannot be wrong in that direction: no network is certainly no Celeste.
 */
export function afterNetworkLoss(): Connection {
  return { missed: OFFLINE_AFTER, online: false, fault: "no-network" };
}
