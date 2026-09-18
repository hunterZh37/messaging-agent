import { networkInterfaces } from "node:os";

/**
 * Whether this Mac has a network at all (operator, 2026-09-17: "I close the
 * wifi, the dot goes red for a little bit and then back to green even when
 * the wifi is off").
 *
 * The connection indicator used to ask only whether the page could reach
 * Celeste, and Celeste runs on the same Mac as the browser. Over loopback
 * that stays true with the wifi off, so the dot went red on the browser's own
 * offline event and then cheerfully back to green three seconds later, while
 * no mail could arrive at all.
 *
 * So the server answers for itself. No packets are sent to anybody to work
 * this out: an interface either holds a usable address or it does not.
 */

/**
 * Addresses that are still there after the wifi goes, and so prove nothing.
 *
 * `fe80::` is link-local, which every interface keeps whether or not it is
 * connected to anything. `169.254.` is what macOS assigns itself when it
 * joined a network but got no DHCP lease. `100.64/10` and `fd7a:` are
 * Tailscale's own interface, which has an address of its own and is not a
 * route to the internet.
 */
function usable(family: string, address: string): boolean {
  const a = address.toLowerCase();
  if (family === "IPv4") {
    if (a.startsWith("169.254.")) return false;
    const [first, second] = a.split(".").map(Number);
    // 100.64.0.0 - 100.127.255.255, the carrier-grade NAT range Tailscale uses.
    if (first === 100 && second !== undefined && second >= 64 && second <= 127) return false;
    return true;
  }
  if (a.startsWith("fe80")) return false;
  if (a.startsWith("fd7a:")) return false;
  return true;
}

/**
 * True when some interface holds an address that could carry traffic off this
 * machine.
 *
 * It answers "is this Mac on a network", not "does the internet work". A
 * router that is up but not passing traffic still reads as connected here,
 * which is why the indicator this feeds says "No network" rather than
 * promising that mail is flowing.
 */
export function hasNetwork(interfaces = networkInterfaces()): boolean {
  for (const addresses of Object.values(interfaces)) {
    for (const a of addresses ?? []) {
      if (a.internal) continue;
      if (usable(a.family, a.address)) return true;
    }
  }
  return false;
}
