import type { Db } from "../db/client";

/**
 * What the operator's own messaging looks like (operator, 2026-09-17: "a stats
 * dashboard that analyses and shows my messaging behaviour"). A mirror, not a
 * to-do list: it says when you write, how much, to whom, and how quickly, and
 * it asks nothing of you.
 *
 * Everything here is SQL over what is already stored. No model is called, so
 * the page costs nothing to open however often it is opened.
 *
 * Mail and chats are counted together, which the operator chose knowing chats
 * outnumber mail about fourteen to one: an average over both is mostly a
 * statement about chats. `bySource` is here so that is visible rather than
 * hidden, and the reply-time figures are given per source for the same reason.
 */

/** Nothing before this is counted; null means everything ever stored. */
export type StatsSince = number | null;

export interface Bucket {
  /** 0-23 for hours, 0-6 for weekdays (Sunday first), `YYYY-MM` for months. */
  key: string;
  sent: number;
  received: number;
}

export interface Correspondent {
  /** Their address or handle, which is what the database keys them by. */
  address: string;
  /** The name seen on their messages, when any of them carried one. */
  name: string | null;
  received: number;
  /** Threads with them the operator has written in, so a one-way blast is visible as one. */
  repliedThreads: number;
  threads: number;
  /**
   * The group most of their messages were in, or null when they write to the
   * operator directly. Somebody prolific in a room of a hundred and seventy
   * five is not somebody being ignored, and the table said they were
   * (operator, 2026-09-17: "what is this").
   */
  groupName: string | null;
}

export interface SourceCount {
  /** `inbox`, `sent`, `messages`: where the message lives, which is also what carried it. */
  source: string;
  sent: number;
  received: number;
}

export interface ReplyTime {
  source: "mail" | "chats";
  /** How many inbound messages the operator answered at all, in this range. */
  replied: number;
  /** The middle wait, in minutes. Median rather than mean: one holiday would own the mean. */
  medianMinutes: number | null;
  /** The wait three quarters of replies came in under, in minutes. */
  p75Minutes: number | null;
}

/**
 * How the operator conducts themselves, as counts rather than adjectives
 * (operator, 2026-09-17). Each of these is a fact that can be checked against
 * the database; none of them is a claim about what kind of person that makes
 * anyone. The reading is the operator's to do.
 */
export interface Habits {
  /** Conversations whose first message is the operator's own. */
  startedByYou: number;
  startedByThem: number;
  /** Threads whose newest message is the operator's, so they had the last word. */
  lastWordYours: number;
  threadsTotal: number;
  /** Words in a typical message, theirs beside yours. */
  medianWordsYou: number | null;
  medianWordsThem: number | null;
  /** Your messages carrying a question mark, and how many you sent in all. */
  questionsAsked: number;
  /** Sent between midnight and five in the morning, the operator's own clock. */
  lateNight: number;
  /**
   * Times the operator wrote again before an answer came. Not a verdict: it is
   * how a thought arriving in three parts looks from the database.
   */
  doubleTexts: number;
}

export interface MessagingStats {
  totals: {
    messages: number;
    sent: number;
    received: number;
    threads: number;
    people: number;
    /** The span actually covered, so the page can say what it is describing. */
    firstAt: number | null;
    lastAt: number | null;
  };
  byHour: Bucket[];
  byWeekday: Bucket[];
  byMonth: Bucket[];
  bySource: SourceCount[];
  topCorrespondents: Correspondent[];
  replyTimes: ReplyTime[];
  habits: Habits;
}

/**
 * Everything the dashboard shows, in one read. Written as raw SQL rather than
 * through the query builder: these are aggregates over every message ever
 * stored, and the shapes are easier to read spelled out.
 */
/**
 * One person, one row. WhatsApp hands out two identities for the same
 * contact, an opaque `@lid` and a phone number, and a mail account adds a
 * third; split across them somebody who writes every day can appear twice as
 * two acquaintances. Addresses sharing a display name are folded onto
 * whichever of them has sent most.
 *
 * The name is the only thing there is to match on, so two different people
 * saved under one name would merge. That is the price of not leaving one
 * person in three pieces, and it is the quieter error of the two.
 */
