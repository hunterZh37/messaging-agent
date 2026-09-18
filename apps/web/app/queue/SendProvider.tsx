"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  afterSend,
  dueSends,
  dueTrash,
  leavingDraftIds,
  leavingThreadIds,
  deletingThreadIds,
  sendReducer,
  sendsOnLeaving,
  sentToastLabel,
  restoredToastLabel,
  handledThreadIds,
  trashedToastLabel,
  trashJob,
  undoTarget,
  trashOnLeaving,
  type PendingSend,
  type PendingTrash,
  type SendState, keptToastLabel, hiddenToastLabel, trashChunkSize } from "@/lib/queue";
import { sendAction } from "../actions";
import { hideThreadsAction, markHandledAction, restoreThreadsAction, trashThreadsAction } from "../inbox/actions";
import { isUndoKey } from "@/lib/keys";
import { threadPath } from "@/lib/folders";
import { syncStep } from "../inboxes/actions";
import { SendToasts } from "./SendToasts";

/** What the card that confirmed a send wants to hear about afterwards. */
export interface SendHandlers {
  /** Undo inside the window: nothing was sent, so the card belongs back. */
  onReturn?: (send: PendingSend) => void;
  /** The send itself failed: the card is back with the reason on it. */
  onFailed?: (send: PendingSend, message: string) => void;
}

interface SendGate {
  /** Drafts on their way out — counting down or in flight — which no list may show. */
  leaving: string[];
  /** Threads on their way to Trash, which no list may show either (spec 10a, 2026-09-11). */
  leavingThreads: string[];
  /** Deletes only: what leaves Inbox and Messages themselves; a hide does not (2026-09-15). */
  deletingThreads: string[];
  /** The gate has been passed. The six seconds start here. */
  send: (p: PendingSend, handlers?: SendHandlers) => void;
  undo: (draftId: string) => void;
  /**
   * Delete these threads through the same gate a send goes through, at once:
   * nothing is destroyed, the mail waits thirty days in the provider's Trash
   * (operator, 2026-09-11: no countdown). Returns the job's id. `undo` asks
   * for an Undo toast once it is done: a delete made by touch has no Cmd-Z.
   */
  trash: (threadIds: string[], opts?: { undo?: boolean; hide?: boolean }) => string;
  /**
   * Brings the last delete back out of Trash, or the one named (operator,
   * 2026-09-11: Cmd-Z). Nothing happens when there is nothing to take back.
   */
  undoDelete: (jobId?: string) => void;
  /** The delete jobs Cmd-Z can still take back, oldest first. */
  undoable: string[];
  /** Threads sliding back on screen after Cmd-Z. */
  returningThreads: string[];
  /**
   * Say something in the app's own toasts, with an Undo when there is one
   * (stress audit, 2026-09-11: a page's own toast vanished when the action
   * it announced re-rendered the page around it). The Undo runs once.
   */
  say: (label: string, opts?: { undo?: () => void | Promise<void> }) => void;
  /**
   * Mark the thread's latest inbound message handled, at once: the thread
   * sweeps off as the server is told (operator, 2026-09-11: Shift, "snappy,
   * with a satisfying animation, the same as Delete").
   */
  markHandled: (messageId: string, threadId: string) => void;
  /** Threads handled this session, or on their way to it: off the Need-to-reply list. */
  handledThreads: string[];
}

const GateContext = createContext<SendGate>({
  leaving: [],
  leavingThreads: [],
  deletingThreads: [],
  markHandled: () => {},
  handledThreads: [],
  send: () => {},
  undo: () => {},
  trash: () => "",
  undoDelete: () => {},
  undoable: [],
  returningThreads: [],
  say: () => {},
});

export function useSendGate(): SendGate {
  return useContext(GateContext);
}

const EMPTY: SendState = { pending: [], inFlight: [], sent: [], trash: [], trashInFlight: [], trashed: [], gone: [], done: [], restoring: [], returning: [], handling: [], handled: [] };

/**
 * The send gate, above every page (spec 8, 2026-09-10). It used to live in
 * whichever card the operator was reading, and leaving that page inside the
 * six seconds killed the timer with it: the operator pressed Send on a draft,
 * moved on, and nothing went. So the countdown, the Undo and the toast that
 * says the mail has gone all sit here, under the shell and above the routes,
 * and go on counting while the operator reads something else.
 *
 * A card only hands a send over and asks to hear how it went. If the page that
 * handed it over is gone by then, nobody is listening and nothing needs to be:
 * the server is the truth about that draft, and the next render reads it.
 */
