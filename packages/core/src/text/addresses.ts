/**
 * Parses an RFC822 address-list header value into lowercased addresses with
 * optional display names. Provider-neutral: any transport that hands us raw
 * headers uses it.
 */
export function parseAddressList(value: string | undefined): { address: string; name: string | null }[] {
  if (!value) return [];
  const out: { address: string; name: string | null }[] = [];
  // Split on commas that are not inside double quotes.
  const parts = value.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const m = p.match(/^(.*?)<([^>]+)>$/);
    if (m) {
      const name = m[1]!.trim().replace(/^"|"$/g, "").trim();
      out.push({ address: m[2]!.trim().toLowerCase(), name: name || null });
    } else {
      out.push({ address: p.toLowerCase(), name: null });
    }
  }
  return out;
}
