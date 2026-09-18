/**
 * Contact details that belong to a real person, wherever they turn up.
 *
 * Plain JavaScript with no imports, because a git hook has to run it directly
 * with `node` before anything is built, and the test suite imports the same
 * file. One copy of the rules: a hook and a test that drifted apart would be
 * worse than either alone, since both would look like cover.
 *
 * Written after this repository was scrubbed, passed, and then took on a real
 * phone number, a real contact's name and a stranger's work address inside a
 * day. The app is built against its author's own mailbox, so the handiest
 * fixture is always a real one.
 */

/** Domains reserved by RFC 2606 and RFC 6761 for exactly this purpose. */
function reservedDomain(domain) {
  return (
    domain === "example.com" ||
    domain === "example.net" ||
    domain === "example.org" ||
    domain.endsWith(".example.com") ||
    domain.endsWith(".example.net") ||
    domain.endsWith(".example.org") ||
    domain.endsWith(".test") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".example")
  );
}

/**
 * Fixture domains already in the suite when this check was written. They are
 * plainly invented, so they are left alone rather than churned through every
 * test file; anything new is expected to use a reserved domain above.
 */
export const FIXTURE_DOMAINS = new Set([
  "acme.com", "b.co", "bill.com", "client.com", "elsewhere.com", "firm.com",
  "gone.com", "lawfirm.com", "northwind.co", "other.com", "school.edu",
  "shop.com", "vendor.com", "work.com", "x.com", "x.io", "x.org", "y.com",
  // Google's RCS business-messaging domain. An agent, never a person.
  "rbm.goog",
]);

/**
 * Addresses at real mail providers. Provider domains cannot be waved through
 * wholesale, because the author's own address is at one of them, so these are
 * listed one at a time and a tenth at gmail.com is a finding.
 */
export const KNOWN_FIXTURES = new Set([
  "aunt@icloud.com", "ben@icloud.com", "grace@icloud.com", "h@googlemail.com",
  "h@hotmail.com", "h@live.com", "h@msn.com", "h@outlook.com", "hunter@gmail.com",
  "me@gmail.com", "you@gmail.com",
  // A real Microsoft relay the alias code has to recognise by name.
  "office365@messaging.microsoft.com",
  // The trailer on every commit here.
  "noreply@anthropic.com",
]);

/**
 * A number nobody can be reached on. The North American plan reserves the 555
 * exchange in every area code for fiction, so 202 555 0100 is as safe as
 * 415 555 0142, and the WhatsApp fixtures use a `2025000000…` prefix for the
 * opaque `@lid` identifiers, which have no phone-number shape to test.
 */
function reservedNumber(digits) {
  return /^1?\d{3}555\d{4}$/.test(digits) || /^555\d{4}$/.test(digits) || /^2025000000\d+$/.test(digits);
}

/**
 * Contact details in some text that are not plainly invented.
 *
 * Chat identifiers are checked as numbers rather than addresses: a WhatsApp id
 * is somebody's phone number with a domain stuck on the end, and reading it as
 * an address would wave it through on the domain alone.
 */
export function leaksIn(text) {
  const found = [];

  for (const m of text.matchAll(/\b(\d{7,15})@(s\.whatsapp\.net|lid)\b/g)) {
    if (!reservedNumber(m[1])) found.push({ kind: "number", value: m[0] });
  }

  for (const m of text.matchAll(/\+1[\s-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g)) {
    if (!m[0].includes("555")) found.push({ kind: "number", value: m[0] });
  }

  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const address = m[0].toLowerCase();
    const domain = address.slice(address.lastIndexOf("@") + 1);
    // Chat identifiers are the rule above's business, not this one's.
    if (domain === "s.whatsapp.net" || domain === "lid" || domain === "g.us") continue;
    if (reservedDomain(domain) || FIXTURE_DOMAINS.has(domain) || KNOWN_FIXTURES.has(address)) continue;
    found.push({ kind: "address", value: m[0] });
  }

  return found;
}

/** What to tell somebody who has just been stopped, with what to do instead. */
export function explain(leaks, where) {
  const lines = leaks.map((l) => `  ${l.kind === "address" ? "address" : "number "}  ${l.value}`);
  return [
    `Real contact details in ${where}:`,
    ...lines,
    "",
    "Use a reserved domain (example.com, .test) or the 555 exchange",
    "(+1 415 555 0142). If this one is genuinely invented, add it to",
    "FIXTURE_DOMAINS or KNOWN_FIXTURES in tools/no-real-people.mjs.",
  ].join("\n");
}

// Run directly by the commit-msg hook: node tools/no-real-people.mjs <file>
if (process.argv[1] && process.argv[1].endsWith("no-real-people.mjs")) {
  const file = process.argv[2];
  if (file) {
    const { readFileSync } = await import("node:fs");
    // A commit message is only its own lines; the diff git appends under a
    // scissors line, and the commented help, are not being committed.
    const raw = readFileSync(file, "utf8");
    const message = raw.split(/^# -+ >8 -+$/m)[0].split("\n").filter((l) => !l.startsWith("#")).join("\n");
    const leaks = leaksIn(message);
    if (leaks.length > 0) {
      console.error(explain(leaks, "this commit message"));
      process.exit(1);
    }
  }
}
