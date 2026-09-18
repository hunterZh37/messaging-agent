"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ContextDraft, ConversationUsage } from "@messaging-agent/core";
import { draftContextReducer, openDraft } from "@/lib/ask";
import {
  ASK_GENERAL_CONTEXT,
  ASK_WIDTH_DEFAULT,
  ASK_WIDTH_KEY,
  askContextKey,
  askContextThreadId,
  clampAskWidth,
  toTurn,
  opensAskForDraft,
  togglesAsk,
  type AskContext,
  type Turn,
} from "@/lib/chat";
import { openChatAction, readChatAction, setAskOpenAction, startNewChatAction, type OpenChat } from "./actions";
import { AskPanel } from "./AskPanel";

/** The thread the operator has open, which Celeste always sees (spec 10c). */
export interface LookingAt {
  threadId: string;
  subject: string;
}

/**
 * The draft on the card, as the panel knows it (spec 10c, 2026-09-10): what
 * Celeste is told about it, and the card's own way of taking new text back.
 */
export interface LookingAtDraft extends ContextDraft {
  /** The thread the draft answers: a draft is a reply, so it shares that thread's conversation. */
  threadId: string;
  /** Puts Celeste's wording on the card, down the path a revision takes. */
  apply: (text: string) => void;
  /**
   * Puts a file on the card, wherever the operator dropped it (spec 8,
   * 2026-09-10). The card owns the chips, so a drop on the panel and a drop
   * on the card are the same act and land in the same row.
   */
  attach: (file: File) => Promise<AttachResult>;
  /**
   * Paints the card's chip row again from the database (spec 10c,
   * 2026-09-10). The panel can put a file the operator gave Celeste onto this
   * draft, and the card that owns the chips was not the one that did it.
   */
  reload: () => void;
}

/** What a drop got: the file that landed, or why nothing did. */
export type AttachResult = { ok: true; filename: string } | { ok: false; error: string };

/** The conversation on screen: which one it is, what it is called, what was said. */
interface Conversation {
  /** The context it belongs to, or null when History put it there. */
  key: string | null;
  chatId: string;
  title: string;
  turns: Turn[];
  /** What it has cost so far (spec 13, 2026-09-11), as of the last answer. */
  usage: ConversationUsage | null;
}

function toConversation(key: string | null, open: OpenChat): Conversation {
  return { key, chatId: open.chat.id, title: open.chat.title, turns: open.turns.map(toTurn), usage: open.usage ?? null };
}

interface AskState {
  open: boolean;
  toggle: () => void;
  close: () => void;
  /** The "Looking at" chip: the open thread, until the operator clears it. */
  lookingAt: LookingAt | null;
  clearLookingAt: () => void;
  /** The tab back to the thread on screen after the chip was cleared (2026-09-14). */
  resumeLookingAt: () => void;
  /** What the page has open whether or not the panel is looking at it: the tabs are drawn from this. */
  onScreen: { subject: string | null; draftTo: string | null } | null;
  setLookingAt: (value: LookingAt) => void;
  /** The thread page saying it is gone. Named, so leaving A for B never clears B. */
  forgetLookingAt: (threadId: string) => void;
  /** The draft the queue has open, re-registered on every edit so Celeste reads the text as it is now. */
  lookingAtDraft: LookingAtDraft | null;
  setLookingAtDraft: (value: LookingAtDraft) => void;
  clearLookingAtDraft: () => void;
  /** The card saying it is gone, by id, for the same reason the thread's is. */
  forgetLookingAtDraft: (draftId: string) => void;
  /** What the panel is a conversation about: the open thread, or the draft's. */
  askContext: AskContext;
  /** The conversation on screen, once it is known. Null while one is being fetched. */
  chatId: string | null;
  chatTitle: string;
  /** What the conversation on screen has cost, or null before the first answer. */
  chatUsage: ConversationUsage | null;
  /** Everything said in it, oldest first, with the question the operator just asked. */
  turns: Turn[];
  /** True while the conversation for a context the panel has not been on is loading. */
  loadingChat: boolean;
  /**
   * The panel adding a turn it already has: the question, then Celeste's
   * answer. The answer brings the conversation's running totals with it, so
   * the line under the title is right without a second round trip.
   */
  addTurn: (turn: Turn, usage?: ConversationUsage) => void;
  /** New: closes the one on screen and starts a fresh one in the same context. */
  newConversation: () => Promise<void>;
  /** History: reopens one, without going to the thread it is about. */
  openConversation: (chatId: string) => Promise<void>;
  /** A conversation the operator deleted: dropped from memory, and replaced if it was the one on screen. */
  forgetConversation: (chatId: string) => void;
  /** A page handing over the conversation for its own context, fetched server-side. */
  seedChat: (key: string, opened: OpenChat) => void;
  /** How wide the panel is, in pixels. The content beside it is inset by the same. */
  width: number;
  /** Live during a drag: moves the edge without writing it down. */
  resizeTo: (width: number) => void;
  /** A key moved the edge: this is the width to come back to. */
  rememberWidth: (width: number) => void;
  /**
   * The drag is over. It takes no width because the one to keep is whatever
   * the last move set, which a handler's own closure may be a frame behind.
   */
  commitWidth: () => void;
}

