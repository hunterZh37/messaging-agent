import { describe, it, expect } from "vitest";
import { hasNetwork } from "../../src/net/network";

type Iface = Parameters<typeof hasNetwork>[0];

function iface(rows: { name: string; family: "IPv4" | "IPv6"; address: string; internal?: boolean }[]): Iface {
  const out: Record<string, { family: string; address: string; internal: boolean }[]> = {};
  for (const r of rows) {
    out[r.name] ??= [];
    out[r.name]!.push({ family: r.family, address: r.address, internal: r.internal ?? false });
  }
  return out as unknown as Iface;
}

describe("hasNetwork", () => {
  it("sees a Mac on wifi", () => {
    expect(
      hasNetwork(
        iface([
          { name: "lo0", family: "IPv4", address: "127.0.0.1", internal: true },
          { name: "en0", family: "IPv4", address: "10.0.0.157" },
        ]),
      ),
    ).toBe(true);
  });

  it("sees a Mac whose wifi has gone, keeping only link-local addresses", () => {
    expect(
      hasNetwork(
        iface([
          { name: "lo0", family: "IPv4", address: "127.0.0.1", internal: true },
          { name: "lo0", family: "IPv6", address: "fe80::1", internal: true },
          { name: "en0", family: "IPv6", address: "fe80::142a:432a:ee6d:b454" },
          { name: "awdl0", family: "IPv6", address: "fe80::6cb3:7ff:fec6:1890" },
        ]),
      ),
    ).toBe(false);
  });

  it("does not count Tailscale as a way out: it has an address of its own", () => {
    expect(
      hasNetwork(
        iface([
          { name: "lo0", family: "IPv4", address: "127.0.0.1", internal: true },
          { name: "utun1", family: "IPv4", address: "100.98.93.28" },
          { name: "utun1", family: "IPv6", address: "fd7a:115c:a1e0::ac3a:5d1c" },
        ]),
      ),
    ).toBe(false);
  });

  it("does not count an address macOS assigned itself after getting no lease", () => {
    expect(hasNetwork(iface([{ name: "en0", family: "IPv4", address: "169.254.13.4" }]))).toBe(false);
  });

  it("counts ethernet, so an unplugged aerial is not mistaken for no network", () => {
    expect(hasNetwork(iface([{ name: "en1", family: "IPv4", address: "192.168.1.40" }]))).toBe(true);
  });

  it("counts a real IPv6 address on its own", () => {
    expect(hasNetwork(iface([{ name: "en0", family: "IPv6", address: "2601:647:4101:bbc0::a0a" }]))).toBe(true);
  });

  it("keeps 100.x addresses outside Tailscale's range, which are ordinary", () => {
    expect(hasNetwork(iface([{ name: "en0", family: "IPv4", address: "100.20.3.4" }]))).toBe(true);
  });
});
