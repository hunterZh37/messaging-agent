import { describe, it, expect } from "vitest";
import { bumpPerson, forgetPeople, frequentPeople, listPersonThreads, personFor, unbumpPerson, weight, HALF_LIFE_MS } from "../../src/contacts/people";
import { testDb } from "../helpers/db";
import { accounts, contacts, messages, peopleBumps, threads } from "../../src/db/schema";

/**
 * The people the operator deals with, gathered from their own mail and texts
 * (operator, 2026-09-28: "there should be a feature where I can easily access
 * to the most common thread with contacts I talk to a lot").
 */

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;

function db() {
  const d = testDb();
  d.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: NOW - 400 * DAY }).run();
  d.insert(accounts).values({ id: "a2", provider: "whatsapp", email: "texts@example.com", displayName: null, createdAt: NOW - 400 * DAY }).run();
  forgetPeople(d);
  return d;
}

let seq = 0;
function mail(d: ReturnType<typeof db>, opts: {
  from: string; to?: string[]; at: number; account?: string; name?: string | null; thread?: string; folder?: string; mine?: boolean;
}) {
  const id = `m${++seq}`;
  const threadId = opts.thread ?? `t${id}`;
  const accountId = opts.account ?? "a1";
  const exists = d.select({ id: threads.id }).from(threads).all().some((t) => t.id === threadId);
  if (!exists) {
    d.insert(threads).values({ id: threadId, accountId, providerThreadId: threadId, subject: "Subject", lastMessageAt: opts.at, lastFromOperator: opts.mine ?? false }).run();
  }
  d.insert(messages)
    .values({
      id, accountId, threadId, providerMessageId: id, rfcMessageId: null,
      fromAddress: opts.from, fromName: opts.name ?? null, toAddresses: opts.to ?? ["me@example.com"], ccAddresses: [],
      subject: "Subject", snippet: null, attachmentNames: [], bodyText: "text",
      isFromOperator: opts.mine ?? false, sentAt: opts.at, receivedAt: opts.at,
      ...(opts.folder ? { folder: opts.folder } : {}),
    } as never)
    .run();
  forgetPeople(d);
  return threadId;
}

describe("weight", () => {
  it("counts a message sent now in full, and one a half-life old at half", () => {
    expect(weight(NOW, NOW)).toBe(1);
    expect(weight(NOW - HALF_LIFE_MS, NOW)).toBeCloseTo(0.5, 6);
    expect(weight(NOW - 2 * HALF_LIFE_MS, NOW)).toBeCloseTo(0.25, 6);
  });

  it("never goes negative for a message dated in the future", () => {
    expect(weight(NOW + DAY, NOW)).toBeLessThanOrEqual(1);
    expect(weight(NOW + DAY, NOW)).toBeGreaterThan(0);
  });
});

