import { describe, it, expect } from "vitest";
import {
  afterSend,
  queueReducer,
  sendReducer,
  dueSends,
  draftHref,
  leavingDraftIds,
  popRevision,
  pushRevision,
  sendsOnLeaving,
  sentToastLabel,
  sendDelayFor,
  keptToastLabel,
  hiddenToastLabel,
  progressFraction,
  progressLabel,
  trashChunkSize,
  SEND_DELAY_MS,
  dueTrash,
  leavingThreadIds,
  deletingThreadIds,
  threadCountLabel,
  restoredToastLabel,
  handledThreadIds,
  trashedToastLabel,
  trashJob,
  undoTarget,
  trashOnLeaving,
  SENT_TOAST_MS,
  REVISION_UNDO_LIMIT,
  type QueueState,
  type SendState,
} from "../lib/queue";
import { neighbourThread } from "../lib/threads";
import type { DraftView } from "@messaging-agent/core";
import type { PendingSend } from "../lib/queue";

const item = (id: string) => ({ draft: { id } } as unknown as DraftView);
const base = (): QueueState => ({ items: [item("d1"), item("d2")], errors: {}, edits: {} });
const send = (draftId: string, endsAt: number): PendingSend => ({ draftId, finalText: "t", to: ["a@x"], cc: [], endsAt, item: item(draftId) });

describe("queueReducer", () => {
  it("confirm_send takes the card out of the list: the gate above the page has it now", () => {
    const s = queueReducer(base(), { type: "confirm_send", draftId: "d1", finalText: "t", to: ["a@x"], cc: [] });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d2"]);
    expect(s.gone).toEqual(["d1"]);
  });

  it("confirm_send records the edited text and recipients so a card that comes back keeps them", () => {
    const s = queueReducer(base(), { type: "confirm_send", draftId: "d1", finalText: "t2", to: ["a@x"], cc: [] });
    expect(s.edits.d1).toEqual({ text: "t2", to: ["a@x"], cc: [] });
  });

  it("returned puts the card back at the front", () => {
    let s = queueReducer(base(), { type: "confirm_send", draftId: "d1", finalText: "t", to: ["a@x"], cc: [] });
    s = queueReducer(s, { type: "returned", item: item("d1") });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d1", "d2"]);
    expect(s.gone).toEqual([]);
  });

  it("returned keeps the recorded edit so the card reopens with the user's text", () => {
    let s = queueReducer(base(), { type: "confirm_send", draftId: "d1", finalText: "t2", to: ["a@x"], cc: [] });
    s = queueReducer(s, { type: "returned", item: item("d1") });
    expect(s.edits.d1).toEqual({ text: "t2", to: ["a@x"], cc: [] });
  });

  it("returned never shows the same card twice", () => {
    const s = queueReducer(base(), { type: "returned", item: item("d1") });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d1", "d2"]);
  });

  it("send_failed puts the card back at the front with an error", () => {
    let s = queueReducer(base(), { type: "confirm_send", draftId: "d1", finalText: "t", to: ["a@x"], cc: [] });
    s = queueReducer(s, { type: "send_failed", draftId: "d1", message: "quota", item: item("d1") });
    expect(s.items[0]?.draft.id).toBe("d1");
    expect(s.errors.d1).toBe("quota");
    expect(s.gone).toEqual([]);
  });

  it("send_failed keeps the recorded edit so the card reopens with the user's text", () => {
    let s = queueReducer(base(), { type: "confirm_send", draftId: "d1", finalText: "t2", to: ["a@x"], cc: [] });
    s = queueReducer(s, { type: "send_failed", draftId: "d1", message: "quota", item: item("d1") });
    expect(s.edits.d1).toEqual({ text: "t2", to: ["a@x"], cc: [] });
  });

  it("skipped removes the card", () => {
    const s = queueReducer(base(), { type: "skipped", draftId: "d1" });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d2"]);
  });
});

/**
 * The send gate outlives the page the card was read on (spec 8, 2026-09-10).
 * The operator pressed Send and walked off to another thread, and the mail
 * still has to go.
 */
