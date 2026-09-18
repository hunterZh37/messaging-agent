import type { DraftView } from "@messaging-agent/core";

export const SEND_DELAY_MS = 6000;

/**
 * How long a send waits with Undo up. Mail waits six seconds. A text goes at
 * once (operator, 2026-09-11: "I just want it to be instant"): it is one
 * line to one person, and Messages has no unsend either way.
 */
export function sendDelayFor(item: { account: { provider: string } }): number {
  return item.account.provider === "imessage" || item.account.provider === "whatsapp" ? 0 : SEND_DELAY_MS;
}

export interface PendingSend {
  draftId: string;
  finalText: string;
  to: string[];
  cc: string[];
  endsAt: number;
  item: DraftView;
}

export interface QueueState {
  items: DraftView[];
  errors: Record<string, string>;
  edits: Record<string, { text: string; to: string[]; cc: string[] }>;
  /**
   * Drafts this browser has taken out of the list: skipped, or handed to the
   * send gate. The database still calls them pending for a moment, so without
   * this the next server list would put them back under the operator's hand.
   */
  gone?: string[];
}

export type QueueEvent =
  /** The gate was passed: the card leaves this list and the send gate has it. */
  | { type: "confirm_send"; draftId: string; finalText: string; to: string[]; cc: string[] }
  /** Undo inside the window, or a send that never left: the card belongs back. */
  | { type: "returned"; item: DraftView; edit?: { text: string; to: string[]; cc: string[] } }
  | { type: "send_failed"; draftId: string; message: string; item: DraftView }
  | { type: "skipped"; draftId: string }
  /** The queue as the server has just rendered it, oldest first. */
  | { type: "server_items"; items: DraftView[] };

function takenOut(gone: string[] | undefined, draftId: string): string[] {
  return gone?.includes(draftId) ? gone : [...(gone ?? []), draftId];
}

function backIn(gone: string[] | undefined, draftId: string): string[] {
  return (gone ?? []).filter((id) => id !== draftId);
}

/**
 * The cards a page still has to show: the queue on the Drafts folder, or the
 * one reply card under a thread. What happens to a send once the operator has
 * confirmed it is not here — that outlives this page (see `sendReducer`) —
 * so this only has to know which cards are on screen and what was typed into
 * them. Pure, so both are tested without React.
 */
export function queueReducer(s: QueueState, e: QueueEvent): QueueState {
  switch (e.type) {
    case "confirm_send": {
      const item = s.items.find((i) => i.draft.id === e.draftId);
      if (!item) return s;
      const { [e.draftId]: _dropped, ...errors } = s.errors;
      return {
        items: s.items.filter((i) => i.draft.id !== e.draftId),
        errors,
        // Kept because a card that comes back — undone, or a send that failed
        // — has to come back with the words the operator sent, not the words
        // Celeste wrote.
        edits: { ...s.edits, [e.draftId]: { text: e.finalText, to: e.to, cc: e.cc } },
        gone: takenOut(s.gone, e.draftId),
      };
    }
    case "returned":
      return {
        ...s,
        items: [e.item, ...s.items.filter((i) => i.draft.id !== e.item.draft.id)],
        // A deleted draft comes back with what the operator had typed into it (2026-09-14).
        ...(e.edit ? { edits: { ...s.edits, [e.item.draft.id]: e.edit } } : {}),
        gone: backIn(s.gone, e.item.draft.id),
      };
    case "send_failed":
      return {
        ...s,
        items: [e.item, ...s.items.filter((i) => i.draft.id !== e.draftId)],
        errors: { ...s.errors, [e.draftId]: e.message },
        gone: backIn(s.gone, e.draftId),
      };
    case "skipped":
      return { ...s, items: s.items.filter((i) => i.draft.id !== e.draftId), gone: takenOut(s.gone, e.draftId) };
    /**
     * The list is the server's again: a draft Celeste has just written joins
     * it without a reload, and one that has gone leaves. What this browser
     * already took out stays out, because the row it was reading may not have
     * caught up with the skip or the send yet.
     */
    case "server_items": {
      const gone = new Set(s.gone ?? []);
      return { ...s, items: e.items.filter((i) => !gone.has(i.draft.id)) };
    }
  }
}