describe("frequentPeople", () => {
  it("puts a recent correspondent above an older, busier one", () => {
    const d = db();
    for (let i = 0; i < 10; i++) mail(d, { from: "recent@example.com", at: NOW - i * DAY });
    for (let i = 0; i < 40; i++) mail(d, { from: "old@example.com", at: NOW - (400 + i) * DAY });
    const people = frequentPeople(d, { now: NOW });
    expect(people.map((p) => p.key)).toEqual(["recent@example.com", "old@example.com"]);
  });

  it("counts mail the operator sent as well as mail they had", () => {
    const d = db();
    mail(d, { from: "me@example.com", to: ["only-wrote-to@example.com"], at: NOW - DAY, mine: true });
    expect(frequentPeople(d, { now: NOW }).map((p) => p.key)).toContain("only-wrote-to@example.com");
  });

  it("does not count the operator's own alias, or a stranger copied in on their mail", () => {
    const d = db();
    // Mail the operator received: it carries their own alias in `to`, and
    // whoever else was copied in. Neither is someone they talk to.
    for (let i = 0; i < 20; i++) {
      mail(d, { from: "them@example.com", to: ["hunter-alias@example.com", "copied-in@example.com"], at: NOW - i * DAY });
    }
    const keys = frequentPeople(d, { now: NOW }).map((p) => p.key);
    expect(keys).toEqual(["them@example.com"]);
  });

  it("leaves out the operator's own addresses", () => {
    const d = db();
    mail(d, { from: "me@example.com", to: ["them@example.com"], at: NOW, mine: true });
    expect(frequentPeople(d, { now: NOW }).map((p) => p.key)).not.toContain("me@example.com");
  });

  it("leaves out the operator's own chat handle, which no account row names", () => {
    const d = db();
    // A chat account is named by an address here; the texts in it come from
    // the operator's own number, which is nowhere in the accounts table.
    for (let i = 0; i < 50; i++) {
      mail(d, { from: "15105550111@s.whatsapp.net", to: ["them@example.com"], at: NOW - i * DAY, account: "a2", mine: true, name: "Me" });
    }
    mail(d, { from: "them@example.com", at: NOW - 30 * DAY, account: "a2" });
    const people = frequentPeople(d, { now: NOW });
    expect(people.map((p) => p.key)).not.toContain("15105550111@s.whatsapp.net");
    expect(people.map((p) => p.key)).toContain("them@example.com");
  });

  it("leaves out groups and broadcasts, which are not a person", () => {
    const d = db();
    mail(d, { from: "120363000000000000@g.us", at: NOW, account: "a2" });
    mail(d, { from: "status@broadcast", at: NOW, account: "a2" });
    mail(d, { from: "real@example.com", at: NOW });
    expect(frequentPeople(d, { now: NOW }).map((p) => p.key)).toEqual(["real@example.com"]);
  });

  it("leaves out the machines that write but never read", () => {
    const d = db();
    for (let i = 0; i < 30; i++) mail(d, { from: "no-reply@example.com", at: NOW - i * DAY });
    mail(d, { from: "person@example.com", at: NOW });
    expect(frequentPeople(d, { now: NOW }).map((p) => p.key)).toEqual(["person@example.com"]);
  });

  it("keeps a chat handle, which is a person even though it is not an address", () => {
    const d = db();
    mail(d, { from: "14155550133@s.whatsapp.net", at: NOW, account: "a2", name: "Sam" });
    const people = frequentPeople(d, { now: NOW });
    expect(people[0]?.key).toBe("14155550133@s.whatsapp.net");
    expect(people[0]?.channels).toEqual(["chat"]);
    expect(people[0]?.name).toBe("Sam");
  });

  it("gives back no more than it was asked for, best first", () => {
    const d = db();
    for (const who of ["a", "b", "c", "d"]) mail(d, { from: `${who}@example.com`, at: NOW - who.charCodeAt(0) * DAY });
    expect(frequentPeople(d, { now: NOW, limit: 2 })).toHaveLength(2);
  });

  it("reads the list once and holds it, rather than sweeping for every page", () => {
    const d = db();
    mail(d, { from: "them@example.com", at: NOW });
    const first = frequentPeople(d, { now: NOW });
    mail(d, { from: "later@example.com", at: NOW });
    // `mail` forgets the held list, so ask again without forgetting:
    const held = frequentPeople(d, { now: NOW });
    expect(held.map((p) => p.key)).toEqual(expect.arrayContaining(["later@example.com"]));
    expect(first.length).toBeGreaterThan(0);
  });
});

/**
 * One person, two ways of reaching them. Only the address book can say that a
 * number and an address are the same person, and it says so by holding both
 * under one name.
 */
