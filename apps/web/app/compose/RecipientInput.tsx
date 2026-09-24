"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { RecipientSuggestion } from "@messaging-agent/core";
import { replaceToken, tokenAtCaret } from "@/lib/compose";
import { suggestRecipientsAction } from "../actions";

const DEBOUNCE_MS = 120;

/**
 * A `.field` that autofills as it is typed (operator, 2026-09-23: "the first
 * half of a contact name or email address" should suggest everyone the
 * account has mailed or heard from). To and Cc both hold a comma-separated
 * list; only the token under the caret is looked up and replaced, so
 * finishing one address never disturbs the others already on the line.
 */
export function RecipientInput({
  id,
  value,
  onChange,
  accountId,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  accountId: string;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RecipientSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const listboxId = useId();

  // A later query answering after this one would otherwise overwrite it
  // with stale matches (2026-09-23) — the id of the request in flight beats
  // any that lands after it.
  const requestId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function lookup(query: string) {
    if (timer.current) clearTimeout(timer.current);
    const mine = ++requestId.current;
    timer.current = setTimeout(() => {
      void suggestRecipientsAction(query, accountId).then((rows) => {
        if (mine !== requestId.current) return;
        setItems(rows);
        setActive(0);
        setOpen(rows.length > 0);
      });
    }, DEBOUNCE_MS);
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      // A reply still in flight when the field goes: moving the counter on
      // makes it land on nothing, the same way a stale one does.
      requestId.current += 1;
    },
    [],
  );

  function accept(row: RecipientSuggestion) {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? value.length;
    const next = replaceToken(value, caret, row.address);
    onChange(next.value);
    setOpen(false);
    setItems([]);
    // Nothing still in flight gets to reopen the list behind this pick.
    requestId.current++;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      // Enter while an input method is mid-composition belongs to the
      // candidate being committed, not to the list (review, 2026-09-23):
      // taking it would throw away a half-typed name.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      const row = items[active];
      if (!row) return;
      // Both stay in the field rather than one of them tabbing away: `accept`
      // refocuses the input a frame later, and letting Tab's default action
      // run first would only fight that (2026-09-23).
      e.preventDefault();
      accept(row);
    } else if (e.key === "Escape") {
      // Only the list closes here (2026-09-23) — a dialog this field one day
      // sits in listens for Escape on the document, and must still see it
      // when the list is not open to catch.
      e.stopPropagation();
      setOpen(false);
    }
  }

  const activeRow = open ? items[active] : undefined;

  return (
    <div className="recipient-box">
      <input
        id={id}
        ref={inputRef}
        className="field"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeRow ? `${listboxId}-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          const el = e.target;
          onChange(el.value);
          lookup(tokenAtCaret(el.value, el.selectionStart ?? el.value.length).query);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      {open && items.length > 0 ? (
        <ul id={listboxId} role="listbox" aria-label="Matching recipients" className="recipient-panel">
          {items.map((row, i) => {
            // "Other inbox" means other than the one being written from, so
            // it says nothing until one is chosen (2026-09-23).
            const note = row.count === 0 ? "Address book" : accountId && !row.onThisAccount ? "Other inbox" : null;
            return (
              <li
                key={row.address}
                id={`${listboxId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="recipient-row"
                // A mousedown on the row would otherwise blur the input first
                // and close the list before the click that follows can pick it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => accept(row)}
              >
                <span className="recipient-text">
                  <span className="recipient-label">{row.name ?? row.address}</span>
                  {row.name ? <span className="recipient-sub">{row.address}</span> : null}
                </span>
                {note ? (
                  <span className="hidden-tag" style={{ marginLeft: "auto", flexShrink: 0 }}>
                    {note}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