describe("sendReducer", () => {
  const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };

  it("holds a confirmed send until its six seconds are up", () => {
    const s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    expect(dueSends(s, 6999)).toEqual([]);
    expect(dueSends(s, 7000).map((p) => p.draftId)).toEqual(["d1"]);
  });

  it("lets go once the send is on its way, so it can never go twice", () => {
    let s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    s = sendReducer(s, { type: "dispatched", draftId: "d1" });
    expect(s.pending).toEqual([]);
  });

  it("drops a send the operator undid, and never dispatches it", () => {
    let s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    s = sendReducer(s, { type: "undone", draftId: "d1" });
    expect(dueSends(s, 999999)).toEqual([]);
  });

  it("keeps several sends counting at once, and answers for each", () => {
    let s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    s = sendReducer(s, { type: "queued", send: send("d2", 9000) });
    expect(dueSends(s, 8000).map((p) => p.draftId)).toEqual(["d1"]);
  });

  it("holds one entry per draft, however often the gate is passed", () => {
    let s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    s = sendReducer(s, { type: "queued", send: send("d1", 9000) });
    expect(s.pending).toHaveLength(1);
    expect(s.pending[0]?.endsAt).toBe(9000);
  });

  it("passes over a send already on its way", () => {
    const s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    expect(dueSends(s, 8000, ["d1"])).toEqual([]);
  });
});

/**
 * The page itself is going: the tab is closing, or the browser is leaving.
 * The window is forfeited by leaving, because the operator pressed Send and a
 * window nobody is watching is not a window.
 */
describe("what happens to a send when the page goes", () => {
  const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };

  it("fires everything still counting, however long it had left", () => {
    let s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    s = sendReducer(s, { type: "queued", send: send("d2", 999999) });
    expect(sendsOnLeaving(s).map((p) => p.draftId)).toEqual(["d1", "d2"]);
  });

  it("leaves alone what is already on its way, or the same mail goes twice", () => {
    let s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    s = sendReducer(s, { type: "queued", send: send("d2", 9000) });
    expect(sendsOnLeaving(s, ["d1"]).map((p) => p.draftId)).toEqual(["d2"]);
  });

  it("has nothing to fire when nothing was confirmed", () => {
    expect(sendsOnLeaving(empty)).toEqual([]);
  });
});

describe("the drafts no list may show", () => {
  const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };

  it("names what is counting down and what is on its way, once each", () => {
    let s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    s = sendReducer(s, { type: "queued", send: send("d2", 9000) });
    s = sendReducer(s, { type: "dispatched", draftId: "d1" });
    expect(leavingDraftIds(s).sort()).toEqual(["d1", "d2"]);
  });

  /**
   * A send that failed has been answered for, and its card belongs back in
   * front of the operator with the reason on it, not hidden as if it were
   * still on its way.
   */
  it("lets go once the server has answered, so a card whose send failed comes back", () => {
    let s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    s = sendReducer(s, { type: "dispatched", draftId: "d1" });
    expect(leavingDraftIds(s)).toEqual(["d1"]);
    s = sendReducer(s, { type: "settled", draftId: "d1" });
    expect(leavingDraftIds(s)).toEqual([]);
  });

  it("is empty when nothing is going anywhere", () => {
    expect(leavingDraftIds(empty)).toEqual([]);
  });
});

/**
 * The list the server has just rendered, taken again without a reload: a draft
 * Celeste wrote from the Ask panel has to appear under the operator's eyes,
 * and the card they took out must not come back while the database catches up
 * (spec 10a, 2026-09-10).
 */
describe("the server's list arriving again", () => {
  it("adds a draft that was not there before, in the server's order", () => {
    const s = queueReducer(base(), { type: "server_items", items: [item("d1"), item("d2"), item("d3")] });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d1", "d2", "d3"]);
  });

  it("drops a draft the server no longer lists", () => {
    const s = queueReducer(base(), { type: "server_items", items: [item("d2")] });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d2"]);
  });

  it("does not put back a card the gate is holding", () => {
    let s = queueReducer(base(), { type: "confirm_send", draftId: "d1", finalText: "t", to: ["a@x"], cc: [] });
    s = queueReducer(s, { type: "server_items", items: [item("d1"), item("d2")] });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d2"]);
  });

  it("does not put back a card the operator skipped before the skip was written down", () => {
    let s = queueReducer(base(), { type: "skipped", draftId: "d1" });
    s = queueReducer(s, { type: "server_items", items: [item("d1"), item("d2")] });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d2"]);
  });

  it("welcomes back a card that was undone inside the window", () => {
    let s = queueReducer(base(), { type: "confirm_send", draftId: "d1", finalText: "t", to: ["a@x"], cc: [] });
    s = queueReducer(s, { type: "returned", item: item("d1") });
    s = queueReducer(s, { type: "server_items", items: [item("d1"), item("d2")] });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d1", "d2"]);
  });

  it("welcomes back a card whose send failed", () => {
    let s = queueReducer(base(), { type: "confirm_send", draftId: "d1", finalText: "t", to: ["a@x"], cc: [] });
    s = queueReducer(s, { type: "send_failed", draftId: "d1", message: "quota", item: item("d1") });
    s = queueReducer(s, { type: "server_items", items: [item("d1"), item("d2")] });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d1", "d2"]);
    expect(s.errors.d1).toBe("quota");
  });
});