export function SendProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sendReducer, EMPTY);
  const [now, setNow] = useState(() => Date.now());
  const router = useRouter();
  // Sends already on their way to the server, as a guard rather than as what
  // renders: the effect below and the page-leaving handler both read this in
  // the same tick they write it, and one mail must never go twice. What
  // renders is `state.inFlight`, which settles when the server answers.
  const inFlight = useRef<string[]>([]);
  const handlers = useRef(new Map<string, SendHandlers>());
  // Inboxes already being pulled after a send. Two drafts to the same person
  // finishing together should not be two syncs of the same mailbox.
  const syncing = useRef<string[]>([]);
  // The same guard the sends keep, for deletes: the clock effect and the
  // page-leaving handler both read this in the tick they write it, and one
  // thread must never be moved to Trash twice.
  const trashInFlight = useRef<string[]>([]);
  // What the effects read after an await, without being re-run by it.
  const latest = useRef(state);
  latest.current = state;

  // Something to count: a window still running, or a notice still up.
  const busy = state.pending.length > 0 || state.sent.length > 0 || state.trash.length > 0 || state.trashed.length > 0;

  // The clock only runs while something is counting down. This provider is
  // mounted for the whole session, and a tick every 200ms for a mailbox
  // nobody is sending from would be work for nothing.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [busy]);

  const dispatchSend = useCallback(
    (p: PendingSend) => {
      inFlight.current = [...inFlight.current, p.draftId];
      dispatch({ type: "dispatched", draftId: p.draftId });
      void sendAction({ draftId: p.draftId, finalText: p.finalText, to: p.to, cc: p.cc }).then((r) => {
        inFlight.current = inFlight.current.filter((id) => id !== p.draftId);
        dispatch({ type: "settled", draftId: p.draftId });
        const said = handlers.current.get(p.draftId);
        handlers.current.delete(p.draftId);
        if (r.ok) {
          // Said plainly, because a countdown that simply vanishes reads as a
          // send that never happened (operator, 2026-09-10).
          dispatch({ type: "sent", draftId: p.draftId, label: sentToastLabel({ to: p.to, subject: p.item.replySubject }), now: Date.now() });
          const accountId = p.item.account.id;
          void afterSend(
            { accountId },
            {
              refresh: () => router.refresh(),
              sync: async (id) => {
                if (syncing.current.includes(id)) return;
                syncing.current = [...syncing.current, id];
                try {
                  await syncStep(id);
                } finally {
                  syncing.current = syncing.current.filter((x) => x !== id);
                }
              },
            },
          );
          return;
        }
        said?.onFailed?.(p, r.error);
      });
    },
    [router],
  );

  /**
   * A delete, which is due as soon as it is queued. The rows stay off every list until the
   * server answers — `trashInFlight` holds the whole job for exactly that —
   * and then the page is read again, which is when Deleted items gains them.
   */
  const dispatchTrash = useCallback(
    (job: PendingTrash) => {
      trashInFlight.current = [...trashInFlight.current, job.id];
      dispatch({ type: "trash_dispatched", id: job.id });
      // In chunks, so a delete of many says how far it has got (operator,
      // 2026-09-13): the results are added up into one answer.
      const act = job.hide ? hideThreadsAction : trashThreadsAction;
      const run = async () => {
        const total = job.threadIds.length;
        const size = trashChunkSize(job.threadIds);
        const sum = { moved: 0, failed: 0, kept: [] as string[] };
        dispatch({ type: "trash_progress", id: job.id, done: 0, total });
        for (let i = 0; i < total; i += size) {
          const r = await act(job.threadIds.slice(i, i + size));
          if ("error" in r) return r;
          sum.moved += r.moved;
          sum.failed += r.failed;
          sum.kept.push(...r.kept);
          dispatch({ type: "trash_progress", id: job.id, done: Math.min(i + size, total), total });
        }
        return sum;
      };
      void run().then((r) => {
        trashInFlight.current = trashInFlight.current.filter((id) => id !== job.id);
        dispatch({ type: "trash_settled", id: job.id });
        // A delete that worked says nothing (operator, 2026-09-11: the
        // "Deleted 1 thread" toasts piling up were not wanted); the row is
        // gone and Cmd-Z is the way back. One that failed has to say so, or
        // it reads exactly like one that worked.
        if ("error" in r) dispatch({ type: "trashed", id: job.id, label: `Could not ${job.hide ? "hide" : "delete"}: ${r.error}`, now: Date.now() });
        else {
          // What the provider kept comes back on screen, and is said
          // (2026-09-11: two chats Messages.app would not delete sat hidden
          // under a "Delete all · 2" that had nothing to show).
          const kept = r.kept ?? [];
          if (kept.length > 0) {
            job = { ...job, threadIds: job.threadIds.filter((id) => !kept.includes(id)) };
            dispatch({ type: "trashed", id: `${job.id}-kept`, label: keptToastLabel(kept.length, kept.some((id) => id.includes(";-;"))), now: Date.now() });
          }
          dispatch({ type: "trash_done", job });
          // By touch there is no Cmd-Z, so the toast carries the way back.
          if (job.undo)
            dispatch({
              type: "trashed",
              id: job.id,
              label: job.hide ? hiddenToastLabel(job.threadIds) : trashedToastLabel(job.threadIds),
              now: Date.now(),
              undoJobId: job.id,
              tally: { key: job.hide ? "hidden" : "trashed", count: job.threadIds.length },
            });
        }
        router.refresh();
      });
    },
    [router],
  );

  useEffect(() => {
    for (const p of dueSends(state, now, inFlight.current)) dispatchSend(p);
    for (const job of dueTrash(state, now, trashInFlight.current)) dispatchTrash(job);
  }, [now, state, dispatchSend, dispatchTrash]);

  // Notices come down on the same clock. Only when one is actually over, or
  // this would dispatch into its own next render for ever.
  useEffect(() => {
    if ([...state.sent, ...state.trashed].some((n) => n.until <= now)) dispatch({ type: "expire", now });
  }, [now, state.sent, state.trashed]);

  /**
   * The tab is closing, or the browser is leaving for somewhere that is not
   * this app. Everything still counting goes now: the operator pressed Send,
   * and a window nobody can watch is not a window. Best effort — a request
   * started here can still be cut off by the browser — but far better than
   * the certainty of nothing going at all.
   */
  useEffect(() => {
    function flush() {
      for (const p of sendsOnLeaving(latest.current, inFlight.current)) dispatchSend(p);
      for (const job of trashOnLeaving(latest.current, trashInFlight.current)) dispatchTrash(job);
    }
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [dispatchSend, dispatchTrash]);

  const send = useCallback((p: PendingSend, said: SendHandlers = {}) => {
    handlers.current.set(p.draftId, said);
    dispatch({ type: "queued", send: p });
    setNow(Date.now());
  }, []);

  const undo = useCallback(
    (draftId: string) => {
      const p = latest.current.pending.find((x) => x.draftId === draftId);
      dispatch({ type: "undone", draftId });
      const said = handlers.current.get(draftId);
      handlers.current.delete(draftId);
      if (p) said?.onReturn?.(p);
      // The draft never stopped being pending in the database, so the page the
      // operator is on now — whichever it is — can show it again.
      router.refresh();
    },
    [router],
  );

  // Due the moment it is queued: the next tick of the clock effect below
  // dispatches it (operator, 2026-09-11: no countdown, no "in 6s").
  const trash = useCallback((threadIds: string[], opts: { undo?: boolean; hide?: boolean } = {}) => {
    const now = Date.now();
    const job = trashJob(threadIds, now, undefined, opts.undo ?? false, opts.hide ?? false);
    dispatch({ type: "trash_queued", job });
    setNow(now);
    return job.id;
  }, []);

  /**
   * Cmd-Z: the last delete comes back out of Trash (operator, 2026-09-11).
   * It is instant on screen (operator, 2026-09-11: "make it instant"): the
   * threads show again and a single one is opened, sliding in, the moment
   * the key is pressed, while the server moves the mail behind it. The job
   * leaves the stack meanwhile, and goes back on it if the server refuses,
   * when the threads go again and the reason is said. The slide-in stays
   * armed until the page has read the row back, so the row slides in too.
   */
  const undoDelete = useCallback(
    (jobId?: string, opts: { open?: boolean } = {}) => {
      const job = undoTarget(latest.current, jobId);
      if (!job) return;
      dispatch({ type: "undo_started", job });
      setNow(Date.now());
      // Opened in the view the operator is in, so the left list stays theirs.
      if (job.threadIds.length === 1 && opts.open !== false) router.push(`${threadPath(job.threadIds[0]!)}${window.location.search}`);
      void restoreThreadsAction(job.threadIds).then((r) => {
        if ("error" in r) {
          dispatch({ type: "undo_failed", job });
          dispatch({ type: "notice", id: `undo-${job.id}`, label: `Could not restore: ${r.error}`, now: Date.now() });
          router.refresh();
          return;
        }
        dispatch({ type: "undo_done", id: job.id, threadIds: job.threadIds });
        dispatch({ type: "notice", id: `undo-${job.id}`, label: restoredToastLabel(job.threadIds), now: Date.now(), tally: { key: "restored", count: job.threadIds.length } });
        router.refresh();
        window.setTimeout(() => dispatch({ type: "returned", threadIds: job.threadIds }), 1500);
      });
    },
    [router],
  );

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (!isUndoKey(ev)) return;
      if (document.querySelector(".dialog-scrim")) return;
      if (!undoTarget(latest.current)) return;
      ev.preventDefault();
      undoDelete();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoDelete]);

  const leaving = useMemo(() => leavingDraftIds(state), [state]);
  const leavingThreads = useMemo(() => leavingThreadIds(state), [state]);
  const deletingThreads = useMemo(() => deletingThreadIds(state), [state]);
  // Undo callbacks for notices raised through `say`, by notice id; a notice
  // that has one shows Undo until it expires or is taken.
  const undos = useRef(new Map<string, () => void | Promise<void>>());
  // The same words twice within a moment are one notice (phone stress audit,
  // 2026-09-11: "Put back in the inbox" showed twice from one press).
  const lastSaid = useRef<{ label: string; at: number } | null>(null);
  const say = useCallback((label: string, opts: { undo?: () => void | Promise<void> } = {}) => {
    const at = Date.now();
    if (lastSaid.current && lastSaid.current.label === label && at - lastSaid.current.at < 1500) return;
    lastSaid.current = { label, at };
    const id = `say-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (opts.undo) undos.current.set(id, opts.undo);
    dispatch({ type: "notice", id, label, now: Date.now(), ...(opts.undo ? { undoJobId: id } : {}) });
    setNow(Date.now());
  }, []);
  const markHandled = useCallback(
    (messageId: string, threadId: string) => {
      dispatch({ type: "handle_started", threadId });
      void (async () => {
        const r = await markHandledAction(messageId);
        if ("error" in r) {
          dispatch({ type: "handle_failed", threadId });
          say(`Could not mark it handled: ${r.error}`);
          return;
        }
        dispatch({ type: "handle_done", threadId });
        router.refresh();
      })();
    },
    [router, say],
  );
  const handledThreads = useMemo(() => handledThreadIds(state), [state]);

  const undoNotice = useCallback(
    (id: string) => {
      const fn = undos.current.get(id);
      if (fn) {
        undos.current.delete(id);
        dispatch({ type: "dismiss", id });
        void fn();
        return;
      }
      // A merged toast: every delete it counted comes back, and only the
      // last one is opened.
      const notice = latest.current.trashed.find((n) => n.id === id);
      const ids = notice?.undoJobIds ?? [id];
      dispatch({ type: "dismiss", id });
      ids.forEach((jobId, i) => undoDelete(jobId, { open: i === ids.length - 1 }));
    },
    [undoDelete],
  );
  const undoable = useMemo(
    () => [...state.done.map((j) => j.id), ...state.trashed.filter((n) => undos.current.has(n.id)).map((n) => n.id)],
    [state.done, state.trashed],
  );
  const returningThreads = state.returning;
  const value = useMemo<SendGate>(
    () => ({ leaving, leavingThreads, deletingThreads, send, undo, trash, undoDelete, undoable, returningThreads, say, markHandled, handledThreads }),
    [leaving, leavingThreads, deletingThreads, send, undo, trash, undoDelete, undoable, returningThreads, say, markHandled, handledThreads],
  );

  return (
    <GateContext.Provider value={value}>
      {children}
      <SendToasts
        pending={state.pending}
        sent={state.sent}
        trash={state.trash}
        trashInFlight={state.trashInFlight}
        trashed={state.trashed}
        now={now}
        undoable={undoable}
        onUndo={undo}
        onUndoDelete={undoNotice}
      />
    </GateContext.Provider>
  );
}