function identities(db: Db, where: string): void {
  db.$client.exec(`drop table if exists temp._identity`);
  db.$client.exec(
    `create temp table _identity as
     select address,
            first_value(address) over (partition by k order by n desc, address) as canon,
            first_value(name) over (partition by k order by n desc, address) as canonName
     from (
       select from_address as address, max(from_name) as name, count(*) as n,
              coalesce(nullif(trim(lower(max(from_name))), ''), from_address) as k
       from messages where ${where} and is_from_operator = 0 group by from_address
     )`,
  );
  db.$client.exec(`create index if not exists temp._identity_ix on _identity(address)`);
}

/** Senders in a thread, counting a person once however many handles they use. */
const SENDERS_IN_THREAD =
  `(select count(distinct coalesce(x2.canon, x.from_address)) from messages x
      left join temp._identity x2 on x2.address = x.from_address
    where x.thread_id = b.thread_id)`;

export function messagingStats(db: Db, since: StatsSince = null): MessagingStats {
  const where = since === null ? "1 = 1" : `m.sent_at >= ${Number(since)}`;
  identities(db, since === null ? "1 = 1" : `sent_at >= ${Number(since)}`);

  const totals = db.$client
    .prepare(
      `select count(*) as messages,
              sum(case when m.is_from_operator = 1 then 1 else 0 end) as sent,
              sum(case when m.is_from_operator = 0 then 1 else 0 end) as received,
              count(distinct m.thread_id) as threads,
              count(distinct case when m.is_from_operator = 0 then m.from_address end) as people,
              min(m.sent_at) as firstAt, max(m.sent_at) as lastAt
       from messages m where ${where}`,
    )
    .get() as MessagingStats["totals"];

  // Local time throughout: "when do you message" is a question about the
  // operator's day, not about UTC.
  const bucketed = (expr: string): Bucket[] =>
    db.$client
      .prepare(
        `select ${expr} as key,
                sum(case when m.is_from_operator = 1 then 1 else 0 end) as sent,
                sum(case when m.is_from_operator = 0 then 1 else 0 end) as received
         from messages m where ${where} group by key order by key`,
      )
      .all() as Bucket[];

  const byHour = bucketed(`strftime('%H', m.sent_at / 1000, 'unixepoch', 'localtime')`);
  const byWeekday = bucketed(`strftime('%w', m.sent_at / 1000, 'unixepoch', 'localtime')`);
  const byMonth = bucketed(`strftime('%Y-%m', m.sent_at / 1000, 'unixepoch', 'localtime')`);

  const bySource = db.$client
    .prepare(
      `select case when m.folder = 'messages' then 'chats' else 'mail' end as source,
              sum(case when m.is_from_operator = 1 then 1 else 0 end) as sent,
              sum(case when m.is_from_operator = 0 then 1 else 0 end) as received
       from messages m where ${where} group by source order by source`,
    )
    .all() as SourceCount[];

  // Who writes to the operator most, and how much of it they answered. A
  // newsletter and a friend both send a hundred messages; only one of them
  // has threads the operator has written in, which is the column that tells
  // them apart. The threads they have written in are gathered once and
  // joined: asked per sender, the same lookup cost most of a second.
  //
  // Where they wrote comes with them. Most of the loudest names here are not
  // writing to the operator at all, they are talking in a group the operator
  // happens to be in, and a table that does not say so reads as a list of
  // people being ignored.
  const topCorrespondents = (
    db.$client
      .prepare(
        `with answered as (select distinct thread_id from messages where is_from_operator = 1),
              tops as (
                select i.canon as address,
                       max(i.canonName) as name,
                       count(*) as received,
                       count(distinct m.thread_id) as threads,
                       count(distinct case when answered.thread_id is not null then m.thread_id end) as repliedThreads
                from messages m
                join temp._identity i on i.address = m.from_address
                left join answered on answered.thread_id = m.thread_id
                where ${where} and m.is_from_operator = 0
                group by i.canon
                order by received desc
                limit 15
              ),
              busiest as (
                select i.canon as address, m.thread_id as thread_id,
                       row_number() over (partition by i.canon order by count(*) desc) as rn
                from tops t
                join temp._identity i on i.canon = t.address
                join messages m on m.from_address = i.address
                where ${where} and m.is_from_operator = 0
                group by i.canon, m.thread_id
              )
         select tops.*, th.subject as threadSubject, th.provider_thread_id as providerThreadId,
                ${SENDERS_IN_THREAD} as senders
         from tops
         join busiest b on b.address = tops.address and b.rn = 1
         join threads th on th.id = b.thread_id
         order by tops.received desc`,
      )
      .all() as (Omit<Correspondent, "groupName"> & { threadSubject: string; providerThreadId: string; senders: number })[]
  ).map(({ threadSubject, providerThreadId, senders, ...rest }) => ({
    ...rest,
    // A WhatsApp group says so in its id; anything else with three or more
    // people talking in it is a room too, which is how an iMessage group and
    // a long cc'd mail thread are caught.
    groupName: providerThreadId.endsWith("@g.us") || senders >= 3 ? threadSubject : null,
  }));

  return { totals, byHour, byWeekday, byMonth, bySource, topCorrespondents, replyTimes: replyTimes(db, since), habits: habits(db, since) };
}