describe("draftHref", () => {
  it("names the open draft", () => {
    expect(draftHref("d1")).toBe("/drafts?draft=d1");
  });

  it("carries the selected inbox so a row click does not widen the list", () => {
    expect(draftHref("d1", "a1")).toBe("/drafts?draft=d1&account=a1");
  });

  it("is the folder itself when no draft is named", () => {
    expect(draftHref(null)).toBe("/drafts");
    expect(draftHref(null, "a1")).toBe("/drafts?account=a1");
  });
});

describe("where the selection goes when a draft leaves the list", () => {
  // Skip and Send take a draft out; the same rule the thread list uses says
  // which draft the operator lands on next (spec 10a).
  const ids = (s: QueueState) => s.items.map((i) => i.draft.id);

  it("moves to the draft below the skipped one", () => {
    const s: QueueState = { items: [item("d1"), item("d2"), item("d3")], errors: {}, edits: {} };
    expect(neighbourThread(ids(s), "d2")).toBe("d3");
  });

  it("moves to the draft above when the one sent was last", () => {
    const s: QueueState = { items: [item("d1"), item("d2")], errors: {}, edits: {} };
    expect(neighbourThread(ids(s), "d2")).toBe("d1");
  });

  it("has nowhere to go when the queue empties, which is the empty state", () => {
    const s: QueueState = { items: [item("d1")], errors: {}, edits: {} };
    expect(neighbourThread(ids(s), "d1")).toBe(null);
  });
});

describe("the revision undo stack", () => {
  it("remembers the text a revision replaced", () => {
    expect(pushRevision([], "first")).toEqual(["first"]);
    expect(pushRevision(["first"], "second")).toEqual(["first", "second"]);
  });

  it("pops the most recent text back off, and says when there is none", () => {
    expect(popRevision(["a", "b"])).toEqual({ text: "b", stack: ["a"] });
    expect(popRevision(["a"])).toEqual({ text: "a", stack: [] });
    expect(popRevision([])).toEqual({ text: undefined, stack: [] });
  });

  it("keeps only the last ten, dropping the oldest", () => {
    let stack: string[] = [];
    for (let i = 1; i <= 12; i++) stack = pushRevision(stack, `v${i}`);
    expect(stack).toHaveLength(REVISION_UNDO_LIMIT);
    expect(stack[0]).toBe("v3");
    expect(stack.at(-1)).toBe("v12");
  });

  it("leaves the stack it was given alone", () => {
    const stack = ["a"];
    pushRevision(stack, "b");
    popRevision(stack);
    expect(stack).toEqual(["a"]);
  });
});

/**
 * The mail has gone, said so (spec 8, 2026-09-10). Operator: the countdown
 * simply disappeared, so a send that worked looked exactly like one that
 * never happened, and they pressed Send again.
 */
describe("saying the mail has gone", () => {
  const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };

  it("names who it went to", () => {
    expect(sentToastLabel({ to: ["jocelyn@example.com"], subject: "" })).toBe("Sent to jocelyn@example.com");
  });

  it("counts the rest of the recipients rather than listing them", () => {
    expect(sentToastLabel({ to: ["a@x.com", "b@x.com", "c@x.com"], subject: "" })).toBe("Sent to a@x.com +2");
  });

  it("carries the subject when the whole line fits", () => {
    expect(sentToastLabel({ to: ["bob@x.io"], subject: "Re: Visa timeline" })).toBe("Sent to bob@x.io · Re: Visa timeline");
  });

  it("drops the subject rather than trailing off, because the recipient matters more", () => {
    const label = sentToastLabel({ to: ["bob@x.io"], subject: "Re: the very long thread about next quarter's budget" });
    expect(label).toBe("Sent to bob@x.io");
  });

  it("still says something when a draft somehow had nobody on it", () => {
    expect(sentToastLabel({ to: [], subject: "Re: hello" })).toBe("Sent · Re: hello");
  });

  it("puts the notice up for its few seconds and takes it down after", () => {
    let s = sendReducer(empty, { type: "sent", draftId: "d1", label: "Sent to a@x", now: 1000 });
    expect(s.sent).toEqual([{ draftId: "d1", label: "Sent to a@x", until: 1000 + SENT_TOAST_MS }]);
    expect(sendReducer(s, { type: "expire", now: 1000 + SENT_TOAST_MS }).sent).toEqual([]);
    s = sendReducer(s, { type: "expire", now: 1000 + SENT_TOAST_MS - 1 });
    expect(s.sent).toHaveLength(1);
  });

  it("leaves the state alone when nothing has expired, so the clock cannot loop", () => {
    const s = sendReducer(empty, { type: "sent", draftId: "d1", label: "Sent to a@x", now: 1000 });
    expect(sendReducer(s, { type: "expire", now: 1200 })).toBe(s);
  });

  it("says it once per draft, however often the server answers", () => {
    let s = sendReducer(empty, { type: "sent", draftId: "d1", label: "Sent to a@x", now: 1000 });
    s = sendReducer(s, { type: "sent", draftId: "d1", label: "Sent to a@x", now: 2000 });
    expect(s.sent).toHaveLength(1);
  });
});