const AskContext = createContext<AskState>({
  open: false,
  toggle: () => {},
  close: () => {},
  lookingAt: null,
  clearLookingAt: () => {},
  resumeLookingAt: () => {},
  onScreen: null,
  setLookingAt: () => {},
  forgetLookingAt: () => {},
  lookingAtDraft: null,
  setLookingAtDraft: () => {},
  clearLookingAtDraft: () => {},
  forgetLookingAtDraft: () => {},
  askContext: {},
  chatId: null,
  chatTitle: "General",
  chatUsage: null,
  turns: [],
  loadingChat: false,
  addTurn: () => {},
  newConversation: async () => {},
  openConversation: async () => {},
  seedChat: () => {},
  forgetConversation: () => {},
  width: ASK_WIDTH_DEFAULT,
  resizeTo: () => {},
  rememberWidth: () => {},
  commitWidth: () => {},
});

export function useAsk(): AskState {
  return useContext(AskContext);
}

/** The panel's draft context, over the card as this file knows it. */
const draftReducer = draftContextReducer<LookingAtDraft>;

// The stored width has to land before the first paint, or the panel opens at
// 380 and jumps. On the server there is no layout to measure, and asking for
// one there is what React warns about.
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Ask Celeste's shell (spec 10c). It wraps the whole app because the panel
 * stays open across folders and threads. The conversation is not one long
 * transcript any more: it follows what the operator has open (2026-09-10),
 * a thread at a time, with General for everything else. The open state lives
 * here and is written to a cookie, so a reload finds the panel where it was
 * left.
 */
