import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The same rules the commit-msg hook runs. One copy, so a hook and a test
// cannot drift apart and both go on looking like cover.
import { leaksIn } from "../../../tools/no-real-people.mjs";

/**
 * No real person's contact details in the repository (operator, 2026-09-17:
 * make sure my personal information is not in the source code).
 *
 * This repository was audited and scrubbed before it was first made public,
 * passed, and then acquired a real phone number, a real contact's name and a
 * stranger's work address within the day — because the app is built against
 * the operator's own mailbox, and the convenient fixture is always the one
 * already on screen. An audit is a gate you pass once; the leak happens
 * afterwards, every day, which is why this is a test instead.
 *
 * It cannot catch a name: "Dana Reyes" and "Thomas Corcoran" are the same
 * shape, and no rule tells them apart. It catches the things that do have a
 * shape — addresses and phone numbers — which is where the contactable harm
 * is anyway.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

describe("leaksIn", () => {
  it("passes an address at a reserved domain", () => {
    expect(leaksIn("write to dana@example.com")).toEqual([]);
    expect(leaksIn("billing@acme.test and me@work.example.com")).toEqual([]);
  });

  it("catches a stranger's address at a real company", () => {
    // The one this repository actually had.
    expect(leaksIn('draftTo: "victoria@tryalma.ai"')).toEqual([{ kind: "address", value: "victoria@tryalma.ai" }]);
  });

  it("catches a new address at a provider domain, which a domain allowlist would wave through", () => {
    expect(leaksIn("hunterzhang121@outlook.com")).toHaveLength(1);
    // While the handful the suite already needs stay allowed.
    expect(leaksIn("h@outlook.com")).toEqual([]);
  });

  it("catches a real WhatsApp identifier", () => {
    // Also one this repository actually had.
    expect(leaksIn('fromAddress: "15714578258@s.whatsapp.net"')).toEqual([
      { kind: "number", value: "15714578258@s.whatsapp.net" },
    ]);
    expect(leaksIn('"1394708@lid"')).toHaveLength(1);
  });

  it("passes a chat identifier in the reserved range", () => {
    expect(leaksIn('"14155550142@s.whatsapp.net"')).toEqual([]);
    expect(leaksIn('"14155550188@lid"')).toEqual([]);
  });

  it("catches a written-out phone number, and passes a reserved one", () => {
    expect(leaksIn("call +1 503-820-9184")).toHaveLength(1);
    expect(leaksIn("call +1 415-555-0142")).toEqual([]);
  });

  it("does not mistake a timestamp or a version for a phone number", () => {
    expect(leaksIn("sentAt: 1789687139958, id: 4155550142")).toEqual([]);
    expect(leaksIn("@types/node@22.20.1 and @messaging-agent/core")).toEqual([]);
  });
});

/** Files whose contents are not text worth scanning. */
const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|woff2?|ttf|sqlite|mp4|mov)$/i;

describe("the repository itself", () => {
  it("has nobody's real address or number in any tracked file", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8")
      .split("\0")
      .filter((f) => f && !BINARY.test(f) && f !== "pnpm-lock.yaml" && !f.endsWith("/no-real-people.test.ts"));

    const found: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(path.join(REPO, file), "utf8");
      } catch {
        continue;
      }
      for (const leak of leaksIn(text)) {
        const line = text.slice(0, text.indexOf(leak.value)).split("\n").length;
        found.push(`${file}:${line}  ${leak.kind}  ${leak.value}`);
      }
    }

    // The message is the point: a failure has to say what to replace and where.
    expect(found, `Real contact details in tracked files. Use a reserved domain (example.com, .test) or the +1 415 555 01xx range:\n${found.join("\n")}`).toEqual([]);
  });
});