/**
 * A sent reply exists only at the provider until the inbox is pulled again,
 * so the thread goes on sitting under Need to reply (spec 8, 2026-09-10).
 */
describe("what follows a send that worked", () => {
  function spy() {
    const calls: string[] = [];
    const synced: string[] = [];
    return {
      calls,
      synced,
      io: {
        refresh: () => void calls.push("refresh"),
        sync: async (accountId: string) => {
          calls.push("sync");
          synced.push(accountId);
        },
      },
    };
  }

  it("reads the page at once, pulls the inbox, then reads it again", async () => {
    const s = spy();
    await afterSend({ accountId: "a1" }, s.io);
    expect(s.calls).toEqual(["refresh", "sync", "refresh"]);
  });

  it("pulls the inbox the mail went from", async () => {
    const s = spy();
    await afterSend({ accountId: "a1" }, s.io);
    expect(s.synced).toEqual(["a1"]);
  });

  it("still reads the page twice when the sync fails, and does not throw", async () => {
    const calls: string[] = [];
    await expect(
      afterSend(
        { accountId: "a1" },
        {
          refresh: () => void calls.push("refresh"),
          sync: async () => {
            calls.push("sync");
            throw new Error("imap down");
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["refresh", "sync", "refresh"]);
  });

  it("takes the card away before the sync, which is the slow half", async () => {
    const calls: string[] = [];
    let released = () => {};
    const slow = new Promise<void>((r) => {
      released = r;
    });
    const running = afterSend(
      { accountId: "a1" },
      {
        refresh: () => void calls.push("refresh"),
        sync: async () => slow,
      },
    );
    await Promise.resolve();
    expect(calls).toEqual(["refresh"]);
    released();
    await running;
    expect(calls).toEqual(["refresh", "refresh"]);
  });
});

/**
 * Deleting is a gated write, and it goes through the same gate a send does
 * (spec 10a, 2026-09-11): one click, one countdown, one Undo, and nothing
 * moves until the seconds are up.
 */
describe("the delete half of the gate", () => {
  const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };
  const job = (id: string, endsAt: number, threadIds = ["a1:t1"]) => ({ id, threadIds, endsAt });

  it("holds a delete until its six seconds are up", () => {
    const s = sendReducer(empty, { type: "trash_queued", job: job("j1", 7000) });
    expect(dueTrash(s, 6999)).toEqual([]);
    expect(dueTrash(s, 7000).map((j) => j.id)).toEqual(["j1"]);
  });

  it("lets go once it is on its way, so one thread is never deleted twice", () => {
    let s = sendReducer(empty, { type: "trash_queued", job: job("j1", 7000) });
    s = sendReducer(s, { type: "trash_dispatched", id: "j1" });
    expect(s.trash).toEqual([]);
    expect(dueTrash(s, 999999)).toEqual([]);
    // Kept whole while it is out, because its threads must stay off the lists.
    expect(s.trashInFlight.map((j) => j.id)).toEqual(["j1"]);
  });

  it("drops a delete the operator undid, and never dispatches it", () => {
    let s = sendReducer(empty, { type: "trash_queued", job: job("j1", 7000) });
    s = sendReducer(s, { type: "trash_undone", id: "j1" });
    expect(dueTrash(s, 999999)).toEqual([]);
    expect(leavingThreadIds(s)).toEqual([]);
  });

  it("keeps its threads off every list while it counts down and while it is out", () => {
    let s = sendReducer(empty, { type: "trash_queued", job: job("j1", 7000, ["a1:t1", "a1:t2"]) });
    expect(leavingThreadIds(s).sort()).toEqual(["a1:t1", "a1:t2"]);
    s = sendReducer(s, { type: "trash_dispatched", id: "j1" });
    expect(leavingThreadIds(s).sort()).toEqual(["a1:t1", "a1:t2"]);
    // The server has answered: the rows are the server's business now.
    s = sendReducer(s, { type: "trash_settled", id: "j1" });
    expect(leavingThreadIds(s)).toEqual([]);
  });

  it("counts two deletes at once without either taking the other's threads", () => {
    let s = sendReducer(empty, { type: "trash_queued", job: job("j1", 7000, ["a1:t1"]) });
    s = sendReducer(s, { type: "trash_queued", job: job("j2", 9000, ["a1:t2"]) });
    expect(dueTrash(s, 7000).map((j) => j.id)).toEqual(["j1"]);
    s = sendReducer(s, { type: "trash_undone", id: "j1" });
    expect(leavingThreadIds(s)).toEqual(["a1:t2"]);
  });

  it("goes now when the page itself is going, as a send does", () => {
    const s = sendReducer(empty, { type: "trash_queued", job: job("j1", 999999) });
    expect(trashOnLeaving(s).map((j) => j.id)).toEqual(["j1"]);
    expect(trashOnLeaving(s, ["j1"])).toEqual([]);
  });

  it("says the mail has gone, and takes the notice down on the same clock as a send's", () => {
    let s = sendReducer(empty, { type: "trashed", id: "j1", label: "Deleted 2 threads", now: 1000 });
    expect(s.trashed.map((n) => n.label)).toEqual(["Deleted 2 threads"]);
    s = sendReducer(s, { type: "expire", now: 1000 + SENT_TOAST_MS - 1 });
    expect(s.trashed).toHaveLength(1);
    s = sendReducer(s, { type: "expire", now: 1000 + SENT_TOAST_MS });
    expect(s.trashed).toEqual([]);
  });

  it("leaves the sends alone, both ways", () => {
    let s = sendReducer(empty, { type: "queued", send: send("d1", 7000) });
    s = sendReducer(s, { type: "trash_queued", job: job("j1", 7000) });
    expect(dueSends(s, 7000).map((p) => p.draftId)).toEqual(["d1"]);
    expect(leavingDraftIds(s)).toEqual(["d1"]);
    s = sendReducer(s, { type: "trash_undone", id: "j1" });
    expect(dueSends(s, 7000).map((p) => p.draftId)).toEqual(["d1"]);
  });
});

describe("what a delete says", () => {
  it("counts in threads, because a conversation is what goes", () => {
    expect(threadCountLabel(1)).toBe("1 thread");
    expect(threadCountLabel(23)).toBe("23 threads");
  });

  it("says the thirty days out loud, since by then the Undo is gone", () => {
    expect(trashedToastLabel(["a1:t1"])).toBe("Deleted 1 thread · in Trash for 30 days");
    expect(trashedToastLabel(["a1:t1", "a1:t2"])).toBe("Deleted 2 threads · in Trash for 30 days");
  });
});

describe("trashJob", () => {
  // Operator, 2026-09-11: "just delete instantly". No countdown stands in
  // front of a delete, so the job is due the moment it is queued.
  it("is due at once, with each thread once", () => {
    const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };
    const job = trashJob(["a1:t1", "a1:t2", "a1:t1"], 5000, "j1");
    expect(job).toEqual({ id: "j1", threadIds: ["a1:t1", "a1:t2"], endsAt: 5000 });
    const s = sendReducer(empty, { type: "trash_queued", job });
    expect(dueTrash(s, 5000).map((j) => j.id)).toEqual(["j1"]);
  });

  it("makes up an id of its own when none is given", () => {
    expect(trashJob(["a1:t1"], 1).id).toMatch(/^trash-1-/);
  });

  it("carries the wish for an Undo toast only when asked, for a delete made by touch", () => {
    expect(trashJob(["a1:t1"], 1, "j1").undo).toBeUndefined();
    expect(trashJob(["a1:t1"], 1, "j1", true)).toMatchObject({ undo: true });
  });
});

describe("trash_done", () => {
  // Operator, 2026-09-11: after a delete the row and the pane came back for
  // a moment, between the server's answer and the page's next read.
  it("keeps a thread off the lists once it is in Trash, after the job has settled", () => {
    const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };
    let s = sendReducer(empty, { type: "trash_queued", job: trashJob(["a1:t1"], 1, "j1") });
    s = sendReducer(s, { type: "trash_dispatched", id: "j1" });
    s = sendReducer(s, { type: "trash_settled", id: "j1" });
    expect(leavingThreadIds(s)).toEqual([]);
    s = sendReducer(s, { type: "trash_done", job: trashJob(["a1:t1"], 1, "j1") });
    expect(leavingThreadIds(s)).toEqual(["a1:t1"]);
    s = sendReducer(s, { type: "trash_done", job: trashJob(["a1:t1", "a1:t2"], 2, "j2") });
    expect(leavingThreadIds(s).sort()).toEqual(["a1:t1", "a1:t2"]);
  });
});