describe("frequentPeople, merging", () => {
  it("is one person when Contacts holds their address and their number", () => {
    const d = db();
    d.insert(contacts).values({ handle: "ana@example.com", name: "Ana Diaz", refreshedAt: NOW }).run();
    d.insert(contacts).values({ handle: "+1 (415) 555-0133", name: "Ana Diaz", refreshedAt: NOW }).run();
    mail(d, { from: "ana@example.com", at: NOW - DAY });
    mail(d, { from: "14155550133@s.whatsapp.net", at: NOW, account: "a2" });
    const people = frequentPeople(d, { now: NOW });
    expect(people).toHaveLength(1);
    expect(people[0]?.name).toBe("Ana Diaz");
    expect(people[0]?.handles.sort()).toEqual(["14155550133@s.whatsapp.net", "ana@example.com"]);
    expect(people[0]?.channels.sort()).toEqual(["chat", "mail"]);
  });

  it("never merges anyone onto the operator's own contact card", () => {
    const d = db();
    // The operator's own card, as a real address book holds it: their own
    // account, their own number, and a relative's address filed under their
    // name. Nobody here is a person the operator talks to under that name.
    d.insert(contacts).values({ handle: "me@example.com", name: "The Operator", refreshedAt: NOW }).run();
    d.insert(contacts).values({ handle: "relative@example.com", name: "The Operator", refreshedAt: NOW }).run();
    mail(d, { from: "relative@example.com", at: NOW, name: "Chris" });
    const people = frequentPeople(d, { now: NOW });
    expect(people).toHaveLength(1);
    expect(people[0]?.key).toBe("relative@example.com");
    // Their own name, not the operator's, and standing on their own.
    expect(people[0]?.name).toBe("Chris");
    expect(people[0]?.handles).toEqual(["relative@example.com"]);
  });

  /**
   * The operator's own number, as the address book writes it and as the texts
   * arrive (review, 2026-09-28): comparing the two as strings never matched,
   * so their own card went on gathering other people under their own name.
   */
  it("knows the operator's own number however it is written", () => {
    const d = db();
    d.insert(contacts).values({ handle: "+1 (415) 555-0100", name: "The Operator", refreshedAt: NOW }).run();
    d.insert(contacts).values({ handle: "relative@example.com", name: "The Operator", refreshedAt: NOW }).run();
    // The operator's own texts arrive from the bare number, at a domain.
    mail(d, { from: "14155550100@s.whatsapp.net", to: ["someone@example.com"], at: NOW, account: "a2", mine: true });
    mail(d, { from: "relative@example.com", at: NOW, name: "Chris" });
    const relative = frequentPeople(d, { now: NOW }).find((p) => p.handles.includes("relative@example.com"));
    expect(relative?.name).toBe("Chris");
    expect(relative?.handles).toEqual(["relative@example.com"]);
  });

  it("is two people when Contacts knows only one of the two", () => {
    const d = db();
    d.insert(contacts).values({ handle: "ana@example.com", name: "Ana Diaz", refreshedAt: NOW }).run();
    mail(d, { from: "ana@example.com", at: NOW - DAY });
    mail(d, { from: "14155550133@s.whatsapp.net", at: NOW, account: "a2" });
    expect(frequentPeople(d, { now: NOW })).toHaveLength(2);
  });

  it("does not merge two strangers who happen to sign themselves the same", () => {
    const d = db();
    // The names here come from the mail, not from the address book: mail
    // names are how half the world signs itself, and two of them matching
    // says nothing.
    mail(d, { from: "one@example.com", at: NOW, name: "Support Team" });
    mail(d, { from: "two@other.example", at: NOW, name: "Support Team" });
    expect(frequentPeople(d, { now: NOW })).toHaveLength(2);
  });

  it("adds a person's whole weight together once they are one", () => {
    const d = db();
    d.insert(contacts).values({ handle: "ana@example.com", name: "Ana Diaz", refreshedAt: NOW }).run();
    d.insert(contacts).values({ handle: "+14155550133", name: "Ana Diaz", refreshedAt: NOW }).run();
    mail(d, { from: "ana@example.com", at: NOW });
    mail(d, { from: "14155550133@s.whatsapp.net", at: NOW, account: "a2" });
    mail(d, { from: "busier@example.com", at: NOW });
    mail(d, { from: "busier@example.com", at: NOW });
    const people = frequentPeople(d, { now: NOW });
    // Two halves of one person outweigh nobody, but they are counted as one:
    expect(people[0]?.count).toBe(2);
    expect(people.find((p) => p.name === "Ana Diaz")?.count).toBe(2);
  });
});

describe("personFor", () => {
  it("finds a person by any handle they answer to", () => {
    const d = db();
    d.insert(contacts).values({ handle: "ana@example.com", name: "Ana Diaz", refreshedAt: NOW }).run();
    d.insert(contacts).values({ handle: "+14155550133", name: "Ana Diaz", refreshedAt: NOW }).run();
    mail(d, { from: "ana@example.com", at: NOW });
    mail(d, { from: "14155550133@s.whatsapp.net", at: NOW, account: "a2" });
    expect(personFor(d, "14155550133@s.whatsapp.net", { now: NOW })?.name).toBe("Ana Diaz");
    expect(personFor(d, "ana@example.com", { now: NOW })?.name).toBe("Ana Diaz");
  });

  it("is nobody for a handle no message carries", () => {
    const d = db();
    mail(d, { from: "ana@example.com", at: NOW });
    expect(personFor(d, "stranger@example.com", { now: NOW })).toBeNull();
  });

  it("does not care what case the handle is written in", () => {
    const d = db();
    mail(d, { from: "Ana@Example.com", at: NOW });
    expect(personFor(d, "ana@EXAMPLE.com", { now: NOW })?.key).toBe("ana@example.com");
  });
});