/**
 * The send gate itself (spec 8): what the operator has confirmed and not yet
 * taken back. It is kept apart from the queue above because it has to outlive
 * the page the card was read on — the operator pressed Send and walked off to
 * another thread, and the mail still has to go (operator, 2026-09-10: the
 * first press sent nothing).
 */
export interface SendState {
  /** Confirmed sends waiting out their six seconds, oldest first. */
  pending: PendingSend[];
  /** Sends handed to the server and not yet answered for. */
  inFlight: string[];
  /** Mail that has gone, said so for a few seconds (spec 8, 2026-09-10). */
  sent: SentNotice[];
  /** Deletes waiting out the same six seconds (spec 10a, 2026-09-11). */
  trash: PendingTrash[];
  /**
   * Deletes handed to the server and not yet answered for. The whole job is
   * kept rather than its id, because its threads must stay off the lists
   * until the server has actually moved them.
   */
  trashInFlight: PendingTrash[];
  /** Mail that has gone to Trash, said so for a few seconds. */
  trashed: TrashNotice[];
  /**
   * Threads the server has moved to Trash this session. They stay off every
   * list for good: between the server's answer and the page reading itself
   * again, a row and a pane came back for a moment (operator, 2026-09-11).
   */
  gone: string[];
  /**
   * Threads the server has hidden this session (2026-09-15). Kept apart from
   * `gone`: a hidden thread leaves the four sorting lists and stays in Inbox
   * and Messages, so only those lists may drop it.
   */
  hid?: string[];
  /**
   * Deletes the server has done, oldest first: the undo stack (operator,
   * 2026-09-11: Cmd-Z brings the last deleted mail back). The last one is
   * what Cmd-Z takes back, then the one before it.
   */
  done: PendingTrash[];
  /** Restores handed to the server and not yet answered for, by job id. */
  restoring: string[];
  /**
   * Threads on their way back on screen (operator, 2026-09-11: Cmd-Z should
   * be instant, and animated): the pane and the row slide in while they are
   * on this list, which they leave once the return has settled.
   */
  returning: string[];
  /**
   * Threads sweeping off the screen as handled (operator, 2026-09-11: Shift
   * marks the mail handled, "snappy, with a satisfying animation, the same
   * as Delete"). The server is told at the same moment.
   */
  handling: string[];
  /** Threads the server has marked handled this session: off the Need-to-reply list until the page reads itself again. */
  handled: string[];
}

/**
 * One delete waiting out its window (spec 10a, 2026-09-11). Deleting is the
 * second gated write, and it goes through this gate rather than a second one
 * of its own: one click, one countdown, one Undo, and nothing moves until the
 * seconds are up. Threads rather than messages, because a conversation is
 * what the operator meant to throw away.
 */
export interface PendingTrash {
  /**
   * Say "Undo" on the toast once it is done. Off by default (operator,
   * 2026-09-11: the Deleted toasts were not wanted); on for a delete made by
   * touch, where there is no Cmd-Z to bring the mail back.
   */
  undo?: boolean;
  /** Hide, not delete (operator, 2026-09-11): the chat leaves Celeste for Deleted items and stays in its app. */
  hide?: boolean;
  /** This job's own id, so two deletes can count down side by side. */
  id: string;
  threadIds: string[];
  endsAt: number;
  /** How far a delete of many has got (operator, 2026-09-13: a progress bar). */
  progress?: { done: number; total: number };
}

/** "Deleted 3 threads · in Trash for 30 days", and when it stops being said. */
export interface TrashNotice {
  id: string;
  label: string;
  until: number;
  /** The delete job this notice can take back, while it is still on the stack. */
  undoJobId?: string;
  /**
   * What this notice counts, when a second of the same kind should add to it
   * rather than stack beneath it (stress audit, 2026-09-11): two Cmd-Z in a
   * row read "Restored 2 threads", not two identical toasts.
   */
  tally?: { key: "restored" | "trashed" | "hidden"; count: number };
  /** Every delete job a merged toast can take back at once (operator, 2026-09-11: no stacking on the phone). */
  undoJobIds?: string[];
}

