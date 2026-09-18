import { describe, it, expect } from "vitest";
import { accountRow, testDb } from "../helpers/db";
import { accounts, messages, threads, type NewMessageRow } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import { habits, messagingStats, projectStats, relationships, replyTimes } from "../../src/stats/stats";

const HOUR = 3_600_000;
/** A Wednesday at 09:00 UTC, so the local-time buckets have something definite to land in. */
const BASE = Date.UTC(2026, 8, 16, 9, 0, 0);

function db() {
  const d = testDb();
  d.insert(accounts).values(accountRow({ id: "a1", provider: "imap", email: "me@example.com" })).run();
  return d;
}

function thread(d: ReturnType<typeof db>, id: string, folder: "inbox" | "messages") {
  d.insert(threads).values({ id, accountId: "a1", providerThreadId: id, subject: id, lastMessageAt: BASE, lastFromOperator: false }).run();
  return folder;
}

function msg(d: ReturnType<typeof db>, p: Partial<NewMessageRow> & Pick<NewMessageRow, "id" | "threadId" | "sentAt">) {
  d.insert(messages)
    .values({
      accountId: "a1",
      providerMessageId: p.id,
      rfcMessageId: null,
      fromAddress: "them@example.com",
      fromName: null,
      toAddresses: [],
      ccAddresses: [],
      subject: "s",
      bodyText: "b",
      bodyHtml: null,
      snippet: null,
      attachmentNames: [],
      isFromOperator: false,
      folder: "inbox",
      receivedAt: p.sentAt,
      ...p,
    })
    .run();
}

describe("messagingStats", () => {
  it("counts what was sent and what arrived, and who it was from", () => {
    const d = db();
    thread(d, "t1", "inbox");
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE, fromAddress: "ada@example.com", fromName: "Ada" });
    msg(d, { id: "m2", threadId: "t1", sentAt: BASE + HOUR, isFromOperator: true, fromAddress: "me@example.com" });
    msg(d, { id: "m3", threadId: "t1", sentAt: BASE + 2 * HOUR, fromAddress: "grace@example.com" });

    const s = messagingStats(d);
    expect(s.totals).toMatchObject({ messages: 3, sent: 1, received: 2, threads: 1, people: 2 });
    expect(s.totals.firstAt).toBe(BASE);
    expect(s.topCorrespondents.map((c) => c.address).sort()).toEqual(["ada@example.com", "grace@example.com"]);
  });

  // A newsletter and a friend both send plenty; only one of them is in a
  // thread the operator has written in. That column is what tells them apart.
  it("says how many of a sender's threads the operator has ever written in", () => {
    const d = db();
    thread(d, "t1", "inbox");
    thread(d, "t2", "inbox");
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE, fromAddress: "friend@example.com" });
    msg(d, { id: "m2", threadId: "t1", sentAt: BASE + HOUR, isFromOperator: true, fromAddress: "me@example.com" });
    msg(d, { id: "m3", threadId: "t2", sentAt: BASE, fromAddress: "news@example.com" });

    const by = Object.fromEntries(messagingStats(d).topCorrespondents.map((c) => [c.address, c]));
    expect(by["friend@example.com"]).toMatchObject({ threads: 1, repliedThreads: 1 });
    expect(by["news@example.com"]).toMatchObject({ threads: 1, repliedThreads: 0 });
  });

  it("keeps mail and chats apart in the source split, though the totals hold both", () => {
    const d = db();
    thread(d, "t1", "inbox");
    thread(d, "t2", "messages");
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE });
    msg(d, { id: "m2", threadId: "t2", sentAt: BASE, folder: "messages" });
    msg(d, { id: "m3", threadId: "t2", sentAt: BASE + HOUR, folder: "messages", isFromOperator: true });

    const s = messagingStats(d);
    expect(s.totals.messages).toBe(3);
    expect(Object.fromEntries(s.bySource.map((r) => [r.source, r]))).toMatchObject({
      mail: { received: 1, sent: 0 },
      chats: { received: 1, sent: 1 },
    });
  });

  it("buckets by the operator's own clock, not by UTC", () => {
    const d = db();
    thread(d, "t1", "inbox");
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE, isFromOperator: true });
    const hour = new Date(BASE).getHours().toString().padStart(2, "0");
    expect(messagingStats(d).byHour.find((b) => b.key === hour)?.sent).toBe(1);
    expect(messagingStats(d).byWeekday.find((b) => b.key === String(new Date(BASE).getDay()))?.sent).toBe(1);
    expect(messagingStats(d).byMonth[0]?.key).toMatch(/^\d{4}-\d{2}$/);
  });

  it("counts nothing before the range it was given", () => {
    const d = db();
    thread(d, "t1", "inbox");
    msg(d, { id: "old", threadId: "t1", sentAt: BASE - 40 * 24 * HOUR });
    msg(d, { id: "new", threadId: "t1", sentAt: BASE });
    expect(messagingStats(d).totals.messages).toBe(2);
    expect(messagingStats(d, BASE - HOUR).totals.messages).toBe(1);
  });
});

