"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { celesteBlockFor, composeBlockFor, parseAddressList } from "@/lib/compose";
import { marked, toggleMark, type Mark } from "@/lib/marks";
import { composeDraftAction, draftWithCelesteAction } from "../actions";

export interface ComposeAccount {
  id: string;
  email: string;
  displayName: string | null;
}

/**
 * The composer (spec 2026-09-22): To, Cc, Subject and a body that takes the
 * same marks as a reply (see DraftCard), plus the one way in a reply never
 * needed — an account to send from, since there is no message to take it
 * from. Two ways out: typed by hand onto the queue, or filled from one line
 * told to Celeste and then read over before it goes anywhere.
 */
export function ComposeForm({ accounts }: { accounts: ComposeAccount[] }) {
  const router = useRouter();
  const [accountId, setAccountId] = useState(accounts.length === 1 ? accounts[0]!.id : "");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState("");
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

  function addToDrafts() {
    setAddError(undefined);
    setAddPending(true);
    void composeDraftAction({ accountId, to: toList, cc: ccList, subject, text, ...(model ? { model } : {}) })
      .then((r) => {
        if (!r.ok) {
          setAddError(r.error);
          setAddPending(false);
          return;
        }
        // Drafts is where every other draft goes to be sent (spec 2026-09-22):
        // this one belongs there too, not in a preview of its own.
        router.push("/drafts");
      })
      .catch((err) => {
        setAddError((err as Error).message);
        setAddPending(false);
      });
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
      <input id="compose-to" className="field" value={to} onChange={(e) => setTo(e.target.value)} placeholder="ana@example.com" />

      <label htmlFor="compose-cc">Cc</label>
      <input id="compose-cc" className="field" value={cc} onChange={(e) => setCc(e.target.value)} />

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

      {addError && <div className="error">Could not add to drafts: {addError}</div>}

      <div className="row draft-actions">
        <button type="button" className="btn primary" onClick={addToDrafts} disabled={addPending || Boolean(addBlock)} title={addBlock}>
          {addPending ? "Adding…" : "Add to Drafts"}
        </button>
        {addBlock && <span className="send-block">{addBlock}</span>}
      </div>
    </div>
  );
}
