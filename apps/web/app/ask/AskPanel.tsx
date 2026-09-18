"use client";

import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ProposedAction } from "@messaging-agent/core";
import {
  actionDoneLabel,
  actionLabel,
  appliesToOpenDraft,
  askEmptyLine,
  askPlaceholder,
  askTabs,
  autoRunsDraft,
  ASK_WIDTH_DEFAULT,
  ASK_WIDTH_MIN,
  ASK_WIDTH_MAX_FRACTION,
  chatCountLabel,
  chatTitleLabel,
  conversationAboutLabel,
  conversationCostLabel,
  conversationUsageLabel,
  citationChipLabel,
  citeAnchorId,
  renderAnswer,
  resizeStep,
  revisesOpenDraft,
  sendsOnEnter,
  toTurn,
  widthFromDrag,
  threadChipLabel,
  threadsOf,
  type Turn,
} from "@/lib/chat";
import {
  attachedQuestion,
  attachToDraftLabel,
  chatFileHref,
  draftAttachmentSizeLabel,
  draggingFiles,
  dropTargetLabel,
  gaveQuestion,
  isPreviewable,
} from "@/lib/attachments";
import { relativeTime } from "@/lib/format";
import { AttachmentPreview, ClipIcon } from "../queue/AttachmentPreview";
import { CelesteMark } from "../queue/CelesteMark";
import { recordAppliedRevisionAction, reviseAction } from "../actions";
import {
  askAction,
  askDraftAction,
  askFileAction,
  askMarkHandledAction,
  attachChatFileToDraftAction,
  listChatFilesAction,
  listChatsAction,
  type ChatFile,
  type ChatHistoryRow,
  deleteChatAction,
} from "./actions";
import { useAsk, type LookingAtDraft } from "./AskProvider";

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** History, on the button that opens the list of past conversations. */
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** New conversation. */
function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** New conversation: a page with a pen, so the composer's + stays the only + on the panel. */
function NewChatIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

/** Back, out of the History list and into the conversation it covered. */
function BackIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

/** The thread tab's mark: a speech bubble, the thing the question is about. */
function ThreadTabIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5V11H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    </svg>
  );
}

function threadHref(threadId: string): string {
  return `/inbox/${encodeURIComponent(threadId)}`;
}

/**
 * A proposal, as a button. Nothing here ran when Celeste said it: the click
 * is the action, and one click covers every thread the proposal names —
 * filing six is one decision, not six (spec 10c). Once it has happened the
 * button says what it did and stops offering.
 */