describe("replyTimes", () => {
  it("measures the gap to the operator's next message in the thread", () => {
    const d = db();
    thread(d, "t1", "inbox");
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE });
    msg(d, { id: "m2", threadId: "t1", sentAt: BASE + 2 * HOUR, isFromOperator: true });

    const mail = replyTimes(d).find((r) => r.source === "mail")!;
    expect(mail.replied).toBe(1);
    expect(mail.medianMinutes).toBe(120);
  });

  // A message nobody answered is a silence, not a long wait. Counting it as
  // one would make the median a statement about what was ignored.
  it("leaves what was never answered out of the wait entirely", () => {
    const d = db();
    thread(d, "t1", "inbox");
    thread(d, "t2", "inbox");
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE });
    msg(d, { id: "m2", threadId: "t1", sentAt: BASE + HOUR, isFromOperator: true });
    msg(d, { id: "m3", threadId: "t2", sentAt: BASE });

    const mail = replyTimes(d).find((r) => r.source === "mail")!;
    expect(mail.replied).toBe(1);
    expect(mail.medianMinutes).toBe(60);
  });

  it("says nothing rather than zero when there is nothing to measure", () => {
    const d = db();
    const chats = replyTimes(d).find((r) => r.source === "chats")!;
    expect(chats).toMatchObject({ replied: 0, medianMinutes: null, p75Minutes: null });
  });

  it("takes the middle wait, so one long silence cannot own the figure", () => {
    const d = db();
    for (const [i, gap] of [1, 2, 300].entries()) {
      thread(d, `t${i}`, "inbox");
      msg(d, { id: `in${i}`, threadId: `t${i}`, sentAt: BASE });
      msg(d, { id: `out${i}`, threadId: `t${i}`, sentAt: BASE + gap * HOUR, isFromOperator: true });
    }
    const mail = replyTimes(d).find((r) => r.source === "mail")!;
    expect(mail.replied).toBe(3);
    expect(mail.medianMinutes).toBe(120);
  });
});

describe("where a correspondent was writing", () => {
  // The loudest name on the page was a stranger in a 175-person soccer group,
  // sitting in a table headed "who writes to you" (operator, 2026-09-17).
  it("names the group when their messages were in one, and says nothing when they were direct", () => {
    const d = db();
    d.insert(threads).values({ id: "g1", accountId: "a1", providerThreadId: "120363001@g.us", subject: "Five-a-side", lastMessageAt: BASE, lastFromOperator: false }).run();
    thread(d, "t1", "inbox");
    msg(d, { id: "g-m1", threadId: "g1", sentAt: BASE, folder: "messages", fromAddress: "14155550142@s.whatsapp.net" });
    msg(d, { id: "g-m2", threadId: "g1", sentAt: BASE + HOUR, folder: "messages", fromAddress: "other@s.whatsapp.net" });
    msg(d, { id: "d-m1", threadId: "t1", sentAt: BASE, fromAddress: "dana@example.com" });

    const by = Object.fromEntries(messagingStats(d).topCorrespondents.map((c) => [c.address, c]));
    expect(by["14155550142@s.whatsapp.net"]?.groupName).toBe("Five-a-side");
    expect(by["dana@example.com"]?.groupName).toBeNull();
  });

  // An iMessage group has no @g.us to give it away, so the people in it do.
  it("counts a thread with three or more people talking as a group too", () => {
    const d = db();
    d.insert(threads).values({ id: "t9", accountId: "a1", providerThreadId: "chat9", subject: "Five of us", lastMessageAt: BASE, lastFromOperator: false }).run();
    for (const [i, who] of ["a@example.com", "b@example.com", "c@example.com"].entries()) {
      msg(d, { id: `m${i}`, threadId: "t9", sentAt: BASE + i * HOUR, fromAddress: who });
    }
    expect(messagingStats(d).topCorrespondents[0]?.groupName).toBe("Five of us");
  });
});

