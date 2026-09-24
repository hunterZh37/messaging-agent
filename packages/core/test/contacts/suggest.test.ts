import { describe, it, expect } from "vitest";
import { testDb } from "../helpers/db";
import { accounts, contacts, messages, threads } from "../../src/db/schema";
import { forgetRecipients, suggestRecipients } from "../../src/contacts/suggest";

/**
 * Autofill for a recipient (operator, 2026-09-23: "if I type in the first
 * half of a contact name or email address, it should give me autofill
 * capabilities based on all the contacts that we have emails or messages from
 * and to"). Everyone the mail knows, whichever inbox they wrote to, with the
 * inbox being written from first.
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_780_000_000_000;

function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: T0 }).run();
  db.insert(accounts).values({ id: "a2", provider: "outlook", email: "other@example.com", displayName: null, createdAt: T0 }).run();
  db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "One", lastMessageAt: T0, lastFromOperator: false }).run();
  db.insert(threads).values({ id: "a2:t2", accountId: "a2", providerThreadId: "t2", subject: "Two", lastMessageAt: T0, lastFromOperator: false }).run();

  const base = { fromName: null, ccAddresses: [] as string[], snippet: null, attachmentNames: [] as string[], receivedAt: T0, bodyText: "words", isFromOperator: false, rfcMessageId: null };
  // Someone who wrote to the first inbox, recently and often.
  for (let i = 0; i < 3; i++) {
    db.insert(messages)
      .values({ ...base, id: `a1:m${i}`, accountId: "a1", threadId: "a1:t1", providerMessageId: `m${i}`, fromAddress: "kate@example.com", fromName: "Kate Bright", toAddresses: ["me@example.com"], ccAddresses: [], subject: "Hello", sentAt: T0 - i * DAY })
      .run();
  }
  // Someone on the other inbox only.
  db.insert(messages)
    .values({ ...base, id: "a2:m1", accountId: "a2", threadId: "a2:t2", providerMessageId: "m1", fromAddress: "kevin@example.org", fromName: "Kevin Stone", toAddresses: ["other@example.com"], ccAddresses: [], subject: "Hi", sentAt: T0 - 40 * DAY })
    .run();
  // Someone the operator wrote TO, never heard from: only in to/cc.
  db.insert(messages)
    .values({ ...base, id: "a1:m9", accountId: "a1", threadId: "a1:t1", providerMessageId: "m9", fromAddress: "me@example.com", fromName: "Me", toAddresses: ["karl@example.net"], ccAddresses: ["copy@example.net"], subject: "Out", sentAt: T0 - 5 * DAY })
    .run();
  // The address book, which knows one person by mail and one by phone.
  db.insert(contacts).values({ handle: "kim@example.com", name: "Kim Booker", refreshedAt: T0 }).run();
  db.insert(contacts).values({ handle: "+15555550123", name: "Phone Only", refreshedAt: T0 }).run();
  forgetRecipients(db);
}

const at = () => T0;
const addresses = (db: ReturnType<typeof testDb>, query: string, accountId?: string) =>
  suggestRecipients(db, { query, ...(accountId ? { accountId } : {}), clock: at }).map((s) => s.address);

describe("suggestRecipients", () => {
  it("completes half an address", () => {
    const db = testDb();
    seed(db);
    expect(addresses(db, "kate@")).toEqual(["kate@example.com"]);
  });

  it("completes half a name, and carries the name back", () => {
    const db = testDb();
    seed(db);
    const [first] = suggestRecipients(db, { query: "brig", clock: at });
    expect(first).toMatchObject({ address: "kate@example.com", name: "Kate Bright" });
  });

  it("matches a first name as readily as a surname", () => {
    const db = testDb();
    seed(db);
    expect(addresses(db, "kev")).toEqual(["kevin@example.org"]);
    expect(addresses(db, "stone")).toEqual(["kevin@example.org"]);
  });

  it("finds someone the operator only ever wrote to, and anyone in copy", () => {
    const db = testDb();
    seed(db);
    expect(addresses(db, "karl")).toEqual(["karl@example.net"]);
    expect(addresses(db, "copy@")).toEqual(["copy@example.net"]);
  });

  it("knows every inbox, and puts the one being written from first", () => {
    const db = testDb();
    seed(db);
    // Both match "k"; on the second account, its own correspondent leads.
    expect(addresses(db, "k", "a2")[0]).toBe("kevin@example.org");
    expect(addresses(db, "k", "a1")[0]).toBe("kate@example.com");
  });

  it("prefers what starts with the letters over what merely contains them", () => {
    const db = testDb();
    seed(db);
    const out = addresses(db, "example.com");
    expect(out).toContain("kate@example.com");
    // "me@example.com" starts with neither, so Kate, whose address does not
    // start with it either, is ordered by how well known she is instead.
    expect(out.length).toBeGreaterThan(1);
  });

  it("offers the address book only where it holds an email", () => {
    const db = testDb();
    seed(db);
    expect(addresses(db, "kim")).toEqual(["kim@example.com"]);
    expect(addresses(db, "phone")).toEqual([]);
    expect(addresses(db, "5555550123")).toEqual([]);
  });

  it("offers the most recent people when nothing has been typed", () => {
    const db = testDb();
    seed(db);
    const out = suggestRecipients(db, { query: "", accountId: "a1", limit: 3, clock: at });
    expect(out.length).toBe(3);
    expect(out[0]?.address).toBe("kate@example.com");
  });

  it("says who is known on this account, and how well", () => {
    const db = testDb();
    seed(db);
    const [kate] = suggestRecipients(db, { query: "kate", accountId: "a1", clock: at });
    expect(kate).toMatchObject({ onThisAccount: true, count: 3 });
    const [kevin] = suggestRecipients(db, { query: "kevin", accountId: "a1", clock: at });
    expect(kevin).toMatchObject({ onThisAccount: false });
  });

  it("holds no more than it was asked for, and nothing for a stranger", () => {
    const db = testDb();
    seed(db);
    expect(suggestRecipients(db, { query: "", limit: 2, clock: at })).toHaveLength(2);
    expect(addresses(db, "nobody-here")).toEqual([]);
  });

  it("keeps a name from an older mail when the newest carries none", () => {
    const db = testDb();
    seed(db);
    const base = { fromName: null, ccAddresses: [] as string[], snippet: null, attachmentNames: [] as string[], receivedAt: T0, bodyText: "words", isFromOperator: false, rfcMessageId: null };
    db.insert(messages)
      .values({ ...base, id: "a1:m20", accountId: "a1", threadId: "a1:t1", providerMessageId: "m20", fromAddress: "kate@example.com", fromName: null, toAddresses: ["me@example.com"], subject: "Later", sentAt: T0 + DAY })
      .run();
    forgetRecipients(db);
    expect(suggestRecipients(db, { query: "kate", clock: at })[0]?.name).toBe("Kate Bright");
  });

  /**
   * WhatsApp identities carry an @ without being addresses: found in the
   * browser on 2026-09-23, where a contact's WhatsApp id was offered under
   * their own name as somewhere to send an email.
   */
  it("leaves out a chat handle that merely contains an at sign", () => {
    const db = testDb();
    seed(db);
    const base = { fromName: "Chat Person", ccAddresses: [] as string[], snippet: null, attachmentNames: [] as string[], receivedAt: T0, bodyText: "hi", isFromOperator: false, rfcMessageId: null };
    const handles = ["someone@lid", "14155550100@s.whatsapp.net", "a-group@g.us"];
    handles.forEach((handle, i) => {
      db.insert(messages)
        .values({ ...base, id: `a1:c${i}`, accountId: "a1", threadId: "a1:t1", providerMessageId: `c${i}`, fromAddress: handle, toAddresses: ["me@example.com"], subject: "Chat", sentAt: T0 - i })
        .run();
    });
    forgetRecipients(db);
    expect(addresses(db, "chat person")).toEqual([]);
    expect(addresses(db, "@lid")).toEqual([]);
    expect(addresses(db, "someone")).toEqual([]);
  });

  it("puts an address that begins with the letters above a name that merely holds them", () => {
    const db = testDb();
    seed(db);
    const base = { ccAddresses: [] as string[], snippet: null, attachmentNames: [] as string[], receivedAt: T0, bodyText: "hi", isFromOperator: false, rfcMessageId: null };
    // A notification sender whose display name carries the word, and a person
    // whose address begins with it.
    db.insert(messages)
      .values({ ...base, id: "a1:n1", accountId: "a1", threadId: "a1:t1", providerMessageId: "n1", fromAddress: "no-reply@notify.example.com", fromName: "Kate Bright via Notify", toAddresses: ["me@example.com"], subject: "Alert", sentAt: T0 })
      .run();
    forgetRecipients(db);
    expect(addresses(db, "kate")[0]).toBe("kate@example.com");
    // Kept, but last: the operator may still want it.
    expect(addresses(db, "kate")).toContain("no-reply@notify.example.com");
    expect(addresses(db, "kate").at(-1)).toBe("no-reply@notify.example.com");
  });

  it("never offers the operator their own address", () => {
    const db = testDb();
    seed(db);
    expect(addresses(db, "me@")).toEqual([]);
    expect(addresses(db, "other@")).toEqual([]);
    expect(addresses(db, "", "a1")).not.toContain("me@example.com");
  });

  /**
   * A name is what the address book usually adds, not what makes an address
   * worth offering (review, 2026-09-23): an entry with no name was dropped.
   */
  it("offers an address-book entry that has no name", () => {
    const db = testDb();
    seed(db);
    db.insert(contacts).values({ handle: "noname@example.com", name: "", refreshedAt: T0 }).run();
    forgetRecipients(db);
    expect(addresses(db, "noname")).toEqual(["noname@example.com"]);
  });

  it("orders two people who score the same the same way every time", () => {
    const db = testDb();
    seed(db);
    db.insert(contacts).values({ handle: "zoe@example.com", name: "Zoe", refreshedAt: T0 }).run();
    db.insert(contacts).values({ handle: "abe@example.com", name: "Abe", refreshedAt: T0 }).run();
    forgetRecipients(db);
    const once = addresses(db, "example.com");
    const twice = addresses(db, "example.com");
    expect(once).toEqual(twice);
    expect(once.indexOf("abe@example.com")).toBeLessThan(once.indexOf("zoe@example.com"));
  });

  it("takes a percent sign as a letter, not as a wildcard", () => {
    const db = testDb();
    seed(db);
    expect(addresses(db, "%")).toEqual([]);
  });
});