describe("undo delete", () => {
  // Operator, 2026-09-11: "press Command-Z to bring back the previously
  // deleted email".
  const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };

  it("takes back the last delete done, then the one before it", () => {
    let s = sendReducer(empty, { type: "trash_done", job: trashJob(["a1:t1"], 1, "j1") });
    s = sendReducer(s, { type: "trash_done", job: trashJob(["a1:t2", "a1:t3"], 2, "j2") });
    expect(undoTarget(s)?.id).toBe("j2");
    expect(undoTarget(s, "j1")?.id).toBe("j1");
    s = sendReducer(s, { type: "undo_started", job: trashJob(["a1:t2", "a1:t3"], 2, "j2") });
    expect(undoTarget(s)?.id).toBe("j1");
    expect(s.restoring).toEqual(["j2"]);
    s = sendReducer(s, { type: "undo_done", id: "j2", threadIds: ["a1:t2", "a1:t3"] });
    expect(leavingThreadIds(s)).toEqual(["a1:t1"]);
    expect(s.restoring).toEqual([]);
    expect(undoTarget(sendReducer(s, { type: "undo_started", job: trashJob(["a1:t1"], 1, "j1") }))).toBeNull();
  });

  it("puts a delete the server would not take back onto the stack again", () => {
    let s = sendReducer(empty, { type: "trash_done", job: trashJob(["a1:t1"], 1, "j1") });
    s = sendReducer(s, { type: "undo_started", job: trashJob(["a1:t1"], 1, "j1") });
    expect(leavingThreadIds(s)).toEqual([]);
    s = sendReducer(s, { type: "undo_failed", job: trashJob(["a1:t1"], 1, "j1") });
    expect(undoTarget(s)?.id).toBe("j1");
    expect(leavingThreadIds(s)).toEqual(["a1:t1"]);
  });

  it("says the mail is back, for a few seconds", () => {
    let s = sendReducer(empty, { type: "notice", id: "undo-j1", label: restoredToastLabel(["a1:t1"]), now: 1000 });
    expect(s.trashed.map((n) => n.label)).toEqual(["Restored 1 thread · back where it was"]);
    s = sendReducer(s, { type: "expire", now: 1000 + SENT_TOAST_MS });
    expect(s.trashed).toEqual([]);
  });

  it("adds a second restore to the first toast instead of stacking another", () => {
    // Stress audit, 2026-09-11: two Cmd-Z in a row showed two identical toasts.
    let s = sendReducer(empty, { type: "notice", id: "undo-j1", label: restoredToastLabel(["a1:t1"]), now: 1000, tally: { key: "restored", count: 1 } });
    s = sendReducer(s, { type: "notice", id: "undo-j2", label: restoredToastLabel(["a1:t2", "a1:t3"]), now: 1200, tally: { key: "restored", count: 2 } });
    expect(s.trashed.map((n) => [n.id, n.label])).toEqual([["undo-j2", "Restored 3 threads · back where it was"]]);
    // A notice without a tally never merges, and never absorbs one.
    s = sendReducer(s, { type: "notice", id: "plain", label: "Marked 4 opened", now: 1300 });
    expect(s.trashed.map((n) => n.id)).toEqual(["undo-j2", "plain"]);
  });
});

