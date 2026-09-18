"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type { DraftView } from "@messaging-agent/core";
import { queueReducer, sendDelayFor, type QueueState } from "@/lib/queue";
import { restoreDraftAction, skipAction } from "../actions";
import type { CardMode } from "./DraftCard";
import { useSendGate } from "./SendProvider";

/**
 * The cards one page is showing, and what the operator has typed into them:
 * the Drafts folder's queue, or the one reply card under a thread (spec 10a,
 * 2026-09-10). Both read a card the same way, so they read it from here.
 *
 * Sending is not here. Confirm hands the draft to the send gate above every
 * page (`SendProvider`), which counts the six seconds out whether or not the
 * operator is still on this one. What comes back to this hook is only the two
 * ways a card returns: undone, or a send that failed.
 */
export interface DraftQueue {
  /** The cards still waiting, in the server's order, oldest first. */
  items: DraftView[];
  errors: Record<string, string>;
  edits: Record<string, { text: string; to: string[]; cc: string[] }>;
  mode: CardMode;
  setMode: (m: CardMode) => void;
  /** The gate is passed: the card leaves and the six seconds start. */
  confirmSend: (draftId: string, finalText: string, to: string[], cc: string[]) => void;
  /** Delete the draft (2026-09-14), keeping what was typed into it for the Undo. */
  skip: (draftId: string, current?: { text: string; to: string[]; cc: string[] }) => void;
}

export function useDraftQueue(
  serverItems: DraftView[],
  on: {
    /** A card has left the list, by send or by skip. */
    onLeave?: (draftId: string) => void;
    /** It is back: Undo inside the window, or a send that failed. */
    onReturn?: (draftId: string) => void;
    /** The send itself failed, so the card is back with an error on it. */
    onSendFailed?: (draftId: string) => void;
  } = {},
): DraftQueue {
  const [state, dispatch] = useReducer(queueReducer, { items: serverItems, errors: {}, edits: {}, gone: [] } as QueueState);
  const [mode, setMode] = useState<CardMode>("view");
  const gate = useSendGate();
  // Read when something happens rather than when the hook was called, so a
  // handler written fresh on every render never has to re-run the effects.
  const hooks = useRef(on);
  hooks.current = on;

  // The server's list, taken again every time the page is rendered afresh: a
  // draft Celeste has just written appears without a reload, and one that has
  // been sent from another tab goes.
  useEffect(() => {
    dispatch({ type: "server_items", items: serverItems });
  }, [serverItems]);

  function confirmSend(draftId: string, finalText: string, to: string[], cc: string[]) {
    const item = state.items.find((i) => i.draft.id === draftId);
    if (!item) return;
    dispatch({ type: "confirm_send", draftId, finalText, to, cc });
    setMode("view");
    gate.send(
      { draftId, finalText, to, cc, endsAt: Date.now() + sendDelayFor(item), item },
      {
        onReturn: (p) => {
          dispatch({ type: "returned", item: p.item });
          hooks.current.onReturn?.(p.draftId);
        },
        onFailed: (p, message) => {
          dispatch({ type: "send_failed", draftId: p.draftId, message, item: p.item });
          hooks.current.onSendFailed?.(p.draftId);
        },
      },
    );
    hooks.current.onLeave?.(draftId);
  }

  function skip(draftId: string, current?: { text: string; to: string[]; cc: string[] }) {
    dispatch({ type: "skipped", draftId });
    setMode("view");
    hooks.current.onLeave?.(draftId);
    const done = skipAction(draftId);
    // Said, with an Undo (2026-09-14): a draft holds writing, sometimes the
    // operator's own, and a slip of the x key should not cost it.
    gate.say("Draft deleted", {
      undo: async () => {
        const r = await done;
        if (!r.ok) return;
        const back = await restoreDraftAction(draftId);
        if (!back.ok) return gate.say(`Could not bring the draft back: ${back.error}`);
        dispatch({ type: "returned", item: back.view, ...(current ? { edit: current } : {}) });
        hooks.current.onReturn?.(draftId);
      },
    });
  }

  // A draft the gate is holding is not on screen anywhere, even on a page that
  // has just mounted and knows nothing of the send: the operator confirmed it
  // and walked off, and coming back to find the card waiting would read as a
  // send that never happened.
  const leaving = new Set(gate.leaving);
  const items = leaving.size === 0 ? state.items : state.items.filter((i) => !leaving.has(i.draft.id));

  return { items, errors: state.errors, edits: state.edits, mode, setMode, confirmSend, skip };
}