/**
 * How long the operator takes to answer, per source. One row per inbound
 * message that was followed by one of their own in the same thread; the gap
 * between the two is the wait. Messages never answered are not waits, they
 * are silences, and averaging them in would be a different claim.
 *
 * The median and the 75th are read by ordering and skipping, which SQLite
 * does without a window function.
 */
export function replyTimes(db: Db, since: StatsSince = null): ReplyTime[] {
  const where = since === null ? "1 = 1" : `sent_at >= ${Number(since)}`;
  const out: ReplyTime[] = [];
  for (const source of ["mail", "chats"] as const) {
    // Mail keeps the two sides in different folders, so both are needed for a
    // wait to have an end: `inbox` holds theirs and `sent` holds the answer.
    const folderTest = source === "chats" ? `folder = 'messages'` : `folder <> 'messages'`;
    // One ordered pass. For each message, the earliest of the operator's own
    // messages that follows it in the same thread; for an inbound one, the
    // gap to that is the wait. Asked as a correlated subquery per row this
    // took a second and a half over all time (2026-09-17).
    db.$client.exec(`drop table if exists temp._waits`);
    db.$client.exec(
      `create temp table _waits as
       select wait from (
         select is_from_operator as mine,
                min(case when is_from_operator = 1 then sent_at end) over (
                  partition by thread_id order by sent_at, id
                  rows between 1 following and unbounded following
                ) - sent_at as wait
         from messages
         where ${where} and ${folderTest}
       )
       where mine = 0 and wait is not null`,
    );
    const replied = (db.$client.prepare(`select count(*) as n from temp._waits`).get() as { n: number }).n;
    const at = (fraction: number): number | null => {
      if (replied === 0) return null;
      const row = db.$client
        .prepare(`select wait from temp._waits order by wait limit 1 offset ${Math.floor(replied * fraction)}`)
        .get() as { wait: number } | undefined;
      return row ? Math.round(row.wait / 60_000) : null;
    };
    out.push({ source, replied, medianMinutes: at(0.5), p75Minutes: at(0.75) });
    db.$client.exec(`drop table if exists temp._waits`);
  }
  return out;
}

/**
 * The shape of the operator's own half of every conversation. Counts only:
 * who opens, who closes, how long the messages are, how often a question is
 * asked, how late they are sent, and how often a second one goes before the
 * first is answered.
 *
 * Deliberately says nothing about what any of it means. "You open one
 * conversation in seven" is checkable; "you are avoidant" is not, and a page
 * that said the second would be making a claim it cannot support.
 */