describe("undo is instant", () => {
  // Operator, 2026-09-11: "make the cmd z animation too, and make it instant".
  it("shows the threads again the moment Cmd-Z is pressed, sliding in until the return settles", () => {
    const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };
    let s = sendReducer(empty, { type: "trash_done", job: trashJob(["a1:t1"], 1, "j1") });
    expect(leavingThreadIds(s)).toEqual(["a1:t1"]);
    s = sendReducer(s, { type: "undo_started", job: trashJob(["a1:t1"], 1, "j1") });
    expect(leavingThreadIds(s)).toEqual([]);
    expect(s.returning).toEqual(["a1:t1"]);
    s = sendReducer(s, { type: "undo_done", id: "j1", threadIds: ["a1:t1"] });
    expect(s.returning).toEqual(["a1:t1"]);
    s = sendReducer(s, { type: "returned", threadIds: ["a1:t1"] });
    expect(s.returning).toEqual([]);
  });
});

describe("mark handled through the gate", () => {
  // Operator, 2026-09-11: Shift marks the mail handled, snappy, like Delete.
  const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };
  it("keeps the thread off the Need-to-reply list from the press until the server has it", () => {
    let s = sendReducer(empty, { type: "handle_started", threadId: "a1:t1" });
    expect(s.handling).toEqual(["a1:t1"]);
    expect(handledThreadIds(s)).toEqual(["a1:t1"]);
    s = sendReducer(s, { type: "handle_done", threadId: "a1:t1" });
    expect(s.handling).toEqual([]);
    expect(handledThreadIds(s)).toEqual(["a1:t1"]);
  });
  it("puts the thread back when the server refuses", () => {
    let s = sendReducer(empty, { type: "handle_started", threadId: "a1:t1" });
    s = sendReducer(s, { type: "handle_failed", threadId: "a1:t1" });
    expect(handledThreadIds(s)).toEqual([]);
  });
});