/** "Sent to jocelyn@… · Re: Visa timeline", and when it stops being said. */
export interface SentNotice {
  draftId: string;
  label: string;
  until: number;
}

export type SendEvent =
  | { type: "queued"; send: PendingSend }
  /** Undo, inside the window: nothing was sent and nothing will be. */
  | { type: "undone"; draftId: string }
  /** It has gone to the server; the window is over either way. */
  | { type: "dispatched"; draftId: string }
  /** The server has answered, well or badly. Either way it is no longer on its way. */
  | { type: "settled"; draftId: string }
  /** The server says the mail left. */
  | { type: "sent"; draftId: string; label: string; now: number }
  /** The clock, taking down notices whose few seconds are up. */
  | { type: "expire"; now: number }
  /** A delete has passed the gate: its six seconds start here. */
  | { type: "trash_queued"; job: PendingTrash }
  /** Undo, inside the window: nothing was deleted and nothing will be. */
  | { type: "trash_undone"; id: string }
  | { type: "trash_dispatched"; id: string }
  | { type: "trash_settled"; id: string }
  | { type: "trash_progress"; id: string; done: number; total: number }
  /** The server says the mail is in Trash. */
  | { type: "trashed"; id: string; label: string; now: number; undoJobId?: string; tally?: TrashNotice["tally"] }
  /** The server has moved this job's threads to Trash: off the lists, and on the undo stack. */
  | { type: "trash_done"; job: PendingTrash }
  /**
   * Cmd-Z: the job comes off the stack, and its threads are back on screen
   * at once, before the server has moved anything (operator, 2026-09-11:
   * "make it instant").
   */
  | { type: "undo_started"; job: PendingTrash }
  /** The return has settled on screen: nothing slides in any more. */
  | { type: "returned"; threadIds: string[] }
  /** The mail is back in the inbox: its threads may show again. */
  | { type: "undo_done"; id: string; threadIds: string[] }
  /** The server would not bring it back: the threads go again, and the job goes back on the stack. */
  | { type: "undo_failed"; job: PendingTrash }
  /** A notice with no job behind it, said for a few seconds. */
  | { type: "notice"; id: string; label: string; now: number; undoJobId?: string; tally?: TrashNotice["tally"] }
  /** One notice taken down early, its Undo having been pressed. */
  | { type: "dismiss"; id: string }
  /** Shift, or the button: the thread sweeps off as handled while the server is told. */
  | { type: "handle_started"; threadId: string }
  /** The server has the handled action: the thread stays off the list. */
  | { type: "handle_done"; threadId: string }
  /** The server would not take it: the thread is back as it was. */
  | { type: "handle_failed"; threadId: string };