export function habits(db: Db, since: StatsSince = null): Habits {
  const where = since === null ? "1 = 1" : `sent_at >= ${Number(since)}`;
  const one = <T>(sql: string): T => db.$client.prepare(sql).get() as T;

  // Whose message is first in the thread, and whose is last.
  const ends = one<{ startedByYou: number; startedByThem: number; lastWordYours: number; threadsTotal: number }>(
    `select
       sum(case when first_mine = 1 then 1 else 0 end) as startedByYou,
       sum(case when first_mine = 0 then 1 else 0 end) as startedByThem,
       sum(case when last_mine = 1 then 1 else 0 end) as lastWordYours,
       count(*) as threadsTotal
     from (
       select thread_id,
              (select is_from_operator from messages a where a.thread_id = m.thread_id and ${where.replace(/sent_at/g, "a.sent_at")} order by a.sent_at asc, a.id asc limit 1) as first_mine,
              (select is_from_operator from messages z where z.thread_id = m.thread_id and ${where.replace(/sent_at/g, "z.sent_at")} order by z.sent_at desc, z.id desc limit 1) as last_mine
       from messages m where ${where} group by m.thread_id
     )`,
  );

  // The middle message length, per side. The mean is owned by one forwarded
  // newsletter; the median is what a message usually looks like.
  const medianWords = (mine: 0 | 1): number | null => {
    const rows = `select length(body_text) - length(replace(body_text, ' ', '')) + 1 as w
                  from messages where ${where} and is_from_operator = ${mine} and length(trim(body_text)) > 0`;
    const n = one<{ n: number }>(`select count(*) as n from (${rows})`).n;
    if (n === 0) return null;
    return one<{ w: number }>(`select w from (${rows}) order by w limit 1 offset ${Math.floor(n / 2)}`)?.w ?? null;
  };

  const counted = one<{ questionsAsked: number; lateNight: number }>(
    `select
       sum(case when body_text like '%?%' then 1 else 0 end) as questionsAsked,
       sum(case when cast(strftime('%H', sent_at / 1000, 'unixepoch', 'localtime') as integer) between 0 and 4 then 1 else 0 end) as lateNight
     from messages where ${where} and is_from_operator = 1`,
  );

  // A message of the operator's whose previous message in the thread was also
  // theirs: they wrote again before an answer came.
  const doubles = one<{ n: number }>(
    `select count(*) as n from (
       select is_from_operator as mine,
              lag(is_from_operator) over (partition by thread_id order by sent_at, id) as prev
       from messages where ${where}
     ) where mine = 1 and prev = 1`,
  );

  return {
    startedByYou: ends.startedByYou ?? 0,
    startedByThem: ends.startedByThem ?? 0,
    lastWordYours: ends.lastWordYours ?? 0,
    threadsTotal: ends.threadsTotal ?? 0,
    medianWordsYou: medianWords(1),
    medianWordsThem: medianWords(0),
    questionsAsked: counted.questionsAsked ?? 0,
    lateNight: counted.lateNight ?? 0,
    doubleTexts: doubles.n ?? 0,
  };
}

/**
 * One correspondent's half of the relationship, and the operator's, side by
 * side (operator, 2026-09-17). Counts only: how quickly each answers the
 * other, how much each writes, when they were last heard from, and whether
 * the conversation is warming or cooling.
 *
 * Nothing here infers what anybody felt. The operator asked for mood about
 * themselves alone, and a named correspondent gets behaviour and no more: a
 * mental state attributed to somebody who cannot see or contest it is a claim
 * this has no business making.
 */
export interface Relationship {
  address: string;
  name: string | null;
  /** The group their messages were mostly in, or null when they write directly. */
  groupName: string | null;
  received: number;
  /** How long the operator typically leaves them waiting, in minutes. */
  yourReplyMinutes: number | null;
  /** How long they typically leave the operator waiting. */
  theirReplyMinutes: number | null;
  medianWordsYou: number | null;
  medianWordsThem: number | null;
  lastHeardAt: number | null;
  /** Their messages in the last ninety days, and in the ninety before that. */
  recent: number;
  prior: number;
}

/**
 * The relationships behind the busiest correspondents. Both directions of
 * waiting come from one ordered pass: for each message, what came before it
 * in the thread and who sent it. Where that flips from one side to the other,
 * the gap is somebody's reply, and it belongs to whichever of them was kept
 * waiting.
 */
