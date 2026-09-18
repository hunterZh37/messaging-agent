import { promises as dns } from "node:dns";
import { GMAIL_SETTINGS, type ImapSettings } from "./types";

export type DetectedProvider = "gmail" | "outlook" | "generic";

export interface Detection {
  provider: DetectedProvider;
  /** Present only when the host and ports are known without asking the operator. */
  settings?: ImapSettings;
}

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const OUTLOOK_DOMAINS = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

/** True when host is exactly suffix or a subdomain of it, so "notgoogle.com" never matches "google.com". */
function underDomain(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

async function resolveMxDefault(domain: string): Promise<string[]> {
  const records = await dns.resolveMx(domain);
  return records.map((r) => r.exchange);
}

/**
 * Works out how an address connects: Gmail over IMAP, Microsoft sign-in, or a
 * generic IMAP host the operator supplies. Consumer domains are answered from
 * the table; anything else is decided by the domain's MX records.
 */
export async function detectProvider(
  address: string,
  resolveMx: (domain: string) => Promise<string[]> = resolveMxDefault,
): Promise<Detection> {
  const at = address.lastIndexOf("@");
  const domain = at === -1 ? "" : address.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes(".")) throw new Error(`Not an email address: ${address}`);

  if (GMAIL_DOMAINS.has(domain)) return { provider: "gmail", settings: { ...GMAIL_SETTINGS } };
  if (OUTLOOK_DOMAINS.has(domain)) return { provider: "outlook" };

  let exchanges: string[] = [];
  try {
    exchanges = await resolveMx(domain);
  } catch {
    // No MX, no DNS, no answer: the operator supplies the host instead.
    return { provider: "generic" };
  }

  const hosts = exchanges.map((e) => e.trim().toLowerCase().replace(/\.$/, ""));
  if (hosts.some((h) => underDomain(h, "google.com") || underDomain(h, "googlemail.com"))) {
    return { provider: "gmail", settings: { ...GMAIL_SETTINGS } };
  }
  if (hosts.some((h) => underDomain(h, "outlook.com"))) return { provider: "outlook" };
  return { provider: "generic" };
}