export function sendReducer(s: SendState, e: SendEvent): SendState {
  switch (e.type) {
    case "queued":
      return { ...s, pending: [...s.pending.filter((p) => p.draftId !== e.send.draftId), e.send] };
    case "undone":
      return { ...s, pending: s.pending.filter((p) => p.draftId !== e.draftId) };
    case "dispatched":
      return {
        ...s,
        pending: s.pending.filter((p) => p.draftId !== e.draftId),
        inFlight: s.inFlight.includes(e.draftId) ? s.inFlight : [...s.inFlight, e.draftId],
      };
    case "settled":
      return { ...s, inFlight: s.inFlight.filter((id) => id !== e.draftId) };
    case "sent":
      return { ...s, sent: [...s.sent.filter((n) => n.draftId !== e.draftId), { draftId: e.draftId, label: e.label, until: e.now + SENT_TOAST_MS }] };
    case "expire": {
      const sent = s.sent.filter((n) => n.until > e.now);
      const trashed = s.trashed.filter((n) => n.until > e.now);
      return sent.length === s.sent.length && trashed.length === s.trashed.length ? s : { ...s, sent, trashed };
    }
    case "trash_queued":
      return { ...s, trash: [...s.trash.filter((j) => j.id !== e.job.id), e.job] };
    case "trash_undone":
      return { ...s, trash: s.trash.filter((j) => j.id !== e.id) };
    case "trash_dispatched": {
      const job = s.trash.find((j) => j.id === e.id) ?? s.trashInFlight.find((j) => j.id === e.id);
      if (!job) return s;
      return {
        ...s,
        trash: s.trash.filter((j) => j.id !== e.id),
        trashInFlight: s.trashInFlight.some((j) => j.id === e.id) ? s.trashInFlight : [...s.trashInFlight, job],
      };
    }
    case "trash_settled":
      return { ...s, trashInFlight: s.trashInFlight.filter((j) => j.id !== e.id) };
    case "trash_progress":
      return { ...s, trashInFlight: s.trashInFlight.map((j) => (j.id === e.id ? { ...j, progress: { done: e.done, total: e.total } } : j)) };
    case "trashed": {
      // Deletes in a row read as one toast with a running count and one
      // Undo that takes them all back (operator, 2026-09-11: three stacked
      // "Deleted 1 thread" toasts on the phone).
      const same = e.tally ? s.trashed.find((n) => n.tally?.key === e.tally?.key) : undefined;
      const tally = e.tally && same?.tally ? { key: e.tally.key, count: same.tally.count + e.tally.count } : e.tally;
      const label = tally && same ? tallyLabel(tally) : e.label;
      const undoJobIds = [...(same?.undoJobIds ?? (same?.undoJobId ? [same.undoJobId] : [])), ...(e.undoJobId ? [e.undoJobId] : [])];
      return {
        ...s,
        trashed: [
          ...s.trashed.filter((n) => n.id !== e.id && n !== same),
          {
            id: e.id,
            label,
            until: e.now + SENT_TOAST_MS,
            ...(e.undoJobId ? { undoJobId: e.undoJobId } : {}),
            ...(undoJobIds.length > 1 ? { undoJobIds } : {}),
            ...(tally ? { tally } : {}),
          },
        ],
      };
    }
    case "trash_done":
      return e.job.hide
        ? { ...s, hid: [...new Set([...(s.hid ?? []), ...e.job.threadIds])], done: [...s.done.filter((j) => j.id !== e.job.id), e.job] }
        : { ...s, gone: [...new Set([...s.gone, ...e.job.threadIds])], done: [...s.done.filter((j) => j.id !== e.job.id), e.job] };
    case "undo_started":
      return {
        ...s,
        done: s.done.filter((j) => j.id !== e.job.id),
        restoring: [...s.restoring, e.job.id],
        gone: s.gone.filter((id) => !e.job.threadIds.includes(id)),
        hid: (s.hid ?? []).filter((id) => !e.job.threadIds.includes(id)),
        returning: [...new Set([...s.returning, ...e.job.threadIds])],
      };
    case "undo_done":
      return { ...s, restoring: s.restoring.filter((id) => id !== e.id), gone: s.gone.filter((id) => !e.threadIds.includes(id)), hid: (s.hid ?? []).filter((id) => !e.threadIds.includes(id)) };
    case "returned":
      return { ...s, returning: s.returning.filter((id) => !e.threadIds.includes(id)) };
    case "undo_failed":
      return {
        ...s,
        restoring: s.restoring.filter((id) => id !== e.job.id),
        done: [...s.done.filter((j) => j.id !== e.job.id), e.job],
        ...(e.job.hide ? { hid: [...new Set([...(s.hid ?? []), ...e.job.threadIds])] } : { gone: [...new Set([...s.gone, ...e.job.threadIds])] }),
        returning: s.returning.filter((id) => !e.job.threadIds.includes(id)),
      };
    case "notice": {
      const same = e.tally ? s.trashed.find((n) => n.tally?.key === e.tally?.key) : undefined;
      const tally = e.tally && same?.tally ? { key: e.tally.key, count: same.tally.count + e.tally.count } : e.tally;
      const label = tally && same ? tallyLabel(tally) : e.label;
      return {
        ...s,
        trashed: [
          ...s.trashed.filter((n) => n.id !== e.id && n !== same),
          { id: e.id, label, until: e.now + SENT_TOAST_MS, ...(e.undoJobId ? { undoJobId: e.undoJobId } : {}), ...(tally ? { tally } : {}) },
        ],
      };
    }
    case "dismiss":
      return { ...s, trashed: s.trashed.filter((n) => n.id !== e.id) };
    case "handle_started":
      return { ...s, handling: [...new Set([...s.handling, e.threadId])] };
    case "handle_done":
      return { ...s, handling: s.handling.filter((id) => id !== e.threadId), handled: [...new Set([...s.handled, e.threadId])] };
    case "handle_failed":
      return { ...s, handling: s.handling.filter((id) => id !== e.threadId) };
  }
}