describe("deletes in a row share one toast", () => {
  // Operator, 2026-09-11: three stacked "Deleted 1 thread" toasts on the phone.
  const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };
  it("counts up and keeps every job for one Undo", () => {
    let s = sendReducer(empty, { type: "trashed", id: "j1", label: "Deleted 1 thread · in Trash for 30 days", now: 1000, undoJobId: "j1", tally: { key: "trashed", count: 1 } });
    s = sendReducer(s, { type: "trashed", id: "j2", label: "Deleted 1 thread · in Trash for 30 days", now: 1100, undoJobId: "j2", tally: { key: "trashed", count: 1 } });
    s = sendReducer(s, { type: "trashed", id: "j3", label: "Deleted 2 threads · in Trash for 30 days", now: 1200, undoJobId: "j3", tally: { key: "trashed", count: 2 } });
    expect(s.trashed).toHaveLength(1);
    expect(s.trashed[0]?.label).toBe("Deleted 4 threads · in Trash for 30 days");
    expect(s.trashed[0]?.id).toBe("j3");
    expect(s.trashed[0]?.undoJobIds).toEqual(["j1", "j2", "j3"]);
  });
  it("does not fold a failure into the count", () => {
    let s = sendReducer(empty, { type: "trashed", id: "j1", label: "Deleted 1 thread · in Trash for 30 days", now: 1000, undoJobId: "j1", tally: { key: "trashed", count: 1 } });
    s = sendReducer(s, { type: "trashed", id: "j2", label: "Could not delete: offline", now: 1100 });
    expect(s.trashed.map((n) => n.label)).toEqual(["Deleted 1 thread · in Trash for 30 days", "Could not delete: offline"]);
  });
});

describe("sendDelayFor", () => {
  it("holds mail for six seconds and sends a text at once", () => {
    expect(sendDelayFor({ account: { provider: "imap" } })).toBe(SEND_DELAY_MS);
    expect(sendDelayFor({ account: { provider: "outlook" } })).toBe(SEND_DELAY_MS);
    expect(sendDelayFor({ account: { provider: "imessage" } })).toBe(0);
  });
});

describe("keptToastLabel", () => {
  it("says what the provider would not let go", () => {
    expect(keptToastLabel(2, true)).toBe("Could not delete 2 chats · Messages kept them");
    expect(keptToastLabel(1, true)).toBe("Could not delete 1 chat · Messages kept it");
    expect(keptToastLabel(1)).toBe("Could not delete 1 thread · the provider kept it");
  });
});

describe("hide", () => {
  it("is a trash job marked hide, and says so once done", () => {
    expect(trashJob(["a1:t1"], 1, "j1", true, true)).toEqual({ id: "j1", threadIds: ["a1:t1"], endsAt: 1, undo: true, hide: true });
    expect(trashJob(["a1:t1"], 1, "j1").hide).toBeUndefined();
    expect(hiddenToastLabel(["a1:t1"])).toBe("Hid 1 thread · still in Inbox");
    expect(hiddenToastLabel(["a", "b"])).toBe("Hid 2 threads · still in Inbox");
    expect(hiddenToastLabel(["acc:any;-;+1", "acc:1@s.whatsapp.net"])).toBe("Hid 2 chats · still in Messages");
  });
});