describe("habits", () => {
  it("says who opened and who closed each conversation", () => {
    const d = db();
    thread(d, "t1", "inbox");
    thread(d, "t2", "inbox");
    // They opened this one; the operator had the last word.
    msg(d, { id: "a1", threadId: "t1", sentAt: BASE });
    msg(d, { id: "a2", threadId: "t1", sentAt: BASE + HOUR, isFromOperator: true });
    // The operator opened this one and they closed it.
    msg(d, { id: "b1", threadId: "t2", sentAt: BASE, isFromOperator: true });
    msg(d, { id: "b2", threadId: "t2", sentAt: BASE + HOUR });

    expect(habits(d)).toMatchObject({ startedByYou: 1, startedByThem: 1, lastWordYours: 1, threadsTotal: 2 });
  });

  // The mean is owned by one forwarded newsletter; the median is what a
  // message usually looks like.
  it("takes the middle message length for each side", () => {
    const d = db();
    thread(d, "t1", "inbox");
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE, isFromOperator: true, bodyText: "one two three" });
    msg(d, { id: "m2", threadId: "t1", sentAt: BASE + HOUR, isFromOperator: true, bodyText: "a b c d e" });
    msg(d, { id: "m3", threadId: "t1", sentAt: BASE + 2 * HOUR, isFromOperator: true, bodyText: "x ".repeat(400) });
    msg(d, { id: "m4", threadId: "t1", sentAt: BASE + 3 * HOUR, bodyText: "only" });

    const h = habits(d);
    expect(h.medianWordsYou).toBe(5);
    expect(h.medianWordsThem).toBe(1);
  });

  it("counts the questions asked and the messages sent in the small hours", () => {
    const d = db();
    thread(d, "t1", "inbox");
    // Both times are built from the local clock: whether a message counts as
    // late depends on the operator's day, and BASE lands at 02:00 in some
    // zones, which is itself the small hours.
    const at = (hour: number) => {
      const t = new Date(BASE);
      t.setHours(hour, 0, 0, 0);
      return t.getTime();
    };
    msg(d, { id: "q", threadId: "t1", sentAt: at(13), isFromOperator: true, bodyText: "are you around?" });
    msg(d, { id: "n", threadId: "t1", sentAt: at(2), isFromOperator: true, bodyText: "still up" });
    // Theirs is counted in neither: these are the operator's own habits.
    msg(d, { id: "t", threadId: "t1", sentAt: at(3), bodyText: "you awake?" });

    expect(habits(d)).toMatchObject({ questionsAsked: 1, lateNight: 1 });
  });

  // Back to back, not "double texting": a thought arriving in three parts is
  // what most of these are, and the count should not imply otherwise.
  it("counts a message whose predecessor in the thread was also the operator's", () => {
    const d = db();
    thread(d, "t1", "inbox");
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE, isFromOperator: true });
    msg(d, { id: "m2", threadId: "t1", sentAt: BASE + 60_000, isFromOperator: true });
    msg(d, { id: "m3", threadId: "t1", sentAt: BASE + 120_000, isFromOperator: true });
    msg(d, { id: "m4", threadId: "t1", sentAt: BASE + 3 * HOUR });
    msg(d, { id: "m5", threadId: "t1", sentAt: BASE + 4 * HOUR, isFromOperator: true });

    // Two of the three in the opening run, and none for the one that answered.
    expect(habits(d).doubleTexts).toBe(2);
  });
});

describe("relationships", () => {
  it("attributes each wait to whoever was kept waiting", () => {
    const d = db();
    thread(d, "t1", "messages");
    // She writes, they take an hour. He writes, she takes two.
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE, fromAddress: "her@example.com", fromName: "Her", bodyText: "one two three" });
    msg(d, { id: "m2", threadId: "t1", sentAt: BASE + HOUR, isFromOperator: true, bodyText: "a b c d e" });
    msg(d, { id: "m3", threadId: "t1", sentAt: BASE + 3 * HOUR, fromAddress: "her@example.com", fromName: "Her", bodyText: "one two three" });

    const r = relationships(d, null)[0]!;
    expect(r.address).toBe("her@example.com");
    expect(r.name).toBe("Her");
    expect(r.received).toBe(2);
    expect(r.yourReplyMinutes).toBe(60);
    expect(r.theirReplyMinutes).toBe(120);
    expect(r.medianWordsYou).toBe(5);
    expect(r.medianWordsThem).toBe(3);
    expect(r.lastHeardAt).toBe(BASE + 3 * HOUR);
  });

  it("counts the last ninety days against the ninety before, so a fade is visible", () => {
    const d = db();
    thread(d, "t2", "messages");
    const day = 24 * HOUR;
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      msg(d, { id: `r${i}`, threadId: "t2", sentAt: now - 10 * day - i * day, fromAddress: "fading@example.com" });
    }
    for (let i = 0; i < 9; i += 1) {
      msg(d, { id: `p${i}`, threadId: "t2", sentAt: now - 120 * day - i * day, fromAddress: "fading@example.com" });
    }

    const r = relationships(d, null)[0]!;
    expect(r.recent).toBe(3);
    expect(r.prior).toBe(9);
  });

  it("leaves a wait null when nobody ever answered", () => {
    const d = db();
    thread(d, "t3", "messages");
    msg(d, { id: "s1", threadId: "t3", sentAt: BASE, fromAddress: "silent@example.com" });
    msg(d, { id: "s2", threadId: "t3", sentAt: BASE + HOUR, fromAddress: "silent@example.com" });

    const r = relationships(d, null)[0]!;
    expect(r.received).toBe(2);
    expect(r.yourReplyMinutes).toBeNull();
    expect(r.theirReplyMinutes).toBeNull();
  });
});