/** Threads a Need-to-reply list must not show: handled this session, or on their way to it. */
export function handledThreadIds(s: SendState): string[] {
  return [...new Set([...s.handling, ...s.handled])];
}

/**
 * What happens the moment the server says the mail left (spec 8, 2026-09-10).
 * Sending writes the draft's row and nothing else: the copy of the reply only
 * exists at the provider, so until this inbox is pulled again the thread still
 * looks unanswered and goes on sitting under Need to reply. So the page is
 * read again at once — that is the fast half, and it takes the card away —
 * and then the inbox is pulled and the page read a second time, which is when
 * the thread moves.
 *
 * The two things it does are handed in, so the order is a test rather than a
 * comment, and a sync that fails still leaves the first refresh done.
 */
export async function afterSend(
  p: { accountId: string },
  io: { refresh: () => void; sync: (accountId: string) => Promise<unknown> },
): Promise<void> {
  io.refresh();
  try {
    await io.sync(p.accountId);
  } catch {
    // The mail has gone either way. A sync that failed is the next sync's
    // problem, not something to undo a send over.
  }
  io.refresh();
}

/**
 * How long "Sent to …" stays up. Long enough to read on the way past and
 * short enough not to sit over the next card (spec 8, 2026-09-10).
 */
export const SENT_TOAST_MS = 5000;

/** Past this, the subject is dropped rather than cut: the recipient matters more. */
const SENT_TOAST_MAX = 60;

/**
 * What the toast says once the mail has gone (spec 8, 2026-09-10). Operator:
 * the countdown simply vanished, so a send that worked and a send that never
 * happened looked exactly alike. Who it went to leads, because that is what
 * the operator is checking; the subject comes along when there is room for
 * all of it, and is left off rather than trailing into an ellipsis.
 */
export function sentToastLabel(p: { to: string[]; subject: string }): string {
  const who = p.to[0];
  const others = p.to.length > 1 ? ` +${p.to.length - 1}` : "";
  const lead = who ? `Sent to ${who}${others}` : "Sent";
  const subject = p.subject.trim();
  const whole = `${lead} · ${subject}`;
  return subject && whole.length <= SENT_TOAST_MAX ? whole : lead;
}

/** The sends whose six seconds are up, minus any already on their way. */
export function dueSends(s: SendState, now: number, inFlight: readonly string[] = []): PendingSend[] {
  return s.pending.filter((p) => p.endsAt <= now && !inFlight.includes(p.draftId));
}

/**
 * The sends that have to go now because the page itself is going: the tab is
 * closing or the browser is leaving. The undo window is forfeited by leaving,
 * which is the honest trade — the operator pressed Send, and a window nobody
 * is watching is not a window. Sends already on their way are left alone, or
 * the same mail would go twice.
 */
export function sendsOnLeaving(s: SendState, inFlight: readonly string[] = []): PendingSend[] {
  return s.pending.filter((p) => !inFlight.includes(p.draftId));
}

/**
 * Which drafts are on their way out, so no list puts one back on screen:
 * counting down, or handed over and not yet answered for. A send that failed
 * has been answered for, and its card belongs back in front of the operator,
 * which is why this is read from state rather than from the guard the
 * dispatcher keeps.
 */
export function leavingDraftIds(s: SendState): string[] {
  return [...new Set([...s.pending.map((p) => p.draftId), ...s.inFlight])];
}