export function AskProvider(props: { initialOpen: boolean; initialChat: OpenChat; children: ReactNode }) {
  const [open, setOpen] = useState(props.initialOpen);
  // The open panel is remembered in a cookie the phone shares with the Mac.
  // On a phone it covers the whole screen, so opening Celeste there starts
  // on the page, not on a conversation left open on the desktop (2026-09-14).
  // The cookie is left as it is: the Mac keeps its panel.
  useEffect(() => {
    if (window.matchMedia("(max-width: 899px)").matches) setOpen(false);
  }, []);
  const [thread, setThread] = useState<LookingAt | null>(null);
  // Clearing the chip is about the next question, not about the page: opening
  // another thread puts it back.
  const [clearedThreadId, setClearedThreadId] = useState<string | null>(null);
  // Which card is on screen, as its own little state machine: registering,
  // going and clearing all name the draft they mean, so a card that is leaving
  // can never take the chip off the card that has just arrived (spec 10c,
  // 2026-09-10).
  const [draftContext, dispatchDraft] = useReducer(draftReducer, { registered: null, clearedId: null });
  const [width, setWidth] = useState(ASK_WIDTH_DEFAULT);
  // State is what renders; the ref is what the pointer handlers read. A
  // pointerup landing in the same frame as the move before it sees a stale
  // `width` in its closure, and persisting that would undo the drag.
  const latestWidth = useRef(ASK_WIDTH_DEFAULT);

  const apply = useCallback((next: number) => {
    const clamped = clampAskWidth(next, window.innerWidth);
    latestWidth.current = clamped;
    setWidth(clamped);
    return clamped;
  }, []);

  const store = useCallback((value: number) => {
    try {
      window.localStorage.setItem(ASK_WIDTH_KEY, String(value));
    } catch {
      // A browser with storage off still gets a panel; it just forgets the width.
    }
  }, []);

  useBeforePaint(() => {
    const stored = Number(window.localStorage.getItem(ASK_WIDTH_KEY));
    if (stored > 0) apply(stored);
  }, [apply]);

  const resizeTo = useCallback((next: number) => {
    apply(next);
  }, [apply]);

  const rememberWidth = useCallback((next: number) => {
    store(apply(next));
  }, [apply, store]);

  const commitWidth = useCallback(() => {
    store(latestWidth.current);
  }, [store]);

  const persist = useCallback((next: boolean) => {
    setOpen(next);
    void setAskOpenAction(next);
  }, []);

  const toggle = useCallback(() => persist(!open), [open, persist]);
  const close = useCallback(() => persist(false), [persist]);

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (!togglesAsk(ev)) return;
      ev.preventDefault();
      persist(!open);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, persist]);

  const setLookingAt = useCallback((value: LookingAt) => {
    setThread(value);
  }, []);

  const forgetLookingAt = useCallback((threadId: string) => {
    setThread((prev) => (prev?.threadId === threadId ? null : prev));
  }, []);

  const clearLookingAt = useCallback(() => {
    setClearedThreadId(thread?.threadId ?? null);
  }, [thread]);

  const setLookingAtDraft = useCallback((value: LookingAtDraft) => {
    dispatchDraft({ type: "register", draft: value });
  }, []);

  const forgetLookingAtDraft = useCallback((draftId: string) => {
    dispatchDraft({ type: "forget", draftId });
  }, []);

  const clearLookingAtDraft = useCallback(() => {
    dispatchDraft({ type: "clear" });
  }, []);

  // Back to the thread or draft on screen, both at once: one tab, one act.
  const resumeLookingAt = useCallback(() => {
    setClearedThreadId(null);
    dispatchDraft({ type: "resume" });
  }, []);

  const lookingAt = thread && thread.threadId !== clearedThreadId ? thread : null;
  const lookingAtDraft = openDraft(draftContext);
  const registeredDraft = draftContext.registered;
  const onScreen = useMemo(
    () => (thread || registeredDraft ? { subject: thread?.subject ?? registeredDraft?.subject ?? null, draftTo: registeredDraft?.to[0] ?? null } : null),
    [thread, registeredDraft],
  );

  // A draft on screen brings the panel with it on a wide desktop (2026-09-14):
  // the card's revise field is gone and this is where the draft is talked
  // about. Once per draft, so closing it stays closed for that card.
  const openedFor = useRef<string | null>(null);
  const registeredDraftId = draftContext.registered?.draftId ?? null;
  useEffect(() => {
    if (!opensAskForDraft({ open, width: window.innerWidth, draftId: registeredDraftId, openedFor: openedFor.current })) return;
    openedFor.current = registeredDraftId;
    persist(true);
  }, [open, registeredDraftId, persist]);

  // What the panel is a conversation about. A draft is a reply in its thread,
  // so both land on the same one; clearing the chip means Celeste is not
  // looking at the thread any more, and the question belongs in General.
  const askContext = useMemo<AskContext>(
    () => ({ threadId: lookingAt?.threadId ?? null, draftThreadId: lookingAtDraft?.threadId ?? null }),
    [lookingAt?.threadId, lookingAtDraft?.threadId],
  );
  const contextKey = askContextKey(askContext);

  // Switching back and forth between two threads should not be two fetches
  // every time, so what each context was last on is kept here for the visit.
  // Built once, on the first render: mapping the whole transcript again every
  // time the panel resizes would be work for nothing.
  const [cache] = useState(() => new Map<string, Conversation>([[ASK_GENERAL_CONTEXT, toConversation(ASK_GENERAL_CONTEXT, props.initialChat)]]));
  const [conversation, setConversation] = useState<Conversation | null>(() => cache.get(ASK_GENERAL_CONTEXT) ?? null);
  const [loadingChat, setLoadingChat] = useState(false);
  // What is on screen, read by the effect below without re-running it: a
  // conversation opened from History has no context, and stays until the
  // operator goes somewhere else.
  const shown = useRef<string | null>(ASK_GENERAL_CONTEXT);
  // One fetch at a time wins: a slow answer for the thread the operator has
  // already left must not land on top of the one they are looking at now.
  const request = useRef(0);

  const show = useCallback((next: Conversation) => {
    if (next.key) cache.set(next.key, next);
    shown.current = next.key;
    setConversation(next);
    setLoadingChat(false);
  }, [cache]);

  /** Puts the panel on the conversation for what is open, fetching it once. */
  const loadContext = useCallback(async () => {
    const cached = cache.get(contextKey);
    if (cached) return show(cached);
    // Nothing of this context on screen: better an empty panel for a moment
    // than another thread's conversation under this thread's chip.
    setConversation(null);
    setLoadingChat(true);
    const ticket = ++request.current;
    const opened = await openChatAction({ threadId: askContextThreadId(askContext) });
    if (request.current === ticket) show(toConversation(contextKey, opened));
  }, [askContext, cache, contextKey, show]);

  // Before the paint, not after: the thread page says which thread it is in
  // an effect of its own, and a frame of the last conversation under this
  // thread's chip would read as Celeste answering about the wrong mail.
  // Only while the panel is open: a closed panel fetching a conversation for
  // every thread the operator glances at was a server round trip per click,
  // and a chat row per glance (operator, 2026-09-11). Opening the panel
  // fetches what is under it then.
  useBeforePaint(() => {
    if (!open || shown.current === contextKey) return;
    void loadContext();
  }, [open, contextKey, loadContext]);

  /**
   * A page handing over the conversation it already fetched on the server, so
   * opening a thread paints what was said last time rather than fetching it
   * after mount. Only when nothing is held for that context: what is in hand
   * may carry a question asked seconds ago that the server has not been asked
   * for again.
   */
  const seedChat = useCallback((key: string, opened: OpenChat) => {
    if (!cache.has(key)) cache.set(key, toConversation(key, opened));
  }, [cache]);

  const addTurn = useCallback((turn: Turn, usage?: ConversationUsage) => {
    setConversation((prev) => {
      if (!prev) return prev;
      const next = { ...prev, turns: [...prev.turns, turn], usage: usage ?? prev.usage };
      if (next.key) cache.set(next.key, next);
      return next;
    });
  }, [cache]);

  const newConversation = useCallback(async () => {
    setLoadingChat(true);
    const ticket = ++request.current;
    const started = await startNewChatAction({ threadId: askContextThreadId(askContext) });
    if (request.current === ticket) show(toConversation(contextKey, started));
  }, [askContext, contextKey, show]);

  const openConversation = useCallback(async (chatId: string) => {
    setConversation(null);
    setLoadingChat(true);
    const ticket = ++request.current;
    const opened = await readChatAction(chatId);
    if (request.current !== ticket) return;
    // Gone means gone: the panel goes back to the conversation for whatever
    // the operator has open rather than sitting on nothing.
    if ("error" in opened) {
      shown.current = null;
      return loadContext();
    }
    show(toConversation(null, opened));
  }, [loadContext, show]);

  const forgetConversation = useCallback((chatId: string) => {
    for (const [key, held] of cache) if (held.chatId === chatId) cache.delete(key);
    if (conversation?.chatId === chatId) {
      shown.current = null;
      void loadContext();
    }
  }, [cache, conversation, loadContext]);

  const value = useMemo<AskState>(
    () => ({
      open, toggle, close,
      lookingAt, clearLookingAt, setLookingAt, forgetLookingAt,
      lookingAtDraft, setLookingAtDraft, clearLookingAtDraft, forgetLookingAtDraft, resumeLookingAt, onScreen,
      askContext,
      chatId: conversation?.chatId ?? null,
      chatTitle: conversation?.title ?? "",
      chatUsage: conversation?.usage ?? null,
      turns: conversation?.turns ?? [],
      loadingChat, addTurn, newConversation, openConversation, seedChat, forgetConversation,
      width, resizeTo, rememberWidth, commitWidth,
    }),
    [
      open, toggle, close,
      lookingAt, clearLookingAt, setLookingAt, forgetLookingAt,
      lookingAtDraft, setLookingAtDraft, clearLookingAtDraft, forgetLookingAtDraft, resumeLookingAt, onScreen,
      askContext, conversation, loadingChat, addTurn, newConversation, openConversation, seedChat, forgetConversation,
      width, resizeTo, rememberWidth, commitWidth,
    ],
  );

  return (
    <AskContext.Provider value={value}>
      <div className="shell" data-ask={open ? "open" : undefined} style={{ "--ask-width": `${width}px` } as CSSProperties}>
        {props.children}
        {open ? <div className="ask-scrim" onClick={close} /> : null}
        <AskPanel />
      </div>
    </AskContext.Provider>
  );
}

