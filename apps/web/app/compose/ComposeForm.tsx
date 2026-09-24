"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { celesteBlockFor, composeBlockFor, parseAddressList } from "@/lib/compose";
import { marked, toggleMark, type Mark } from "@/lib/marks";
import { composeDraftAction, draftWithCelesteAction, firstContactAction, skipAction } from "../actions";
import { RecipientInput } from "./RecipientInput";
import { SendPreviewDialog } from "../queue/SendPreviewDialog";
import { useSendGate } from "../queue/SendProvider";
import { SEND_DELAY_MS } from "@/lib/queue";
import type { DraftView } from "@messaging-agent/core";

export interface ComposeAccount {
  id: string;
  email: string;
  displayName: string | null;
}

/**
 * The composer (spec 2026-09-22): To, Cc, Subject and a body that takes the
 * same marks as a reply (see DraftCard), plus the one way in a reply never
 * needed — an account to send from, since there is no message to take it
 * from. Written by hand or filled from one line told to Celeste, and sent
 * from here (operator, 2026-09-23: "don't make two steps ... just have a
 * button that says Send"): the mail still becomes an ordinary draft, still
 * shows the same confirm card and the same first-contact warning, and still
 * leaves through the one gate with its six seconds to change your mind. The
 * only thing gone is the trip through the queue on the way.
 */
export function ComposeForm({ accounts }: { accounts: ComposeAccount[] }) {
  const router = useRouter();
  const [accountId, setAccountId] = useState(accounts.length === 1 ? accounts[0]!.id : "");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState("");
  // The draft as it stands once made, waiting on the confirm card.
  const [ready, setReady] = useState<DraftView | null>(null);
  const [firstContact, setFirstContact] = useState<string[] | "unknown" | null>(null);
  const gate = useSendGate();
  // Whichever model last filled the body, so the draft that lands in the
  // queue carries who wrote it the way a reply's `draft.model` always does;
  // "operator" once the box has only ever held the operator's own words.
  const [model, setModel] = useState<string | null>(null);

  const [celestePending, setCelestePending] = useState(false);
  const [celesteError, setCelesteError] = useState<string | undefined>(undefined);
  const [addPending, setAddPending] = useState(false);
  const [addError, setAddError] = useState<string | undefined>(undefined);

  const body = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState<[number, number]>([0, 0]);
  const grow = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useEffect(() => grow(body.current), [grow, text]);
  const activeMark = (mark: Mark) => marked(text, picked[0], picked[1], mark);
  function applyMark(mark: Mark) {
    const el = body.current;
    const [from, to] = el ? [el.selectionStart, el.selectionEnd] : picked;
    const next = toggleMark(text, from, to, mark);
    if (next.text === text) return;
    setText(next.text);
    setPicked([next.start, next.end]);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.start, next.end);
    });
  }

  const toList = parseAddressList(to);
  const ccList = parseAddressList(cc);
  const addBlock = composeBlockFor({ accountId, to: toList, cc: ccList, subject });
  const celesteBlock = celesteBlockFor(instruction);

  function draftWithCeleste() {
    setCelesteError(undefined);
    setCelestePending(true);
    void draftWithCelesteAction({ accountId, to: toList, cc: ccList, subject, instruction })
      .then((r) => {
        if (!r.ok) {
          setCelesteError(r.error);
          return;
        }
        setText(r.text);
        setModel(r.model);
      })
      .finally(() => setCelestePending(false));
  }

  /** Make the draft, then show it as it will arrive. Nothing has gone yet. */
  function review() {
    setAddError(undefined);
    setAddPending(true);
    setFirstContact(null);
    void composeDraftAction({ accountId, to: toList, cc: ccList, subject, text, ...(model ? { model } : {}) })
      .then((r) => {
        setAddPending(false);
        if (!r.ok) {
          setAddError(r.error);
          return;
        }
        setReady(r.view);
        // Who has never had mail from this account, for the warning on the
        // card. Send waits for this answer (spec 2026-09-22).
        void firstContactAction(accountId, [...toList, ...ccList])
          .then((list) => setFirstContact(list))
          .catch(() => setFirstContact("unknown"));
      })
      .catch((err) => {
        setAddError((err as Error).message);
        setAddPending(false);
      });
  }

  /** The button on the card: out through the same gate as every other send. */
  function sendItNow() {
    if (!ready) return;
    gate.send({ draftId: ready.draft.id, finalText: text, to: toList, cc: ccList, endsAt: Date.now() + SEND_DELAY_MS, item: ready });
    setReady(null);
    setFirstContact(null);
    // An empty composer, and the toast below carrying the six seconds.
    setTo("");
    setCc("");
    setSubject("");
    setText("");
    setInstruction("");
    setModel(null);
    router.refresh();
  }

  return (
    <div className="card compose-card" style={{ marginTop: 16 }}>
      <label htmlFor="compose-from">From</label>
      <select id="compose-from" className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
        <option value="" disabled>
          Pick an account…
        </option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
          </option>
        ))}
      </select>

      <label htmlFor="compose-to">To</label>
      <RecipientInput id="compose-to" value={to} onChange={setTo} accountId={accountId} placeholder="ana@example.com" />

      <label htmlFor="compose-cc">Cc</label>
      <RecipientInput id="compose-cc" value={cc} onChange={setCc} accountId={accountId} />

      <label htmlFor="compose-subject">Subject</label>
      <input id="compose-subject" className="field" value={subject} onChange={(e) => setSubject(e.target.value)} />

      <label htmlFor="compose-body">Body</label>
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
        id="compose-body"
        className="field draft-field"
        ref={body}
        onSelect={(e) => setPicked([e.currentTarget.selectionStart, e.currentTarget.selectionEnd])}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Typed over by hand, this is the operator's own words again.
          setModel(null);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "u")) {
            e.preventDefault();
            applyMark(e.key === "b" ? "bold" : "underline");
          }
        }}
      />

      <label htmlFor="compose-instruction">Draft with Celeste</label>
      <div className="row compose-celeste-row">
        <input
          id="compose-instruction"
          className="field"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Tell Celeste what this email should say"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !celesteBlock) {
              e.preventDefault();
              draftWithCeleste();
            }
          }}
        />
        <button type="button" className="btn" onClick={draftWithCeleste} disabled={celestePending || Boolean(celesteBlock)} title={celesteBlock}>
          {celestePending ? "Celeste is drafting…" : "Draft with Celeste"}
        </button>
      </div>
      {celesteError && <div className="error">{celesteError}</div>}

      {addError && <div className="error">Could not send: {addError}</div>}

      <div className="row draft-actions">
        <button type="button" className="btn primary" onClick={review} disabled={addPending || Boolean(addBlock)} title={addBlock}>
          {addPending ? "Preparing…" : "Send"}
        </button>
        {addBlock && <span className="send-block">{addBlock}</span>}
      </div>

      {ready && (
        <SendPreviewDialog
          view={ready}
          text={text}
          to={toList}
          cc={ccList}
          files={[]}
          firstContact={firstContact}
          onSend={sendItNow}
          onClose={() => {
            // Closed rather than sent: the words are still in the composer,
            // so the row made a moment ago is let go rather than left in the
            // queue. Send, look, close, fix a typo, Send again used to leave
            // one behind every time, each of them counted beside the drafts
            // that are really waiting (review, 2026-09-23).
            const abandoned = ready.draft.id;
            setReady(null);
            setFirstContact(null);
            void skipAction(abandoned).finally(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}
