import { describe, it, expect } from "vitest";
import { afterNetworkLoss, afterPulse, OFFLINE_AFTER, PULSE_MS, PULSE_TIMEOUT_MS, UNKNOWN } from "../lib/connection";

describe("afterPulse", () => {
  it("says nothing either way until a pulse has answered", () => {
    expect(UNKNOWN.online).toBeNull();
  });

  it("goes online the moment one answers", () => {
    expect(afterPulse(UNKNOWN, { ok: true, net: true })).toEqual({ missed: 0, online: true, fault: null });
  });

  it("does not cry offline over a single dropped pulse", () => {
    const one = afterPulse({ missed: 0, online: true, fault: null }, { ok: false });
    expect(one.online).toBe(true);
    expect(one.missed).toBe(1);
  });

  it("goes offline once they keep missing", () => {
    let c = { missed: 0, online: true as boolean | null, fault: null as "unreachable" | "no-network" | null };
    for (let i = 0; i < OFFLINE_AFTER; i += 1) c = afterPulse(c, { ok: false });
    expect(c.online).toBe(false);
    expect(c.fault).toBe("unreachable");
  });

  it("comes back at once when one answers again, without waiting out a count", () => {
    const down = { missed: 9, online: false as boolean | null, fault: "unreachable" as const };
    expect(afterPulse(down, { ok: true, net: true })).toEqual({ missed: 0, online: true, fault: null });
  });

  it("stays unknown while pulses fail before any has ever answered", () => {
    expect(afterPulse(UNKNOWN, { ok: false }).online).toBeNull();
  });
});

describe("afterNetworkLoss", () => {
  it("is believed at once, because no network is certainly no Celeste", () => {
    expect(afterNetworkLoss().online).toBe(false);
  });

  it("leaves the count high, so a stale event cannot quietly undo it", () => {
    expect(afterNetworkLoss().missed).toBeGreaterThanOrEqual(OFFLINE_AFTER);
  });
});

describe("the wifi going off on the Mac Celeste runs on", () => {
  it("stays offline even though loopback keeps answering", () => {
    // Exactly the bug: the pulse succeeds, because the server is on this same
    // machine, and the old code read that as being back online.
    const c = afterPulse({ missed: 0, online: true, fault: null }, { ok: true, net: false });
    expect(c.online).toBe(false);
    expect(c.fault).toBe("no-network");
  });

  it("does not need two pulses to believe it, the server having said so itself", () => {
    const c = afterPulse(UNKNOWN, { ok: true, net: false });
    expect(c.online).toBe(false);
  });

  it("comes back the moment the server reports a network again", () => {
    const down = afterPulse(UNKNOWN, { ok: true, net: false });
    expect(afterPulse(down, { ok: true, net: true }).online).toBe(true);
  });

  it("treats a server that says nothing about its network as reachable, as before", () => {
    expect(afterPulse(UNKNOWN, { ok: true }).online).toBe(true);
  });
});

describe("a pulse that hangs rather than fails", () => {
  it("is given less time than the gap between pulses, so it is counted and not lost", () => {
    // The phone's fault: over a tailnet that has gone, nothing refuses the
    // connection, so without a deadline the fetch never resolves and the
    // miss is never recorded.
    expect(PULSE_TIMEOUT_MS).toBeLessThan(PULSE_MS);
  });

  it("means going offline still takes seconds rather than a minute", () => {
    expect(OFFLINE_AFTER * PULSE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