/**
 * Rendered by the open draft card: it tells the panel which draft is on
 * screen and what its text is right now, so a question asked from the queue
 * carries the words the operator is looking at. `apply` is how Celeste's
 * wording gets back onto that card. Every edit re-registers, and unmounting
 * clears it unless another draft has already claimed the chip.
 */
export function ContextDraftCard(props: LookingAtDraft) {
  const { setLookingAtDraft, forgetLookingAtDraft } = useAsk();
  const { draftId, threadId, subject, text, apply, attach, reload } = props;
  // Joined, because a fresh array every render would re-run this every render.
  const to = props.to.join(",");
  const cc = props.cc.join(",");
  // Before the paint, so the panel is on this draft's conversation in the
  // frame the card appears rather than showing the last one for an instant.
  useBeforePaint(() => {
    setLookingAtDraft({ draftId, threadId, subject, text, apply, attach, reload, to: to ? to.split(",") : [], cc: cc ? cc.split(",") : [] });
  }, [draftId, threadId, subject, text, apply, attach, reload, to, cc, setLookingAtDraft]);
  // Letting go is its own effect, keyed to the draft alone. Together with the
  // one above it would run on every keystroke — a goodbye and a hello for each
  // letter typed into the card — and the panel would spend those frames
  // looking at no draft at all.
  useBeforePaint(() => () => forgetLookingAtDraft(draftId), [draftId, forgetLookingAtDraft]);
  return null;
}

/**
 * Rendered by the thread page: it tells the panel which thread is open, so
 * the chip names it and the question carries it. Unmounting clears the chip
 * unless another thread has already claimed it.
 */
export function ContextThread({ threadId, subject, chat }: { threadId: string; subject: string; chat?: OpenChat }) {
  const { setLookingAt, forgetLookingAt, seedChat } = useAsk();
  // The conversation is handed over first and once. `chat` is a fresh object
  // on every render of the page, so it cannot be a dependency of the effect
  // below: re-registering the thread would drop the chip and put it back.
  const seeded = useRef<string | null>(null);
  useBeforePaint(() => {
    if (!chat || seeded.current === threadId) return;
    seeded.current = threadId;
    seedChat(threadId, chat);
  });
  // Before the paint, for the same reason the draft card's is.
  useBeforePaint(() => {
    setLookingAt({ threadId, subject });
    return () => forgetLookingAt(threadId);
  }, [threadId, subject, setLookingAt, forgetLookingAt]);
  return null;
}