/** "3 threads" or "1 thread": the unit a delete is counted in, everywhere it is said. */
export function threadCountLabel(n: number, chats = false): string {
  const one = chats ? "chat" : "thread";
  return n === 1 ? `1 ${one}` : `${n} ${one}s`;
}

/** A chat's thread id names its app's chat: a Messages guid, or a WhatsApp JID (2026-09-11). */
export function isChatThreadId(threadId: string): boolean {
  return threadId.includes(";-;") || /@(g\.us|s\.whatsapp\.net|lid)$/.test(threadId);
}
const allChats = (threadIds: string[]) => threadIds.length > 0 && threadIds.every(isChatThreadId);

/**
 * What the toast says once the mail is in Trash (spec 10a, 2026-09-11). The
 * thirty days are said out loud because there is no Undo left by then: the
 * way back is the provider's, and the operator has to know it exists.
 */
export function trashedToastLabel(threadIds: string[]): string {
  return `Deleted ${threadCountLabel(threadIds.length, allChats(threadIds))} · in Trash for 30 days`;
}

/**
 * What the toast says while a delete of many is under way (operator,
 * 2026-09-13: "how many are getting deleted and how many are left").
 */
export function progressLabel(job: PendingTrash): string {
  const total = job.progress?.total ?? job.threadIds.length;
  const done = job.progress?.done ?? 0;
  const what = allChats(job.threadIds) ? "chats" : "threads";
  const verb = job.hide ? "Hiding" : "Deleting";
  // Before the first chunk comes back there is no "of" worth saying. Mail
  // goes ten at a time, so a delete of ten or fewer is a single round trip
  // and "Deleting 0 of 5 threads…" was the only thing this toast ever said
  // (operator, 2026-09-18: the progression is not displaying).
  return done === 0 ? `${verb} ${total} ${what}…` : `${verb} ${done} of ${total} ${what}…`;
}

/**
 * How full the bar is, or null when there is nothing honest to put in it yet.
 *
 * Progress arrives a chunk at a time, and the common delete is one chunk, so
 * until the first one lands the only true answer is "under way". The bar says
 * that by moving rather than by sitting at zero, which read as nothing
 * happening at all.
 */
export function progressFraction(job: PendingTrash): number | null {
  const total = job.progress?.total ?? job.threadIds.length;
  const done = job.progress?.done ?? 0;
  if (done === 0) return null;
  return total > 0 ? Math.min(1, done / total) : 0;
}

/** How many threads go to the server at once: chats take seconds apiece in their app, mail moves in bulk. */
export function trashChunkSize(threadIds: string[]): number {
  return allChats(threadIds) ? 2 : 10;
}

/** What the toast says when the provider would not let some of a delete go (2026-09-11: Messages.app kept two chats). */
export function keptToastLabel(count: number, chats = false): string {
  const what = chats ? (count === 1 ? "1 chat" : `${count} chats`) : threadCountLabel(count);
  return `Could not delete ${what} · ${chats ? "Messages kept " : "the provider kept "}${count === 1 ? "it" : "them"}`;
}

/** What the toast says once the mail is back (operator, 2026-09-11: undo delete). */
export function restoredToastLabel(threadIds: string[]): string {
  // A chat comes back to Messages, mail to its inbox: "where it was" covers both.
  return `Restored ${threadCountLabel(threadIds.length, allChats(threadIds))} · back where it was`;
}

/** The words for a running count on a toast. */
export function tallyLabel(tally: NonNullable<TrashNotice["tally"]>): string {
  if (tally.key === "trashed") return `Deleted ${threadCountLabel(tally.count)} · in Trash for 30 days`;
  if (tally.key === "hidden") return `Hid ${threadCountLabel(tally.count)} · here only`;
  // A chat comes back to Messages, mail to its inbox: "where it was" covers both.
  return `Restored ${threadCountLabel(tally.count)} · back where it was`;
}

/** The delete Cmd-Z takes back: the last one done, or the one named. */
export function undoTarget(s: SendState, id?: string): PendingTrash | null {
  if (id) return s.done.find((j) => j.id === id) ?? null;
  return s.done.at(-1) ?? null;
}

