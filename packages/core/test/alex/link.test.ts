import { describe, it, expect, beforeEach } from "vitest";
import { celesteLink, forgetPublicBase, publicBase, LINK_LABEL } from "../../src/alex/link";
import { argumentsFor } from "../../src/alex/client";
import { landingFor } from "../../src/alex/landing";
import { testDb } from "../helpers/db";
import { accounts, drafts, messages, threads } from "../../src/db/schema";

/**
 * The way back from Alex (operator, 2026-09-23: "whenever we add an action to
 * Alex, there should be a backlink ... that link will take me back to
 * Celeste's email, selected already").
 */

const T0 = 1_780_000_000_000;

describe("celesteLink", () => {
  it("is one address per thread, and survives a colon in the id", () => {
    expect(celesteLink("https://mac.tailnet.ts.net", "a1:t1")).toBe("https://mac.tailnet.ts.net/go/thread/a1%3At1");
  });

  it("does not double the slash when the base carries one", () => {
    expect(celesteLink("https://mac.tailnet.ts.net/", "a1:t1")).toBe("https://mac.tailnet.ts.net/go/thread/a1%3At1");
  });
});

describe("publicBase", () => {
  beforeEach(() => forgetPublicBase());

  it("takes the address the operator pinned, before asking anything", async () => {
    const asked: string[] = [];
    const base = await publicBase({ publicUrl: "https://celeste.example.com/" }, () => T0, async (cmd) => {
      asked.push(cmd);
      return { stdout: "" };
    });
    expect(base).toBe("https://celeste.example.com");
    expect(asked).toEqual([]);
  });

  it("asks Tailscale for the name the phone reaches this Mac by", async () => {
    const base = await publicBase({ publicUrl: undefined }, () => T0, async () => ({
      stdout: JSON.stringify({ Self: { DNSName: "mac.tailnet.ts.net." } }),
    }));
    expect(base).toBe("https://mac.tailnet.ts.net");
  });

  it("holds the answer rather than asking on every item", async () => {
    let asked = 0;
    const exec = async () => {
      asked++;
      return { stdout: JSON.stringify({ Self: { DNSName: "mac.tailnet.ts.net." } }) };
    };
    await publicBase({ publicUrl: undefined }, () => T0, exec);
    await publicBase({ publicUrl: undefined }, () => T0 + 60_000, exec);
    expect(asked).toBe(1);
    // Ten minutes on, it asks again: a tailnet name can change.
    await publicBase({ publicUrl: undefined }, () => T0 + 11 * 60_000, exec);
    expect(asked).toBe(2);
  });

  it("falls back to the local address when there is no Tailscale", async () => {
    const base = await publicBase({ publicUrl: undefined }, () => T0, async () => {
      throw new Error("tailscale: command not found");
    });
    expect(base).toBe("http://127.0.0.1:3100");
  });
});

describe("argumentsFor, with a link", () => {
  const link = "https://mac.tailnet.ts.net/go/thread/a1%3At1";

  it("puts it in an event's description, after anything already there", () => {
    const args = argumentsFor({ kind: "event", title: "Call", startISO: "s", endISO: "e", description: "Agreed on Tuesday.", link });
    expect(args.description).toBe(`Agreed on Tuesday.\n\n${LINK_LABEL}: ${link}`);
  });

  it("is the whole description when the event had none", () => {
    const args = argumentsFor({ kind: "event", title: "Call", startISO: "s", endISO: "e", link });
    expect(args.description).toBe(`${LINK_LABEL}: ${link}`);
  });

  /** An actionable has no description, only its list (Alex's own schema). */
  it("is a line of an actionable's list, after the operator's own", () => {
    const args = argumentsFor({ kind: "actionable", title: "Reply", dayISO: "d", items: ["Gather the letters"], link });
    expect(args.items).toEqual(["Gather the letters", `${LINK_LABEL}: ${link}`]);
  });

  it("is the only line when the actionable had no list", () => {
    const args = argumentsFor({ kind: "actionable", title: "Reply", dayISO: "d", link });
    expect(args.items).toEqual([`${LINK_LABEL}: ${link}`]);
  });

  it("leaves an item with no link exactly as it was", () => {
    expect(argumentsFor({ kind: "actionable", title: "Reply", dayISO: "d" })).toEqual({ title: "Reply", dayISO: "d" });
    expect(argumentsFor({ kind: "event", title: "Call", startISO: "s", endISO: "e" })).toEqual({ title: "Call", startISO: "s", endISO: "e" });
  });
});

describe("landingFor", () => {
  function seed(db: ReturnType<typeof testDb>, opts: { draft?: "pending" | "sent" } = {}) {
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: T0 }).run();
    db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Invoice", lastMessageAt: T0, lastFromOperator: false }).run();
    db.insert(messages)
      .values({
        id: "a1:m1", accountId: "a1", threadId: "a1:t1", providerMessageId: "m1", rfcMessageId: null, fromAddress: "ana@example.com",
        fromName: null, toAddresses: ["me@example.com"], ccAddresses: [], subject: "Invoice", snippet: null, attachmentNames: [],
        bodyText: "due Friday", isFromOperator: false, sentAt: T0, receivedAt: T0,
      })
      .run();
    if (opts.draft) {
      db.insert(drafts)
        .values({
          id: "d1", threadId: "a1:t1", replyToMessageId: "a1:m1", accountId: "a1", subject: null, originalText: "Friday works.",
          finalText: null, toAddresses: ["ana@example.com"], ccAddresses: [], status: opts.draft, mode: "reply", model: "x",
          sentProviderMessageId: null, error: null, createdAt: T0, updatedAt: T0,
        })
        .run();
    }
  }

  it("opens the draft while one is waiting, on its own account", () => {
    const db = testDb();
    seed(db, { draft: "pending" });
    expect(landingFor(db, "a1:t1")).toBe("/drafts?draft=d1&account=a1");
  });

  it("opens the conversation once the draft has gone", () => {
    const db = testDb();
    seed(db, { draft: "sent" });
    expect(landingFor(db, "a1:t1")).toBe("/inbox/a1%3At1");
  });

  it("opens the conversation when there never was a draft", () => {
    const db = testDb();
    seed(db);
    expect(landingFor(db, "a1:t1")).toBe("/inbox/a1%3At1");
  });

  it("sends a thread that no longer exists to the inbox, not to an error", () => {
    const db = testDb();
    seed(db);
    expect(landingFor(db, "a1:gone")).toBe("/inbox");
  });
});
