"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import type { DraftView } from "@messaging-agent/core";
import { markupSpans } from "@messaging-agent/core/text";
import { CelesteMark } from "./CelesteMark";
import { draggingFiles, dropTargetLabel } from "@/lib/attachments";
import { formatTime, sendBlockFor, shortAccount } from "@/lib/format";
import { popRevision, pushRevision } from "@/lib/queue";
import { changeCount, wordDiff } from "@/lib/diff";
import { marked, toggleMark, type Mark } from "@/lib/marks";
import { firstContactAction, listDraftAttachmentsAction } from "../actions";
import { TrashIcon } from "../inbox/icons";
import { ContextDraftCard, type AttachResult } from "../ask/AskProvider";
import { ClipIcon } from "./AttachmentPreview";
import { DraftAttachmentChips, type CardFile } from "./DraftAttachments";
import { SendPreviewDialog } from "./SendPreviewDialog";
import { Thread } from "./Thread";
import { ChannelIcon } from "../inbox/icons";

export type CardMode = "view" | "edit" | "confirm";


function parseList(s: string): string[] {
  return s.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}


export function DraftCard(props: {
  view: DraftView;
  mode: CardMode;
  setMode: (m: CardMode) => void;
  error: string | undefined;
  initialEdit: { text: string; to: string[]; cc: string[] } | undefined;
  onConfirm: (finalText: string, to: string[], cc: string[]) => void;
  /** Delete the draft (2026-09-14), with the text, To and Cc as they stand, for its Undo. */
  onSkip: (current: { text: string; to: string[]; cc: string[] }) => void;
  remaining: number;
  /**
   * The thread the draft answers, above the fields. False on the thread page,
   * where the same mail is already on screen above this card (spec 10a,
   * 2026-09-10): with it goes the rest of what that page has said once
   * already — the account line, the subject and Celeste's sorting reason — so
   * the reply card is the reply and nothing else.
   */
  showThread?: boolean;
}) {
  const { view, setMode } = props;
  // A text (2026-09-11): one person, no Cc, no subject, no files this phase.
  const isText = view.account.provider === "imessage" || view.account.provider === "whatsapp";
  const showThread = props.showThread !== false;
  const [text, setText] = useState(props.initialEdit?.text ?? view.draft.originalText);
  // What is selected in the body, kept so the B and U buttons act on it: a
  // press on a button takes the focus off the textarea, and the selection
  // with it, unless it is held here (mousedown is prevented too).
  const body = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState<[number, number]>([0, 0]);

  /**
   * The field is as tall as the draft (operator, 2026-09-20). A fixed box was
   * fine while editing was a thing you stepped into; now that the body is
   * always the field, a fixed box would crop every draft by default and hide
   * the sign off behind a scrollbar.
   */
  const grow = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(() => {
    grow(body.current);
  }, [grow, text]);
  const activeMark = (mark: Mark) => marked(text, picked[0], picked[1], mark);
  function applyMark(mark: Mark) {
    const el = body.current;
    const [from, to] = el ? [el.selectionStart, el.selectionEnd] : picked;
    const next = toggleMark(text, from, to, mark);
    if (next.text === text) return;
    setText(next.text);
    setRevisedFrom(null);
    setPicked([next.start, next.end]);
    // After React has painted the new value, or the selection lands in the
    // old string and the operator is left with the cursor somewhere else.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.start, next.end);
    });
  }
  const [to, setTo] = useState((props.initialEdit?.to ?? view.draft.toAddresses).join(", "));
  const [cc, setCc] = useState((props.initialEdit?.cc ?? view.draft.ccAddresses).join(", "));
  // Celeste's rewrites land here from the Ask panel (spec 10c; the card's
  // own revise field went on 2026-09-14, one place to talk to her). The stack
  // holds the text each rewrite replaced, so Undo walks back through them; it
  // lives on the open card, because what gets sent is whatever text is on
  // the card at the time.
  const [undoStack, setUndoStack] = useState<string[]>([]);
  // What the last revision changed, shown on the draft until the operator
  // types or takes it back (operator, 2026-09-11: a one-word fix looked
  // like nothing had happened).
  const [revisedFrom, setRevisedFrom] = useState<string | null>(null);
  // The files going out with this reply (spec 8, 2026-09-10). Client state,
  // like the text: a chip is on the card the moment a file is dropped, before
  // the server has said anything back.
  const [files, setFiles] = useState<CardFile[]>(() =>
    view.attachments.map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size })),
  );
  const [attachError, setAttachError] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  // dragenter and dragleave fire for every child the pointer crosses, so the
  // overlay counts its way in and out rather than flickering off over a field.
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement | null>(null);
  const edited = text !== view.draft.originalText;
  const toList = parseList(to);
  const ccList = parseList(cc);
  // Why Send is held back, if it is (stress audit, 2026-09-11): nothing goes
  // out to nobody, to an address that cannot be one, or with nothing in it.
  // The same reason gates the preview dialog, because the s key opens it
  // without passing through the button.
  const sendBlock = sendBlockFor(text, toList, ccList, isText ? "text" : "mail");
  const revision = (() => {
    if (revisedFrom === null || revisedFrom === text) return null;
    const parts = wordDiff(revisedFrom, text);
    return { parts, count: changeCount(parts) };
  })();
  // A confirm the card cannot honour (the s key asked for it while Send is
  // held back) reads as editing, so the reason shows and the fields stay live.
  const mode: CardMode = props.mode === "confirm" && sendBlock ? "edit" : props.mode;
  const settled = files.filter((f) => !f.uploading);
  const drop = dropTargetLabel({ to: toList });

  // Who on a composed draft has never had mail from this account (spec
  // 2026-09-22): asked for only at the confirm dialog, and only for a
  // composed draft — a reply is implicitly safe, the other side wrote first.
  const composed = view.draft.mode === "new";
  // null while the answer is still coming: the dialog holds Send until it is
  // here, so the warning cannot be missed by sending in the first frame
  // (review, 2026-09-22). "unknown" when the check itself failed.
  const [firstContactList, setFirstContactList] = useState<string[] | "unknown" | null>(null);
  useEffect(() => {
    if (mode !== "confirm" || !composed) {
      setFirstContactList(null);
      return;
    }
    let cancelled = false;
    void firstContactAction(view.account.id, [...toList, ...ccList])
      .then((list) => {
        if (!cancelled) setFirstContactList(list);
      })
      .catch(() => {
        // Say so rather than letting silence read as "nobody is new".
        if (!cancelled) setFirstContactList("unknown");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, composed, view.account.id, to, cc]);

  // Celeste's wording, applied from the Ask panel (spec 10c, 2026-09-10),
  // with Undo behind it. Its identity never changes, or registering the card
  // with the panel would run on every render.
  const applyLatest = useRef((_next: string) => {});
  applyLatest.current = (next: string) => {
    setUndoStack((stack) => pushRevision(stack, text));
    setText(next);
    setRevisedFrom(text);
  };
  const applyFromAsk = useCallback((next: string) => applyLatest.current(next), []);

  /**
   * One file onto this draft. The chip goes up first with what the browser
   * knows about the file, and the row that comes back replaces it; a refusal
   * takes the chip off again and says why, because a file that is not there
   * must not look attached on the screen the operator sends from.
   *
   * Held in a ref for the same reason `apply` is: the panel registers this
   * card once, and re-registering on every keystroke would be work for
   * nothing.
   */
  const attachLatest = useRef(async (_file: File): Promise<AttachResult> => ({ ok: false, error: "" }));
  attachLatest.current = async (file: File): Promise<AttachResult> => {
    const pendingId = `pending-${Date.now()}-${file.name}`;
    setAttachError(undefined);
    setFiles((prev) => [...prev, { id: pendingId, filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size, uploading: true }]);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/drafts/${encodeURIComponent(view.draft.id)}/attachments`, { method: "POST", body });
      const data = (await res.json()) as { id?: string; filename?: string; mimeType?: string; size?: number; error?: string };
      if (!res.ok || !data.id) {
        setFiles((prev) => prev.filter((f) => f.id !== pendingId));
        const error = data.error ?? `Could not attach ${file.name}.`;
        setAttachError(error);
        return { ok: false, error };
      }
      setFiles((prev) =>
        prev.map((f) =>
          f.id === pendingId
            ? { id: data.id!, filename: data.filename ?? file.name, mimeType: data.mimeType ?? f.mimeType, size: data.size ?? file.size }
            : f,
        ),
      );
      return { ok: true, filename: data.filename ?? file.name };
    } catch (err) {
      setFiles((prev) => prev.filter((f) => f.id !== pendingId));
      const error = (err as Error).message;
      setAttachError(error);
      return { ok: false, error };
    }
  };
  const attachFromAsk = useCallback((file: File) => attachLatest.current(file), []);

  /**
   * The chip row, painted again from the database. The Ask panel can put a
   * file the operator gave Celeste onto this draft, and the card that owns the
   * chips never saw it happen (spec 10c, 2026-09-10). A file still going up is
   * kept: the server does not know about it yet, and dropping its chip would
   * make an upload in flight look like it failed.
   */
  const reloadFromAsk = useCallback(() => {
    void listDraftAttachmentsAction(view.draft.id).then((rows) => {
      setFiles((prev) => [...rows, ...prev.filter((f) => f.uploading)]);
    });
  }, [view.draft.id]);

  /** The × on a chip. The file comes off the draft; the bytes on disk are shared and stay. */
  async function removeFile(id: string) {
    const previous = files;
    setAttachError(undefined);
    setFiles((prev) => prev.filter((f) => f.id !== id));
    try {
      const res = await fetch(`/api/drafts/${encodeURIComponent(view.draft.id)}/attachments?attachment=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        setFiles(previous);
        setAttachError(((await res.json()) as { error?: string }).error ?? "Could not remove that file.");
      }
    } catch (err) {
      setFiles(previous);
      setAttachError((err as Error).message);
    }
  }

  async function attachAll(list: FileList | File[] | null) {
    for (const file of Array.from(list ?? [])) await attachLatest.current(file);
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
    void attachAll(ev.dataTransfer?.files ?? null);
  }

  function undoRevision() {
    const { text: previous, stack } = popRevision(undoStack);
    if (previous === undefined) return;
    setUndoStack(stack);
    setText(previous);
    setRevisedFrom(null);
  }

  return (
    <div
      className={`draft-drop${dragging ? " over" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={(ev) => draggingFiles(ev.dataTransfer?.types) && ev.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* A file dragged anywhere over the card lands on this draft. The
          overlay names who it would go to, so the operator can see what they
          are about to attach it to before they let go (spec 8, 2026-09-10). */}
      {dragging && (
        <div className="drop-veil" aria-hidden="true">
          <span>{drop.label}</span>
        </div>
      )}
      {/* What Celeste is looking at while this card is open: the text as it
          stands, edits and revisions included, and the way back onto it. */}
      <ContextDraftCard
        draftId={view.draft.id}
        // A composed draft has no thread to key Ask Celeste's conversation on
        // (2026-09-22): the draft's own id stands in for one, since it is
        // just as stable and just as unique to this card.
        threadId={view.replyTo?.threadId ?? view.draft.id}
        subject={view.replyTo?.subject ?? view.draft.subject ?? ""}
        to={toList}
        cc={ccList}
        text={text}
        apply={applyFromAsk}
        attach={attachFromAsk}
        reload={reloadFromAsk}
      />
      {showThread && (
        <>
          <div className="meta">
            <ChannelIcon provider={view.account.provider} />
            <span>{shortAccount(view.account.email)}</span>
            <span>·</span>
            {/* A composed message answers nobody (2026-09-22): there is no
                sender to name, only when Celeste wrote the card. */}
            {view.replyTo ? (
              <>
                <span>{view.replyTo.fromName ?? view.replyTo.fromAddress}</span>
                <span>·</span>
                <span>{formatTime(view.replyTo.sentAt)}</span>
              </>
            ) : (
              <span>{formatTime(view.draft.createdAt)}</span>
            )}
            <span style={{ marginLeft: "auto" }}>{props.remaining} in queue</span>
          </div>
          <h1>
            {isText
              ? `Text from ${view.replyTo?.fromName ?? view.replyTo?.fromAddress}`
              : view.replyTo
                ? view.replyTo.subject || "(no subject)"
                : view.draft.subject || "(no subject)"}
          </h1>
          {view.sort && (
            <div className="reason">
              <CelesteMark />
              <span>{view.sort.reason}</span>
            </div>
          )}
        </>
      )}

      <div className="card">
        {/* No thread above a composed draft's box (2026-09-22): it began the
            conversation, so there is nothing above it to show. */}
        {showThread && view.replyTo && <Thread messages={view.thread} initialExpandedId={view.replyTo.id} />}

        <label>To</label>
        <input className="field" value={to} onChange={(e) => setTo(e.target.value)} disabled={mode === "confirm" || isText} />
        {isText ? null : (
          <>
            <label>Cc</label>
            <input className="field" value={cc} onChange={(e) => setCc(e.target.value)} disabled={mode === "confirm"} />
          </>
        )}

        {/* The files going out with the reply, under the recipients they go
            to. A chip of a type that renders opens the file underneath it,
            so a PDF can be read before it is sent. The paperclip is the way
            in for anyone who would rather pick a file than drag one. */}
        <DraftAttachmentChips draftId={view.draft.id} files={files} onRemove={mode === "confirm" ? undefined : (id) => void removeFile(id)}>
          {mode !== "confirm" && !isText && (
            <>
              <button type="button" className="chip att-add" onClick={() => picker.current?.click()} aria-label="Attach a file">
                <ClipIcon />
                <span>Attach</span>
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  void attachAll(e.target.files);
                  // Cleared, or picking the same file twice in a row is silent.
                  e.target.value = "";
                }}
              />
            </>
          )}
        </DraftAttachmentChips>

        <label>
          {/* A composed mail the operator typed themselves is theirs, and
              saying "Celeste draft" over it would claim work she never did
              (2026-09-22). Her mark returns the moment she writes it. */}
          {view.draft.mode === "new" && view.draft.model === "operator" ? (
            <span className="celeste-none">Your email</span>
          ) : (
            <CelesteMark suffix={isText ? "text" : view.draft.mode === "follow-up" ? "follow-up" : view.draft.mode === "new" ? "email" : "draft"} />
          )}
          {revision ? ` · revised, ${revision.count === 1 ? "1 change" : `${revision.count} changes`}` : edited ? " · edited" : ""}
          {/* The text a rewrite replaced waits behind this, a stack ten deep. */}
          {undoStack.length > 0 && mode !== "confirm" && (
            <>
              {" · "}
              <button type="button" className="link-btn" onClick={undoRevision}>
                Undo
              </button>
            </>
          )}
        </label>
        {mode !== "confirm" ? (
          <>
          {/* Bold and underline, on the text rather than in a second column:
              the draft stays one string, so revise, the undo stack and the
              change diff go on reading it the way they always have. The
              marks show while editing and the card draws them once the
              editing stops (operator, 2026-09-20). */}
          <div className="draft-marks">
            <button type="button" className={`mark-btn${activeMark("bold") ? " on" : ""}`} title="Bold the selection" aria-label="Bold the selection" onMouseDown={(e) => e.preventDefault()} onClick={() => applyMark("bold")}>
              <b>B</b>
            </button>
            <button type="button" className={`mark-btn${activeMark("underline") ? " on" : ""}`} title="Underline the selection" aria-label="Underline the selection" onMouseDown={(e) => e.preventDefault()} onClick={() => applyMark("underline")}>
              <u>U</u>
            </button>
            <span className="draft-marks-hint">Select a word, then bold it</span>
          </div>
          <textarea
            className="field draft-field"
            ref={body}
            onSelect={(e) => setPicked([e.currentTarget.selectionStart, e.currentTarget.selectionEnd])}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setRevisedFrom(null);
            }}
            // Nothing to leave: the field is the draft, and clicking away
            // puts the cursor somewhere else rather than putting the field
            // away (operator, 2026-09-20: "the input box itself should just
            // be editable").
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.blur();
              // The shortcuts every mail client has. Without them the buttons
              // would be the only way, and a hand already on the keyboard
              // would have to reach for the mouse to bold one word.
              if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "u")) {
                e.preventDefault();
                applyMark(e.key === "b" ? "bold" : "underline");
              }
            }}
          />
          </>
        ) : (
          <div className="draft">
            {revision
              ? revision.parts.map((p, i) =>
                  p.kind === "same" ? <span key={i}>{p.text}</span> : p.kind === "ins" ? <mark key={i} className="rev-ins">{p.text}</mark> : <del key={i} className="rev-del">{p.text}</del>,
                )
              : markupSpans(text).map((span, i) =>
                  span.bold ? <strong key={i}>{span.text}</strong> : span.underline ? <u key={i}>{span.text}</u> : <span key={i}>{span.text}</span>,
                )}
          </div>
        )}

        {props.error && <div className="error">Send failed: {props.error}</div>}
        {attachError && <div className="error">{attachError}</div>}

        {mode !== "confirm" && (
          <div className="row draft-actions">
            <button type="button" className="btn primary" onClick={() => setMode("confirm")} disabled={sendBlock !== undefined} title={sendBlock}>
              {edited ? "Send edited" : "Send"}<kbd>s</kbd>
            </button>
            {sendBlock && <span className="send-block">{sendBlock}</span>}
            {/* No Edit and no Done (operator, 2026-09-11, then 2026-09-20):
                the body is editable where it stands, so the text is the draft
                as it is, and Send takes it. */}
            {/* "Delete draft", not Skip (operator, 2026-09-14): the same act,
                named for what it does. Not a bare "Delete": on a thread the
                row below has one, and it deletes the whole thread. */}
            <button type="button" className="btn quiet" onClick={() => props.onSkip({ text, to: toList, cc: ccList })}>
              <TrashIcon />
              Delete draft<kbd>x</kbd>
            </button>
          </div>
        )}

      </div>

      {/* The gate before a send is the mail itself, over the page, rather
          than a panel inside the card showing a diff (spec 8, 2026-09-10). */}
      {mode === "confirm" && (
        <SendPreviewDialog
          view={view}
          channel={isText ? "text" : "mail"}
          text={text}
          to={toList}
          cc={ccList}
          files={settled}
          firstContact={composed ? firstContactList : null}
          onSend={() => props.onConfirm(text, toList, ccList)}
          onClose={() => setMode("view")}
        />
      )}
    </div>
  );
}