function ActionButton({
  action,
  turn,
  question,
  applied,
  drafted,
}: {
  action: ProposedAction;
  turn: Turn;
  question: string;
  applied?: boolean;
  /** The panel ran this one itself: "running" while it does, then the drafts it left. */
  drafted?: string[] | "running";
}) {
  const [pending, startTransition] = useTransition();
  const [ran, setRan] = useState<{ label: string; href?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const { lookingAtDraft } = useAsk();
  const threadIds = threadsOf(action);
  // A draft rewrite the panel already put on the card, and a draft it wrote
  // without being asked twice, both read as done from the first paint.
  const auto = Array.isArray(drafted) && drafted.length > 0 ? { label: actionDoneLabel(action.kind, drafted.length, 0), href: `/drafts?draft=${drafted[0]}` } : null;
  const done = ran ?? (applied ? { label: actionDoneLabel("apply_draft", 1, 0) } : auto);
  const running = drafted === "running";

  // Opening is a link, and several threads are several links: the chips
  // beneath are those links, so there is no button to press here.
  if (action.kind === "open_thread") {
    if (threadIds.length === 1) {
      return (
        <Link href={threadHref(threadIds[0]!)} className="btn quiet ask-action">
          Open
        </Link>
      );
    }
    return <span className="ask-note">{actionLabel(action)}</span>;
  }

  /**
   * "Apply to draft": the text goes onto the card the operator has open, the
   * same way a revision typed under the draft does, and the card's Undo can
   * walk it back. What it replaced is written to the draft's revisions under
   * the question that produced it, so the draft's history is whole whichever
   * field the operator used. Nothing is sent.
   */
  function apply(target: LookingAtDraft) {
    const next = action.text ?? "";
    if (next === "") return setError("Celeste proposed no text to apply.");
    const before = target.text;
    setError(null);
    target.apply(next);
    setRan({ label: actionDoneLabel("apply_draft", 1, 0) });
    startTransition(async () => {
      const r = await recordAppliedRevisionAction({ draftId: target.draftId, before, after: next, question, model: turn.model });
      if (!r.ok) setError(r.error);
    });
  }

  if (action.kind === "apply_draft") {
    // The card that was open when she offered it, and still is. Anything
    // else and there is nowhere for the text to go.
    const target = appliesToOpenDraft(turn.contextDraftId, lookingAtDraft?.draftId) ? lookingAtDraft : null;
    return (
      <>
        {done ? (
          <span className="ask-done">{done.label}</span>
        ) : (
          <button
            type="button"
            className="btn quiet ask-action"
            onClick={() => target && apply(target)}
            disabled={pending || !target}
            title={target ? undefined : "That draft is no longer open"}
          >
            {actionLabel(action)}
          </button>
        )}
        {error ? <div className="error">{error}</div> : null}
      </>
    );
  }

  function run() {
    setError(null);
    startTransition(async () => {
      if (action.kind === "draft_reply" || action.kind === "draft_follow_up") {
        const r = await askDraftAction(threadIds, action.instruction);
        if ("error" in r && !("draftIds" in r)) return setError(r.error);
        setRan({ label: actionDoneLabel(action.kind, r.draftIds.length, r.failed), href: `/drafts?draft=${r.draftIds[0]}` });
        // Asked from the Drafts folder, the new card joins the list beside the
        // answer, so it is the one that opens rather than whatever was on top.
        if (pathname === "/drafts") router.replace(`/drafts?draft=${r.draftIds[0]}`);
      } else if (action.kind === "file_to_project") {
        const r = await askFileAction(threadIds, action.projectName ?? "", action.createProject === true);
        if ("error" in r) return setError(r.error);
        setRan({ label: actionDoneLabel(action.kind, r.filed, 0, action.projectName) });
      } else {
        const r = await askMarkHandledAction(threadIds);
        if ("error" in r) return setError(r.error);
        setRan({ label: actionDoneLabel(action.kind, r.marked, r.failed) });
      }
      router.refresh();
    });
  }

  return (
    <>
      {done ? (
        <span className="ask-done">
          {done.label}
          {done.href ? (
            <>
              {" · "}
              <Link href={done.href}>Open queue</Link>
            </>
          ) : null}
        </span>
      ) : (
        <button type="button" className="btn quiet ask-action" onClick={run} disabled={pending || running}>
          {pending || running ? "Working…" : actionLabel(action)}
        </button>
      )}
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}

/**
 * On a phone the sheet covers the page, so a tap on a cited thread closes
 * the sheet to show it (phone stress audit, 2026-09-11: the thread opened
 * underneath, unseen, and the sheet only changed its subject line).
 */
function closeOnPhone(close: () => void) {
  if (window.matchMedia?.("(max-width: 899px)").matches) close();
}

function AssistantTurn({ turn, question, applied, drafted }: { turn: Turn; question: string; applied?: boolean; drafted?: string[] | "running" }) {
  const { close } = useAsk();
  const cited = new Set(turn.citations.map((c) => c.messageId));
  // A marker points at its own chip when there is one; when there is not, the
  // number stands on its own rather than linking nowhere.
  const html = renderAnswer(turn.content, (messageId) => (cited.has(messageId) ? `#${citeAnchorId(turn.id, messageId)}` : undefined));
  return (
    <div className="ask-turn celeste-turn">
      <CelesteMark />
      <div className="ask-bubble" dangerouslySetInnerHTML={{ __html: html }} />
      {turn.citations.length > 0 ? (
        <div className="ask-cites">
          {turn.citations.map((c) => (
            <Link key={c.messageId} id={citeAnchorId(turn.id, c.messageId)} href={threadHref(c.threadId)} className="chip ask-cite" onClick={() => closeOnPhone(close)}>
              {citationChipLabel(c)}
            </Link>
          ))}
        </div>
      ) : null}
      {turn.actions.length > 0 ? (
        <div className="ask-actions">
          {turn.actions.map((a, i) => {
            const threads = threadsOf(a);
            return (
              <div key={`${a.kind}-${threads.join(",")}-${i}`} className="ask-action-row">
                <ActionButton action={a} turn={turn} question={question} applied={applied} drafted={drafted} />
                {a.note ? <span className="ask-note">{a.note}</span> : null}
                {threads.length > 1 ? (
                  <div className="ask-threads">
                    {threads.map((threadId, n) => (
                      <Link key={threadId} href={threadHref(threadId)} className="chip ask-cite" onClick={() => closeOnPhone(close)}>
                        {threadChipLabel(a, threadId, n)}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The panel's left edge, as a handle. Dragging it is the whole point; the
 * keyboard gets the same width by arrow key, because a drag is not something
 * every operator can do. Below 1200px the panel lies over the app instead of
 * beside it, and there is nothing to resize — CSS hides this there.
 */
function ResizeGrip() {
  const { width, resizeTo, rememberWidth, commitWidth } = useAsk();
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  // The window is not there to measure while the server renders this, and a
  // guess would differ from what the browser finds: it lands after hydration.
  const [maxWidth, setMaxWidth] = useState(ASK_WIDTH_DEFAULT);

  useEffect(() => {
    const measure = () => setMaxWidth(Math.round(window.innerWidth * ASK_WIDTH_MAX_FRACTION));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  function onPointerDown(ev: ReactPointerEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    drag.current = { startX: ev.clientX, startWidth: width };
    // Capture keeps the drag alive once the pointer leaves this 8px strip.
    // A pointer the browser no longer knows about is not worth aborting for.
    try {
      ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch {
      /* no capture; the drag still tracks while the pointer is over the strip */
    }
    // The pointer is going to travel over text; none of it should highlight.
    document.body.style.userSelect = "none";
  }

  function onPointerMove(ev: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    // The edge is on the left, so moving left makes the panel wider.
    resizeTo(widthFromDrag(drag.current.startWidth, drag.current.startX, ev.clientX));
  }

  function endDrag(ev: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    document.body.style.userSelect = "";
    try {
      if (ev.currentTarget.hasPointerCapture(ev.pointerId)) ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released, or never captured */
    }
    // Not `width`: this handler's closure can be a frame behind the last move.
    commitWidth();
  }

  function onKeyDown(ev: ReactKeyboardEvent<HTMLDivElement>) {
    const step = resizeStep(ev.key, ev.shiftKey);
    if (step === 0) return;
    ev.preventDefault();
    rememberWidth(width + step);
  }

  return (
    <div
      className="ask-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Ask Celeste"
      aria-valuenow={width}
      aria-valuemin={ASK_WIDTH_MIN}
      aria-valuemax={maxWidth}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => rememberWidth(ASK_WIDTH_DEFAULT)}
    />
  );
}

/**
 * Every conversation the operator has had, newest first (spec 10c,
 * 2026-09-10). Clicking one reopens it here; it does not take the operator to
 * the thread it is about, because History is for reading back, not for
 * navigating. The clock is read after mount, as the sync label's is: the
 * server and the browser disagree by enough milliseconds to turn "just now"
 * into "1 min ago" between the two renders.
 */
function History({ onPick, onBack, onDeleted }: { onPick: (chatId: string) => void; onBack: () => void; onDeleted: (chatId: string) => void }) {
  const [chats, setChats] = useState<ChatHistoryRow[] | null>(null);
  const [now, setNow] = useState<number | null>(null);
  // The × asks once: the first press turns into "Delete N messages?", the
  // second deletes. Moving to another row or waiting resets it (operator,
  // 2026-09-10: a way to delete chat history; no Cancel buttons).
  const [arming, setArming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNow(Date.now());
    let live = true;
    void listChatsAction().then((rows) => {
      if (live) setChats(rows);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!arming) return;
    const id = setTimeout(() => setArming(null), 4000);
    return () => clearTimeout(id);
  }, [arming]);

  async function remove(chat: ChatHistoryRow) {
    setArming(null);
    setError(null);
    const r = await deleteChatAction(chat.id);
    if ("error" in r) return setError(r.error);
    setChats((prev) => (prev ?? []).filter((c) => c.id !== chat.id));
    onDeleted(chat.id);
  }

  return (
    <>
      <div className="ask-history-head">
        <button type="button" className="ask-close ask-back" onClick={onBack} aria-label="Back to the conversation">
          <BackIcon />
        </button>
        <span className="ask-history-title">History</span>
      </div>
      <div className="ask-scroll ask-history-list">
        {chats === null ? <p className="ask-empty">Looking…</p> : null}
        {chats !== null && chats.length === 0 ? <p className="ask-empty">Nothing here yet. Ask Celeste something and it will be.</p> : null}
        {error ? <div className="error">{error}</div> : null}
        {(chats ?? []).map((chat) => (
          <div key={chat.id} className="ask-history-item">
            <button type="button" className="ask-history-row" onClick={() => onPick(chat.id)}>
              <span className="ask-history-name">{conversationAboutLabel(chat.title, chat.firstQuestion)}</span>
              <span className="ask-history-meta">
                {chat.lastAt !== null && now !== null ? `${relativeTime(chat.lastAt, now)} · ` : ""}
                {chatCountLabel(chat.messageCount)}
                {chat.inputTokens + chat.outputTokens > 0 ? ` · ${conversationCostLabel(chat.costUsd)}` : ""}
              </span>
            </button>
            {arming === chat.id ? (
              <button type="button" className="btn quiet ask-history-confirm" onClick={() => void remove(chat)}>
                Delete {chatCountLabel(chat.messageCount)}?
              </button>
            ) : (
              <button type="button" className="applied-clear ask-history-del" onClick={() => setArming(chat.id)} aria-label={`Delete the conversation ${chatTitleLabel(chat.title)}`} title="Delete this conversation">
                <CloseIcon />
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** The × on a file chip: it comes off the conversation, the bytes on disk stay. */
function ChipXIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** One file in the conversation, as the panel holds it while it is still going up. */
type PanelFile = ChatFile & { uploading?: boolean };

/**
 * The files the operator has given this conversation, as chips over the
 * composer (spec 10c, 2026-09-10). A chip of a previewable type opens the file
 * underneath it, the same click that works on a draft; anything else
 * downloads, because nothing else renders safely in this origin (spec 11a).
 * With a draft open each one also offers to go onto that mail — Celeste can
 * say a file belongs there, and this button is the only thing that puts it
 * there.
 */
function AskFiles({
  chatId,
  files,
  draft,
  onRemove,
  onAttach,
}: {
  chatId: string;
  files: PanelFile[];
  draft: LookingAtDraft | null;
  onRemove: (id: string) => void;
  onAttach: (file: PanelFile) => void;
}) {
  const [previewing, setPreviewing] = useState<Set<string>>(new Set());
  const attach = attachToDraftLabel(draft);

  function toggle(id: string) {
    setPreviewing((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (files.length === 0) return null;

  return (
    <div className="ask-files">
      <div className="att-row">
        {files.map((f) => {
          const shown = previewing.has(f.id);
          const label = (
            <>
              <ClipIcon />
              <span className="att-name">{f.filename}</span>
              <span className="att-size">{draftAttachmentSizeLabel(f)}</span>
            </>
          );
          return (
            <span key={f.id} className={`chip att-chip${f.uploading ? " dim" : ""}${shown ? " on" : ""}`}>
              {f.uploading ? (
                // Nothing to open yet: the server has not said the file is there.
                <span className="att-open">{label}</span>
              ) : isPreviewable(f.mimeType) ? (
                <button type="button" className="att-open" onClick={() => toggle(f.id)} aria-expanded={shown}>
                  {label}
                </button>
              ) : (
                <a className="att-open" href={chatFileHref(chatId, f.id, true)} download={f.filename}>
                  {label}
                </a>
              )}
              {attach && !f.uploading && (
                <button type="button" className="btn quiet ask-file-attach" onClick={() => onAttach(f)} title={attach.title}>
                  {attach.label}
                </button>
              )}
              {!f.uploading && (
                <button type="button" className="applied-clear" onClick={() => onRemove(f.id)} aria-label={`Remove ${f.filename}`}>
                  <ChipXIcon />
                </button>
              )}
            </span>
          );
        })}
      </div>
      {files
        .filter((f) => previewing.has(f.id) && !f.uploading)
        .map((f) => (
          <AttachmentPreview key={f.id} href={chatFileHref(chatId, f.id, false)} filename={f.filename} mimeType={f.mimeType} />
        ))}
    </div>
  );
}

/**
 * The right-hand panel (spec 10c): the conversation for whatever the operator
 * has open — a thread's own, or General — named under the head, with her
 * answers carrying the Celeste mark, her citations as chips and her proposals
 * as buttons. History goes back to any conversation; New starts another one
 * here.
 */
export function AskPanel() {
  const {
    open, close, lookingAt, clearLookingAt, lookingAtDraft, clearLookingAtDraft, resumeLookingAt, onScreen,
    askContext, chatId, chatTitle, chatUsage, turns, loadingChat, addTurn, newConversation, openConversation, forgetConversation,
  } = useAsk();
  // What this conversation has cost so far, refreshed by every answer.
  const spent = conversationUsageLabel(chatUsage);
  const [showHistory, setShowHistory] = useState(false);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);

  // The box grows with what is typed and shrinks back once it is sent
  // (stress audit, 2026-09-11: it stayed tall and empty after an answer).
  useEffect(() => {
    if (question === "" && box.current) box.current.style.height = "";
  }, [question]);
  const router = useRouter();
  // The pointer crosses every child on the way in; the overlay counts rather
  // than blinking off over the transcript.
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Answers whose draft rewrite the panel has already applied, by turn id. */
  const [applied, setApplied] = useState<Set<string>>(() => new Set());
  /** Answers whose draft the panel wrote without waiting for a click, by turn id. */
  const [drafted, setDrafted] = useState<Map<string, string[] | "running">>(() => new Map());
  /** The files the operator has given this conversation (spec 10c, 2026-09-10). */
  const [files, setFiles] = useState<PanelFile[]>([]);
  /** The card as it is now, for code that resumes after an await. */
  const latestDraft = useRef(lookingAtDraft);
  latestDraft.current = lookingAtDraft;
  const drop = dropTargetLabel(lookingAtDraft);

  // On a phone the panel is the whole screen, and iOS hands a swipe on it to
  // the page underneath, which moves where nobody can see it, so the panel
  // reads as unscrollable (operator, 2026-09-15). The page is pinned where it
  // was while the panel is open, and put back exactly there when it closes.
  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 899px)").matches) return;
    const y = window.scrollY;
    const body = document.body.style;
    const saved = { position: body.position, top: body.top, left: body.left, right: body.right, overflow: document.documentElement.style.overflow };
    document.documentElement.style.overflow = "hidden";
    body.position = "fixed";
    body.top = `-${y}px`;
    body.left = "0";
    body.right = "0";
    return () => {
      document.documentElement.style.overflow = saved.overflow;
      body.position = saved.position;
      body.top = saved.top;
      body.left = saved.left;
      body.right = saved.right;
      window.scrollTo(0, y);
    };
  }, [open]);

  useEffect(() => {
    if (!open || showHistory) return;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    // Not on a touch screen (2026-09-15): the keyboard would come up over the
    // conversation the moment the panel opens, and the phone zoomed with it.
    if (!window.matchMedia("(hover: none)").matches) box.current?.focus();
  }, [open, showHistory, turns.length, pending]);

  // The chips follow the conversation: History, New and opening another thread
  // all put a different one on screen, and its files are its own. Empty on the
  // server and empty on the first paint, so nothing here can mismatch.
  useEffect(() => {
    if (!chatId) return setFiles([]);
    let live = true;
    void listChatFilesAction(chatId).then((rows) => {
      if (live) setFiles(rows);
    });
    return () => {
      live = false;
    };
  }, [chatId]);

  if (!open) return null;

  async function send() {
    const text = question.trim();
    if (!text || pending || !chatId) return;
    setQuestion("");
    await ask(text);
  }

  /**
   * One question up, and the answer back. `auto` marks a question the app
   * asked on the operator's behalf after a drop, so its bubble reads as what
   * it is rather than as something they typed.
   */
  async function ask(text: string, opts: { auto?: boolean } = {}) {
    if (!chatId) return;
    const contextThreadId = lookingAt?.threadId ?? null;
    // The card as it stands, without the callback that puts text back on it:
    // that one is the browser's, and only the words cross to the server.
    const contextDraft = lookingAtDraft
      ? {
          draftId: lookingAtDraft.draftId,
          to: lookingAtDraft.to,
          cc: lookingAtDraft.cc,
          subject: lookingAtDraft.subject,
          text: lookingAtDraft.text,
        }
      : undefined;
    setError(null);
    setPending(true);
    // The question goes up straight away; only the answer is worth waiting for.
    addTurn({
      id: `local-${Date.now()}`,
      role: "user",
      content: text,
      citations: [],
      actions: [],
      contextDraftId: contextDraft?.draftId ?? null,
      model: null,
      ...(opts.auto ? { auto: true } : {}),
    });
    try {
      const result = await askAction(chatId, text, contextThreadId, contextDraft);
      if ("error" in result) setError(result.error);
      else {
        const turn = toTurn(result.assistant);
        addTurn(turn, result.usage);
        // A rewrite of the draft she is looking at lands on the card at once,
        // as a revision typed under the draft does, with Undo to walk it back
        // (operator, 2026-09-10: her "updated the draft" has to be true).
        // The card is read again after the wait: it may have changed meanwhile.
        const proposal = turn.actions.find((a) => a.kind === "apply_draft" && (a.text ?? "") !== "");
        const card = latestDraft.current;
        if (proposal && card && contextDraft && card.draftId === contextDraft.draftId) {
          const before = card.text;
          card.apply(proposal.text ?? "");
          setApplied((prev) => new Set(prev).add(turn.id));
          void recordAppliedRevisionAction({ draftId: card.draftId, before, after: proposal.text ?? "", question: text, model: turn.model });
        }
        // A draft of the mail they are looking at is not something to press a
        // button for: it is written now, and the reply card appears under the
        // thread (operator, 2026-09-10: "that draft should pop up on the
        // left-hand side under the content of the email"). Anything wider
        // keeps its button, because a sweep is theirs to agree to.
        await runDraftFor(turn);
        await reviseOpenDraftFor(turn);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  /**
   * The draft proposal the panel runs itself, if this answer carries one for
   * the thread on screen. The button reads as working while it does and as
   * done afterwards, so the same turn read back later says what happened
   * rather than offering to do it again.
   */
  async function runDraftFor(turn: Turn) {
    const auto = autoRunsDraft(turn.actions, { threadId: lookingAt?.threadId ?? null, draftThreadId: latestDraft.current?.threadId ?? null });
    if (!auto) return;
    setDrafted((prev) => new Map(prev).set(turn.id, "running"));
    const r = await askDraftAction([auto.threadId], auto.action.instruction);
    if (!("draftIds" in r)) {
      setDrafted((prev) => {
        const next = new Map(prev);
        next.delete(turn.id);
        return next;
      });
      return setError(r.error);
    }
    setDrafted((prev) => new Map(prev).set(turn.id, r.draftIds));
    // The thread page shows the card, and the Drafts page takes the new draft
    // into its list; both are the server's to say again.
    router.refresh();
  }

  /**
   * A draft proposal for the thread whose card is already open, with the
   * operator's words in it (2026-09-14): the open draft is rewritten to say
   * them, the way a change asked for in this box does, and the answer
   * reads as applied. A second card of the same mail is never the answer.
   */
  async function reviseOpenDraftFor(turn: Turn) {
    const card = latestDraft.current;
    const revise = revisesOpenDraft(turn.actions, { draftThreadId: card?.threadId ?? null });
    if (!revise || !card) return;
    setDrafted((prev) => new Map(prev).set(turn.id, "running"));
    const before = card.text;
    const r = await reviseAction({ draftId: card.draftId, current: before, instruction: revise.instruction });
    setDrafted((prev) => {
      const next = new Map(prev);
      next.delete(turn.id);
      return next;
    });
    if (!r.ok) return setError(r.error);
    // The card may have moved on while the model wrote; it is read again.
    const now = latestDraft.current;
    if (!now || now.draftId !== card.draftId) return;
    now.apply(r.text);
    setApplied((prev) => new Set(prev).add(turn.id));
  }

  /**
   * One file into the conversation itself, when no draft is open. The chip
   * goes up first with what the browser knows about the file, and the row that
   * comes back replaces it; a refusal takes the chip off again, because a file
   * that is not there must not sit in a row Celeste is said to have read.
   */
  async function giveToChat(file: File): Promise<{ ok: true; filename: string } | { ok: false; error: string }> {
    if (!chatId) return { ok: false, error: "No conversation is open yet." };
    const pendingId = `pending-${Date.now()}-${file.name}`;
    setFiles((prev) => [...prev, { id: pendingId, filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size, uploading: true }]);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/files`, { method: "POST", body });
      const data = (await res.json()) as { id?: string; filename?: string; mimeType?: string; size?: number; error?: string };
      if (!res.ok || !data.id) {
        setFiles((prev) => prev.filter((f) => f.id !== pendingId));
        return { ok: false, error: data.error ?? `Could not give Celeste ${file.name}.` };
      }
      setFiles((prev) =>
        prev.map((f) =>
          f.id === pendingId ? { id: data.id!, filename: data.filename ?? file.name, mimeType: data.mimeType ?? f.mimeType, size: data.size ?? file.size } : f,
        ),
      );
      return { ok: true, filename: data.filename ?? file.name };
    } catch (err) {
      setFiles((prev) => prev.filter((f) => f.id !== pendingId));
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * A file dropped anywhere on the panel, or picked with the +. With a draft
   * open it goes onto that mail (spec 8, 2026-09-10); with none open it goes
   * to the conversation, where Celeste can read it (spec 10c, 2026-09-10, from
   * the operator: "cannot click on the plus button"). Either way she is then
   * asked what it is, so the operator can see she read the file rather than
   * being told she did.
   */
  async function tookFiles(list: FileList | null) {
    const target = latestDraft.current;
    setError(null);
    for (const file of Array.from(list ?? [])) {
      const r = target ? await target.attach(file) : await giveToChat(file);
      if (!r.ok) {
        setError(r.error);
        continue;
      }
      await ask(target ? attachedQuestion(r.filename) : gaveQuestion(r.filename), { auto: true });
    }
  }

  /** The × on a file chip: it comes off the conversation, and the bytes stay (spec 11a). */
  async function removeFile(id: string) {
    if (!chatId) return;
    const previous = files;
    setError(null);
    setFiles((prev) => prev.filter((f) => f.id !== id));
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/files?file=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        setFiles(previous);
        setError(((await res.json()) as { error?: string }).error ?? "Could not remove that file.");
      }
    } catch (err) {
      setFiles(previous);
      setError((err as Error).message);
    }
  }

  /**
   * "Attach to draft" on a chip: the file the operator already gave Celeste
   * goes onto the card. The card owns its own chip row and did not do this, so
   * it is asked to read its files again once the copy is written.
   */
  async function attachToDraft(file: PanelFile) {
    const card = latestDraft.current;
    if (!chatId || !card) return;
    setError(null);
    const r = await attachChatFileToDraftAction(chatId, file.id, card.draftId);
    if ("error" in r) return setError(r.error);
    card.reload();
  }

  function onDragEnter(ev: ReactDragEvent) {
    if (!draggingFiles(ev.dataTransfer?.types)) return;
    dragDepth.current++;
    setDragging(true);
  }

  function onDragLeave(ev: ReactDragEvent) {
    if (!draggingFiles(ev.dataTransfer?.types)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(ev: ReactDragEvent) {
    if (!draggingFiles(ev.dataTransfer?.types)) return;
    ev.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void tookFiles(ev.dataTransfer?.files ?? null);
  }

  // Which question each answer came from: an applied revision is written down
  // under the words that asked for it, so the draft's history reads back.
  const asked = new Map<string, string>();
  let latest = "";
  for (const turn of turns) {
    if (turn.role === "user") latest = turn.content;
    else asked.set(turn.id, latest);
  }

  return (
    <aside
      className="ask-panel"
      aria-label="Ask Celeste"
      onDragEnter={onDragEnter}
      onDragOver={(ev) => draggingFiles(ev.dataTransfer?.types) && ev.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className={`drop-veil${drop.accepts ? "" : " refuses"}`} aria-hidden="true">
          <span>{drop.label}</span>
        </div>
      )}
      <ResizeGrip />
      <div className="ask-head">
        <CelesteMark />
        <span className="ask-heading">
          <span className="ask-title">Ask Celeste</span>
          <span className="ask-subtitle">{loadingChat ? "…" : chatTitleLabel(chatTitle)}</span>
          {!loadingChat && spent ? <span className="ask-spent">{spent}</span> : null}
        </span>
        <span className="ask-head-actions">
          <button
            type="button"
            className="ask-close"
            onClick={() => setShowHistory((v) => !v)}
            aria-label="Conversation history"
            aria-pressed={showHistory}
            title="History"
          >
            <ClockIcon />
          </button>
          <button
            type="button"
            className="ask-close"
            onClick={() => {
              setShowHistory(false);
              setError(null);
              void newConversation();
            }}
            aria-label="New conversation"
            title="New conversation"
          >
            <NewChatIcon />
          </button>
          <button type="button" className="ask-close" onClick={close} aria-label="Close Ask Celeste">
            <CloseIcon />
          </button>
        </span>
      </div>
      {showHistory ? (
        <History
          onBack={() => setShowHistory(false)}
          onPick={(id) => {
            setShowHistory(false);
            setError(null);
            void openConversation(id);
          }}
          onDeleted={forgetConversation}
        />
      ) : (
        <>
        {/* Where the question goes (operator, 2026-09-14): General, or the
            thread on screen. One tap either way; the thread tab is the
            "Looking at" chip of before, and General is the chip cleared. */}
        {(() => {
          const tabs = askTabs({ onScreen, looking: Boolean(lookingAt || lookingAtDraft) });
          if (tabs.length === 0) return null;
          return (
            <div className="ask-tabs" role="tablist" aria-label="Conversation">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={t.active}
                  className={t.active ? "ask-tab on" : "ask-tab"}
                  title={t.key === "thread" ? `Ask about ${t.label}` : "Ask about anything"}
                  onClick={() => {
                    if (t.active) return;
                    setError(null);
                    if (t.key === "general") {
                      clearLookingAt();
                      clearLookingAtDraft();
                    } else {
                      resumeLookingAt();
                    }
                  }}
                >
                  {t.key === "thread" ? <ThreadTabIcon /> : null}
                  <span className="ask-tab-label">{t.label}</span>
                </button>
              ))}
            </div>
          );
        })()}
        <div className="ask-scroll" ref={scroller}>
          {turns.length === 0 && !loadingChat ? <p className="ask-empty">{askEmptyLine(askContext)}</p> : null}
          {turns.map((turn) =>
            turn.role === "user" ? (
              <div key={turn.id} className="ask-turn mine">
                <div className={`ask-bubble${turn.auto ? " ask-auto" : ""}`}>{turn.content}</div>
              </div>
            ) : (
              <AssistantTurn key={turn.id} turn={turn} question={asked.get(turn.id) ?? ""} applied={applied.has(turn.id)} drafted={drafted.get(turn.id)} />
            ),
          )}
          {pending ? (
            <div className="ask-turn celeste-turn">
              <CelesteMark />
              <div className="ask-bubble ask-thinking">Thinking…</div>
            </div>
          ) : null}
          {error ? <div className="error">{error}</div> : null}
        </div>
        {/* The files the operator has given this conversation, directly over
            the composer: openable, removable, and with a draft open each one
            can go onto that mail with a click of theirs (spec 10c). */}
        {chatId ? (
          <AskFiles chatId={chatId} files={files} draft={lookingAtDraft} onRemove={(id) => void removeFile(id)} onAttach={(f) => void attachToDraft(f)} />
        ) : null}
        <div className="ask-compose">
          {/* Operator, 2026-09-10: "a plus button in the chat bar where I can
              upload a file", and then "cannot click on the plus button" on a
              thread page. It is never dead now: the file goes where a drop
              would, onto the open draft or to Celeste herself. */}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void tookFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="ask-close ask-attach"
            onClick={() => fileInput.current?.click()}
            disabled={!chatId}
            aria-label={lookingAtDraft ? `Attach a file to the draft to ${lookingAtDraft.to[0] ?? "(nobody)"}` : "Give Celeste a file"}
            title={lookingAtDraft ? "Attach a file to the draft" : "Give Celeste a file"}
          >
            <PlusIcon />
          </button>
          {/* One line that grows with what is typed, up to a few lines, and
              an arrow to send it (operator, 2026-09-11: "smaller, and an
              arrow instead of Send"). */}
          <textarea
            ref={box}
            className="field ask-input"
            rows={1}
            value={question}
            placeholder={askPlaceholder({ draftThreadId: lookingAtDraft?.threadId ?? null })}
            onChange={(e) => {
              setQuestion(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (!sendsOnEnter(e)) return;
              e.preventDefault();
              void send();
            }}
          />
          <button
            type="button"
            className="ask-send"
            onClick={() => void send()}
            disabled={pending || !chatId || question.trim() === ""}
            aria-label={pending ? "Asking…" : "Send"}
            title={pending ? "Asking…" : "Send (Enter)"}
          >
            <ArrowUpIcon />
          </button>
        </div>
        </>
      )}
    </aside>
  );
}