export function relationships(db: Db, since: StatsSince = null, limit = 12): Relationship[] {
  const where = since === null ? "1 = 1" : `sent_at >= ${Number(since)}`;
  const ninety = Date.now() - 90 * 86_400_000;
  const oneEighty = Date.now() - 180 * 86_400_000;
  identities(db, where);

  db.$client.exec(`drop table if exists temp._turns`);
  db.$client.exec(
    `create temp table _turns as
     select m.thread_id, m.id, m.sent_at, m.is_from_operator as mine,
            coalesce(i.canon, m.from_address) as from_address,
            length(m.body_text) - length(replace(m.body_text, ' ', '')) + 1 as words,
            lag(m.sent_at) over (partition by m.thread_id order by m.sent_at, m.id) as prev_at,
            lag(m.is_from_operator) over (partition by m.thread_id order by m.sent_at, m.id) as prev_mine,
            lag(coalesce(i.canon, m.from_address)) over (partition by m.thread_id order by m.sent_at, m.id) as prev_from
     from messages m left join temp._identity i on i.address = m.from_address
     where ${where}`,
  );

  // A turn is a reply when the side changed. Yours is owed to whoever spoke
  // before you; theirs is owed by them, to you.
  db.$client.exec(`drop table if exists temp._waits_by`);
  db.$client.exec(
    `create temp table _waits_by as
     select prev_from as address, 'you' as who, sent_at - prev_at as wait
     from temp._turns where mine = 1 and prev_mine = 0 and prev_at is not null
     union all
     select from_address as address, 'them' as who, sent_at - prev_at as wait
     from temp._turns where mine = 0 and prev_mine = 1 and prev_at is not null`,
  );

  const median = db.$client
    .prepare(
      `select address, who, wait from (
         select address, who, wait,
                row_number() over (partition by address, who order by wait) as rn,
                count(*) over (partition by address, who) as n
         from temp._waits_by
       ) where rn = (n + 1) / 2`,
    )
    .all() as { address: string; who: string; wait: number }[];

  const words = db.$client
    .prepare(
      `select address, mine, words from (
         select case when mine = 1 then prev_from else from_address end as address, mine, words,
                row_number() over (partition by case when mine = 1 then prev_from else from_address end, mine order by words) as rn,
                count(*) over (partition by case when mine = 1 then prev_from else from_address end, mine) as n
         from temp._turns where words is not null and (mine = 0 or prev_mine = 0)
       ) where rn = (n + 1) / 2`,
    )
    .all() as { address: string; mine: number; words: number }[];

  const base = db.$client
    .prepare(
      `select i.canon as address, max(i.canonName) as name, count(*) as received, max(m.sent_at) as lastHeardAt,
              sum(case when m.sent_at >= ${ninety} then 1 else 0 end) as recent,
              sum(case when m.sent_at >= ${oneEighty} and m.sent_at < ${ninety} then 1 else 0 end) as prior
       from messages m join temp._identity i on i.address = m.from_address
       where ${where} and m.is_from_operator = 0
       group by i.canon order by received desc limit ${Number(limit)}`,
    )
    .all() as { address: string; name: string | null; received: number; lastHeardAt: number; recent: number; prior: number }[];

  // The same room test as topCorrespondents, run over just these addresses.
  // Borrowing it from messagingStats would mean recomputing every chart to
  // read one column off the end of it.
  const list = base.map((b) => `'${b.address.replace(/'/g, "''")}'`).join(", ") || "''";
  const groups = new Map(
    (
      db.$client
        .prepare(
          `with busiest as (
             select i.canon as address, m.thread_id as thread_id,
                    row_number() over (partition by i.canon order by count(*) desc) as rn
             from messages m join temp._identity i on i.address = m.from_address
             where ${where} and m.is_from_operator = 0 and i.canon in (${list})
             group by i.canon, m.thread_id
           )
           select b.address, th.subject as threadSubject, th.provider_thread_id as providerThreadId,
                  ${SENDERS_IN_THREAD} as senders
           from busiest b join threads th on th.id = b.thread_id where b.rn = 1`,
        )
        .all() as { address: string; threadSubject: string; providerThreadId: string; senders: number }[]
    ).map((g) => [g.address, g.providerThreadId.endsWith("@g.us") || g.senders >= 3 ? g.threadSubject : null] as const),
  );
  const waitOf = (address: string, who: string) => {
    const row = median.find((m) => m.address === address && m.who === who);
    return row ? Math.round(row.wait / 60_000) : null;
  };
  const wordsOf = (address: string, mine: 0 | 1) => words.find((w) => w.address === address && w.mine === mine)?.words ?? null;

  const out = base.map((b) => ({
    address: b.address,
    name: b.name,
    groupName: groups.get(b.address) ?? null,
    received: b.received,
    yourReplyMinutes: waitOf(b.address, "you"),
    theirReplyMinutes: waitOf(b.address, "them"),
    medianWordsYou: wordsOf(b.address, 1),
    medianWordsThem: wordsOf(b.address, 0),
    lastHeardAt: b.lastHeardAt ?? null,
    recent: b.recent ?? 0,
    prior: b.prior ?? 0,
  }));

  db.$client.exec(`drop table if exists temp._turns`);
  db.$client.exec(`drop table if exists temp._waits_by`);
  db.$client.exec(`drop table if exists temp._identity`);
  return out;
}