/**
 * A delete job that is due the moment it is queued (operator, 2026-09-11:
 * "just delete instantly"). Nothing is destroyed, so no countdown stands in
 * front of it: the mail waits thirty days in the provider's own Trash.
 */
export function trashJob(threadIds: string[], now: number, id = `trash-${now}-${Math.random().toString(36).slice(2, 8)}`, undo = false, hide = false): PendingTrash {
  return { id, threadIds: [...new Set(threadIds)], endsAt: now, ...(undo ? { undo: true } : {}), ...(hide ? { hide: true } : {}) };
}

/** What the toast says once a thread is hidden (operator, 2026-09-11): in Deleted items here, untouched in the mailbox or the app. */
export function hiddenToastLabel(threadIds: string[]): string {
  const chats = allChats(threadIds);
  // Out of the sorting lists, still in the folder (2026-09-15).
  return `Hid ${threadCountLabel(threadIds.length, chats)} · still in ${chats ? "Messages" : "Inbox"}`;
}

/** The deletes that are due, minus any already on their way. */
export function dueTrash(s: SendState, now: number, inFlight: readonly string[] = []): PendingTrash[] {
  return s.trash.filter((j) => j.endsAt <= now && !inFlight.includes(j.id));
}

/**
 * The deletes that have to go now because the page itself is going, for the
 * same reason a send does: the operator pressed the button, and a window
 * nobody is watching is not a window.
 */
export function trashOnLeaving(s: SendState, inFlight: readonly string[] = []): PendingTrash[] {
  return s.trash.filter((j) => !inFlight.includes(j.id));
}

/**
 * Which threads no list should show: on their way to Trash, handed over and
 * not yet answered for, or already there. A thread that went stays on this
 * list for the session, so nothing brings it back for the moment between the
 * server's answer and the page's next read.
 */
export function leavingThreadIds(s: SendState): string[] {
  return [...new Set([...s.trash, ...s.trashInFlight].flatMap((j) => j.threadIds).concat(s.gone, s.hid ?? []))];
}

/**
 * Threads leaving the folder itself: deletes only (2026-09-15). A hide keeps
 * the thread in Inbox and Messages, so those plain lists read this, and the
 * four sorting lists read `leavingThreadIds`.
 */
export function deletingThreadIds(s: SendState): string[] {
  return [...new Set([...s.trash, ...s.trashInFlight].filter((j) => !j.hide).flatMap((j) => j.threadIds).concat(s.gone))];
}

/**
 * How many texts a card's Undo can walk back through (spec 8, 2026-09-10).
 * Ten is generous for one sitting and keeps a long conversation with
 * Celeste from growing without end.
 */
export const REVISION_UNDO_LIMIT = 10;

/**
 * The text a rewrite replaced, remembered so Undo on the draft's line can put it
 * back. Pure and outside React so the cap is testable: the stack lives on
 * the open card and dies with it, since the draft the operator sends is
 * whatever text is on the card when they send it.
 */
export function pushRevision(stack: string[], text: string): string[] {
  return [...stack, text].slice(-REVISION_UNDO_LIMIT);
}

export function popRevision(stack: string[]): { text: string | undefined; stack: string[] } {
  if (stack.length === 0) return { text: undefined, stack: [] };
  return { text: stack[stack.length - 1], stack: stack.slice(0, -1) };
}

/**
 * One row of the Drafts list, and the address of one draft (spec 10a). The
 * list keeps the order `listPendingDrafts` returns, oldest first, so the
 * operator works down it; which draft is open rides in `?draft=` rather than
 * in the order, and the selected inbox comes along so the list beside the
 * card stays the one that was clicked out of. No id at all is the folder
 * itself, which is the phone's list view and the back link's target.
 */
export function draftHref(draftId: string | null | undefined, account?: string | undefined): string {
  const params = new URLSearchParams();
  if (draftId) params.set("draft", draftId);
  if (account) params.set("account", account);
  const query = params.toString();
  return query ? `/drafts?${query}` : "/drafts";
}