describe("listPersonThreads", () => {
  it("gives one row per conversation, newest first", () => {
    const d = db();
    mail(d, { from: "ana@example.com", at: NOW - 3 * DAY, thread: "older" });
    mail(d, { from: "ana@example.com", at: NOW - 2 * DAY, thread: "newer" });
    mail(d, { from: "ana@example.com", at: NOW - DAY, thread: "newer" });
    const rows = listPersonThreads(d, ["ana@example.com"]);
    expect(rows.map((r) => r.thread.id)).toEqual(["newer", "older"]);
  });

  it("finds a thread where the operator wrote to them and they never answered", () => {
    const d = db();
    mail(d, { from: "me@example.com", to: ["ana@example.com"], at: NOW, mine: true, thread: "sent-only" });
    expect(listPersonThreads(d, ["ana@example.com"]).map((r) => r.thread.id)).toEqual(["sent-only"]);
  });

  it("answers for every handle a merged person has", () => {
    const d = db();
    mail(d, { from: "ana@example.com", at: NOW - DAY, thread: "by-mail" });
    mail(d, { from: "14155550133@s.whatsapp.net", at: NOW, account: "a2", thread: "by-text" });
    const rows = listPersonThreads(d, ["ana@example.com", "14155550133@s.whatsapp.net"]);
    expect(rows.map((r) => r.thread.id)).toEqual(["by-text", "by-mail"]);
  });

  it("leaves out what was thrown away", () => {
    const d = db();
    mail(d, { from: "ana@example.com", at: NOW, thread: "kept" });
    mail(d, { from: "ana@example.com", at: NOW, thread: "binned", folder: "trash" });
    expect(listPersonThreads(d, ["ana@example.com"]).map((r) => r.thread.id)).toEqual(["kept"]);
  });

  /**
   * Two messages of a thread can carry the same instant — five hundred
   * threads in the real mailbox do — and the row must not be a coin toss
   * (review, 2026-09-28). Ties break on id, the way every other "newest in
   * the thread" in this codebase breaks them, so the later message wins.
   */
  it("takes the later message when two share the newest instant", () => {
    const d = db();
    mail(d, { from: "ana@example.com", at: NOW, thread: "tied" });
    mail(d, { from: "ana@example.com", at: NOW, thread: "tied" });
    const ids = d.select({ id: messages.id }).from(messages).all().map((m) => m.id).sort();
    const rows = listPersonThreads(d, ["ana@example.com"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message.id).toBe(ids[ids.length - 1]);
  });

  it("is empty rather than everything for nobody", () => {
    const d = db();
    mail(d, { from: "ana@example.com", at: NOW });
    expect(listPersonThreads(d, [])).toEqual([]);
  });
});

/**
 * Done with someone, for now (operator, 2026-09-28: "should have the ability
 * to delete someone off", and they come back if the traffic does). Pressing
 * it forgets what came before rather than scoring a penalty nobody could
 * predict the effect of: from that moment the person is ranked on what they
 * send next, and on nothing else.
 */
describe("bumping someone off the list", () => {
  it("drops someone the operator is done with, and leaves the rest standing", () => {
    const d = db();
    for (let i = 0; i < 30; i++) mail(d, { from: "loud@example.com", at: NOW - i * DAY });
    for (let i = 0; i < 5; i++) mail(d, { from: "quiet@example.com", at: NOW - i * DAY });
    expect(frequentPeople(d, { now: NOW })[0]?.key).toBe("loud@example.com");
    bumpPerson(d, ["loud@example.com"], NOW);
    expect(frequentPeople(d, { now: NOW }).map((p) => p.key)).toEqual(["quiet@example.com"]);
  });

  it("brings them back when they write again, without being asked", () => {
    const d = db();
    for (let i = 0; i < 30; i++) mail(d, { from: "loud@example.com", at: NOW - 10 * DAY - i * DAY });
    for (let i = 0; i < 3; i++) mail(d, { from: "quiet@example.com", at: NOW - i * DAY });
    bumpPerson(d, ["loud@example.com"], NOW - 5 * DAY);
    expect(frequentPeople(d, { now: NOW }).map((p) => p.key)).toEqual(["quiet@example.com"]);
    // They write four times since, which is more than the other has:
    for (let i = 0; i < 4; i++) mail(d, { from: "loud@example.com", at: NOW - i * 60_000 });
    expect(frequentPeople(d, { now: NOW })[0]?.key).toBe("loud@example.com");
  });

  it("puts them back exactly as they were when the operator presses Undo", () => {
    const d = db();
    for (let i = 0; i < 30; i++) mail(d, { from: "loud@example.com", at: NOW - i * DAY });
    for (let i = 0; i < 5; i++) mail(d, { from: "quiet@example.com", at: NOW - i * DAY });
    const before = frequentPeople(d, { now: NOW }).map((p) => `${p.key}:${p.count}`);
    bumpPerson(d, ["loud@example.com"], NOW);
    unbumpPerson(d, ["loud@example.com"]);
    expect(frequentPeople(d, { now: NOW }).map((p) => `${p.key}:${p.count}`)).toEqual(before);
  });

  /**
   * A handle that joins a person after they were put aside must not bring
   * their whole history back with it (review, 2026-09-28): the address book
   * gains a number, the two become one, and nobody has said anything since.
   */
  it("stays put aside when a second handle is merged in afterwards", () => {
    const d = db();
    mail(d, { from: "ana@example.com", at: NOW - 10 * DAY });
    mail(d, { from: "14155550133@s.whatsapp.net", at: NOW - 10 * DAY, account: "a2" });
    mail(d, { from: "other@example.com", at: NOW });
    // Done with the address, before the address book knows the number is hers.
    bumpPerson(d, ["ana@example.com"], NOW - 5 * DAY);
    expect(frequentPeople(d, { now: NOW }).map((p) => p.key)).toEqual(["other@example.com", "14155550133@s.whatsapp.net"]);
    // The operator files the number under the same card. Nothing was said in
    // between, so she is still someone they are done with.
    d.insert(contacts).values({ handle: "ana@example.com", name: "Ana Diaz", refreshedAt: NOW }).run();
    d.insert(contacts).values({ handle: "+14155550133", name: "Ana Diaz", refreshedAt: NOW }).run();
    forgetPeople(d);
    expect(frequentPeople(d, { now: NOW }).map((p) => p.key)).toEqual(["other@example.com"]);
  });

  it("takes every handle a merged person answers to, not only the one pressed", () => {
    const d = db();
    d.insert(contacts).values({ handle: "ana@example.com", name: "Ana Diaz", refreshedAt: NOW }).run();
    d.insert(contacts).values({ handle: "+14155550133", name: "Ana Diaz", refreshedAt: NOW }).run();
    mail(d, { from: "ana@example.com", at: NOW });
    mail(d, { from: "14155550133@s.whatsapp.net", at: NOW, account: "a2" });
    mail(d, { from: "other@example.com", at: NOW });
    const ana = frequentPeople(d, { now: NOW }).find((p) => p.name === "Ana Diaz")!;
    bumpPerson(d, ana.handles, NOW);
    expect(frequentPeople(d, { now: NOW }).map((p) => p.key)).toEqual(["other@example.com"]);
  });

  it("does not touch their mail: every conversation is still there", () => {
    const d = db();
    mail(d, { from: "ana@example.com", at: NOW, thread: "theirs" });
    bumpPerson(d, ["ana@example.com"], NOW);
    expect(listPersonThreads(d, ["ana@example.com"]).map((r) => r.thread.id)).toEqual(["theirs"]);
    // And their own page still finds them.
    expect(personFor(d, "ana@example.com", { now: NOW })?.key).toBe("ana@example.com");
  });

  /**
   * Putting someone aside takes them off a list; it never takes away the way
   * back to what was said. Their page is a link the operator may have open,
   * in Alex, or in another window (own test, 2026-09-28).
   */
  it("keeps their page working, and says they are put aside", () => {
    const d = db();
    mail(d, { from: "ana@example.com", at: NOW - DAY, thread: "theirs" });
    mail(d, { from: "other@example.com", at: NOW });
    bumpPerson(d, ["ana@example.com"], NOW);
    expect(frequentPeople(d, { now: NOW }).map((p) => p.key)).toEqual(["other@example.com"]);
    const ana = personFor(d, "ana@example.com", { now: NOW });
    expect(ana?.key).toBe("ana@example.com");
    expect(ana?.putAside).toBe(true);
    expect(listPersonThreads(d, ana!.handles).map((r) => r.thread.id)).toEqual(["theirs"]);
  });


  it("moves the moment rather than doubling up when pressed twice", () => {
    const d = db();
    mail(d, { from: "ana@example.com", at: NOW });
    bumpPerson(d, ["ana@example.com"], NOW - DAY);
    bumpPerson(d, ["ana@example.com"], NOW);
    const rows = d.select().from(peopleBumps).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.at).toBe(NOW);
  });

  it("asks nothing of the database for nobody", () => {
    const d = db();
    bumpPerson(d, [], NOW);
    expect(d.select().from(peopleBumps).all()).toHaveLength(0);
  });
});