describe("one person, one row", () => {
  it("folds a WhatsApp @lid and a phone number together when they share a name", () => {
    const d = db();
    thread(d, "t9", "messages");
    for (let i = 0; i < 4; i += 1) {
      msg(d, { id: `l${i}`, threadId: "t9", sentAt: BASE + i * HOUR, fromAddress: "14155550188@lid", fromName: "Dana Reyes" });
    }
    msg(d, { id: "p1", threadId: "t9", sentAt: BASE + 9 * HOUR, fromAddress: "14155550199@s.whatsapp.net", fromName: "Dana Reyes" });

    const top = messagingStats(d, null).topCorrespondents;
    expect(top).toHaveLength(1);
    expect(top[0]!.received).toBe(5);
    // Folded onto the busier handle, not the one that happens to sort first.
    expect(top[0]!.address).toBe("14155550188@lid");
    expect(top[0]!.name).toBe("Dana Reyes");

    expect(relationships(d, null)[0]!.received).toBe(5);
  });

  it("keeps two nameless handles apart, having nothing to match them on", () => {
    const d = db();
    thread(d, "ta", "messages");
    msg(d, { id: "n1", threadId: "ta", sentAt: BASE, fromAddress: "111@s.whatsapp.net", fromName: null });
    msg(d, { id: "n2", threadId: "ta", sentAt: BASE + HOUR, fromAddress: "222@s.whatsapp.net", fromName: null });

    expect(messagingStats(d, null).topCorrespondents).toHaveLength(2);
  });
});

describe("projectStats", () => {
  function withProjects(d: ReturnType<typeof db>) {
    d.insert(schema.projects).values({ id: "p1", accountId: "a1", name: "Visa", description: "immigration", position: 0, createdAt: BASE }).run();
    d.insert(schema.projects).values({ id: "p2", accountId: "a1", name: "Billing", description: "invoices", position: 1, createdAt: BASE }).run();
    return d;
  }

  it("counts a project's messages and how many the operator filed by hand", () => {
    const d = withProjects(db());
    thread(d, "t1", "inbox");
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE });
    msg(d, { id: "m2", threadId: "t1", sentAt: BASE + 1000 });
    d.insert(schema.projectAssignments).values({ messageId: "m1", projectId: "p1", source: "manual", score: null, assignedAt: BASE }).run();
    d.insert(schema.projectAssignments).values({ messageId: "m2", projectId: "p1", source: "auto", score: 0.8, assignedAt: BASE }).run();

    const visa = projectStats(d, null).projects.find((p) => p.name === "Visa")!;
    expect(visa.messages).toBe(2);
    expect(visa.byHand).toBe(1);
  });

  it("does not call a message unfiled when the pass has not reached it yet", () => {
    const d = withProjects(db());
    thread(d, "t1", "inbox");
    // One considered and placed nowhere, one never looked at.
    msg(d, { id: "seen", threadId: "t1", sentAt: BASE });
    msg(d, { id: "untouched", threadId: "t1", sentAt: BASE + 1000 });
    d.insert(schema.projectAssignments).values({ messageId: "seen", projectId: null, source: "auto", score: null, assignedAt: BASE }).run();

    const t = projectStats(d, null).totals;
    // Counting the untouched one as unfiled made this mailbox look far worse
    // than it was: 4,261 against a true 599.
    expect(t.unfiled).toBe(1);
    expect(t.pending).toBe(1);
  });

  it("keeps an inbox that has no projects at all, which is the one worth seeing", () => {
    const d = db();
    thread(d, "t1", "inbox");
    msg(d, { id: "m1", threadId: "t1", sentAt: BASE });
    d.insert(schema.projectAssignments).values({ messageId: "m1", projectId: null, source: "auto", score: null, assignedAt: BASE }).run();

    const rows = projectStats(d, null).byInbox;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projects).toBe(0);
    expect(rows[0]!.unfiled).toBe(1);
  });

  it("lists a project with nothing in it, so an empty one is visible", () => {
    const d = withProjects(db());
    const names = projectStats(d, null).projects.map((p) => p.name);
    expect(names).toContain("Billing");
    expect(projectStats(d, null).projects.find((p) => p.name === "Billing")!.messages).toBe(0);
  });
});