/** One inbox, and how much of it the operator has managed to organise. */
export interface InboxProjects {
  accountId: string;
  /** The address, which is how the operator knows which inbox this is. */
  email: string;
  provider: string;
  projects: number;
  groups: number;
  /** Messages the filing pass has looked at, and how it went. */
  filed: number;
  unfiled: number;
  /** Messages it has not reached yet, which is not the same as unfiled. */
  pending: number;
}

/** One project, and what has actually landed in it. */
export interface ProjectRollup {
  id: string;
  name: string;
  email: string;
  groupName: string | null;
  messages: number;
  /** Filed by the operator's own hand, rather than by the automatic pass. */
  byHand: number;
  lastAt: number | null;
}

export interface ProjectStats {
  byInbox: InboxProjects[];
  projects: ProjectRollup[];
  totals: { projects: number; filed: number; unfiled: number; pending: number };
}

/**
 * Projects, per inbox and one by one (operator, 2026-09-17: a dashboard about
 * the number of projects from inboxes).
 *
 * A project belongs to one inbox, so "how many projects" is a question about
 * an inbox rather than about the mailbox as a whole, and an inbox with none is
 * worth seeing: it means everything arriving there is unsorted.
 *
 * Unfiled and pending are different things and are counted apart. The filing
 * pass writes a row whether or not it finds a project, so a message with a row
 * and no project was considered and placed nowhere; a message with no row at
 * all has simply not been reached. Folding the second into the first said this
 * mailbox had 4,261 unfiled messages when the true figure was 599, and made
 * the projects look useless when they were merely young.
 */
export function projectStats(db: Db, since: StatsSince = null): ProjectStats {
  const where = since === null ? "1 = 1" : `m.sent_at >= ${Number(since)}`;

  const byInbox = db.$client
    .prepare(
      `select a.id as accountId, a.email as email, a.provider as provider,
              (select count(*) from projects p where p.account_id = a.id) as projects,
              (select count(*) from project_groups g where g.account_id = a.id) as groups,
              sum(case when pa.project_id is not null then 1 else 0 end) as filed,
              sum(case when pa.message_id is not null and pa.project_id is null then 1 else 0 end) as unfiled,
              sum(case when m.id is not null and pa.message_id is null then 1 else 0 end) as pending
       from accounts a
       left join messages m on m.account_id = a.id and ${where}
       left join project_assignments pa on pa.message_id = m.id
       group by a.id
       -- An inbox the pass has worked through and filed nothing from is the
       -- most interesting row here, so it is kept: hiding it behind a project
       -- count lost 376 unfiled messages from the totals.
       having projects > 0 or filed > 0 or unfiled > 0
       order by projects desc, filed desc`,
    )
    .all() as InboxProjects[];

  const projects = db.$client
    .prepare(
      `select p.id as id, p.name as name, a.email as email, g.name as groupName,
              count(pa.message_id) as messages,
              sum(case when pa.source = 'manual' then 1 else 0 end) as byHand,
              max(m.sent_at) as lastAt
       from projects p
       join accounts a on a.id = p.account_id
       left join project_groups g on g.id = p.group_id
       left join project_assignments pa on pa.project_id = p.id
       left join messages m on m.id = pa.message_id and ${where}
       group by p.id
       order by messages desc, p.name`,
    )
    .all() as ProjectRollup[];

  return {
    byInbox,
    projects,
    totals: {
      projects: projects.length,
      filed: byInbox.reduce((n, i) => n + (i.filed ?? 0), 0),
      unfiled: byInbox.reduce((n, i) => n + (i.unfiled ?? 0), 0),
      pending: byInbox.reduce((n, i) => n + (i.pending ?? 0), 0),
    },
  };
}