describe("a delete of many says how far it has got", () => {
  it("keeps the count on the job in flight, and words it for mail or chats", () => {
    const blank: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };
    let s = sendReducer(blank, { type: "trash_queued", job: trashJob(["a:t1", "a:t2", "a:t3"], 1, "j1") });
    s = sendReducer(s, { type: "trash_dispatched", id: "j1" });
    s = sendReducer(s, { type: "trash_progress", id: "j1", done: 2, total: 3 });
    expect(s.trashInFlight[0]?.progress).toEqual({ done: 2, total: 3 });
    expect(progressLabel(s.trashInFlight[0]!)).toBe("Deleting 2 of 3 threads…");
    const chats = { ...trashJob(["acc:any;-;+1", "acc:1@s.whatsapp.net"], 1, "j2", false, true), progress: { done: 1, total: 2 } };
    expect(progressLabel(chats)).toBe("Hiding 1 of 2 chats…");
    expect(trashChunkSize(["acc:any;-;+1"])).toBe(2);
    expect(trashChunkSize(["a:t1"])).toBe(10);
  });

  /**
   * The bar was dead for the whole of the commonest delete. Mail goes ten at
   * a time, so five threads is one round trip, and the only two states were
   * nothing and gone (operator, 2026-09-18: "the progression is not
   * displaying"). Nothing done is now said as "under way", not as zero.
   */
  it("says under way before the first chunk, rather than nought of five", () => {
    const fresh = trashJob(["a:t1", "a:t2", "a:t3", "a:t4", "a:t5"], 1, "j3");
    expect(progressLabel(fresh)).toBe("Deleting 5 threads…");
    expect(progressFraction(fresh)).toBeNull();

    const started = { ...fresh, progress: { done: 0, total: 5 } };
    expect(progressLabel(started)).toBe("Deleting 5 threads…");
    expect(progressFraction(started)).toBeNull();

    const part = { ...fresh, progress: { done: 2, total: 5 } };
    expect(progressLabel(part)).toBe("Deleting 2 of 5 threads…");
    expect(progressFraction(part)).toBeCloseTo(0.4);

    const chatsFresh = trashJob(["acc:any;-;+1", "acc:1@s.whatsapp.net", "acc:2@s.whatsapp.net"], 1, "j4", false, true);
    expect(progressLabel(chatsFresh)).toBe("Hiding 3 chats…");

    // A job that somehow overruns its own total still fills the bar, never past it.
    expect(progressFraction({ ...fresh, progress: { done: 9, total: 5 } })).toBe(1);
  });
});

/** A deleted draft's Undo brings back what was typed into it (2026-09-14). */
describe("queueReducer: a deleted draft returns with its edit", () => {
  it("restores the card and the operator's words", () => {
    const item = { draft: { id: "d1" } } as unknown as Parameters<typeof queueReducer>[0]["items"][number];
    let s = queueReducer({ items: [item], errors: {}, edits: {}, gone: [] }, { type: "skipped", draftId: "d1" });
    expect(s.items).toEqual([]);
    s = queueReducer(s, { type: "returned", item, edit: { text: "my words", to: ["a@x.com"], cc: [] } });
    expect(s.items.map((i) => i.draft.id)).toEqual(["d1"]);
    expect(s.edits.d1).toEqual({ text: "my words", to: ["a@x.com"], cc: [] });
    expect(s.gone).toEqual([]);
  });
});

/** A hide leaves the sorting lists, not Inbox or Messages (2026-09-15). */
describe("hidden threads stay in the folder", () => {
  const empty: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };
  it("a hide is leaving the sorting lists and not deleting; a delete is both", () => {
    const hideJob = trashJob(["a1:hidden"], 1, "h1", true, true);
    const delJob = trashJob(["a1:deleted"], 1, "d1");
    let s = sendReducer(empty, { type: "trash_done", job: hideJob });
    s = sendReducer(s, { type: "trash_done", job: delJob });
    expect(leavingThreadIds(s).sort()).toEqual(["a1:deleted", "a1:hidden"]);
    expect(deletingThreadIds(s)).toEqual(["a1:deleted"]);
    // Undo of the hide lets it back onto the sorting lists.
    s = sendReducer(s, { type: "undo_started", job: hideJob });
    expect(leavingThreadIds(s)).toEqual(["a1:deleted"]);
  });
});
