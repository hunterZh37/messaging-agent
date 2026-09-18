"use client";

import { useState, type ReactNode } from "react";
import { DESCRIPTION_MAX, DESCRIPTION_WARN, dropIndex, move } from "@/lib/categories";

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="6" r="1.4" />
      <circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" />
      <circle cx="15" cy="18" r="1.4" />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export interface EditorRow {
  name: string;
  description: string;
}

/**
 * The rows both editors share: a name, a description, and one button. Order
 * is priority, so it has to be changeable, but a pair of arrows per row is
 * three buttons where the operator asked for one — the row is dragged by its
 * grip instead, and Alt with an arrow key does the same thing for a keyboard.
 * Which half of a row the pointer is over decides above or below, so a drop
 * lands where the line was drawn.
 */
export function EditorRows<T extends EditorRow>(props: {
  rows: T[];
  onChange: (rows: T[]) => void;
  /** What one of these is called, for the labels a screen reader reads. */
  noun: string;
  namePlaceholder: string;
  descriptionPlaceholder: string;
  nameMaxLength: number;
  /** Something more on each row, before its remove button: the project's group, say (2026-09-15). */
  extra?: (row: T, update: (patch: Partial<T>) => void) => ReactNode;
}) {
  const { rows, onChange, noun } = props;
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<{ index: number; below: boolean } | null>(null);

  function update(i: number, patch: Partial<T>) {
    onChange(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  }

  function drop(from: number, target: { index: number; below: boolean }) {
    onChange(move(rows, from, dropIndex(from, target.index, target.below)));
    setDragging(null);
    setOver(null);
  }

  function onGripKey(event: React.KeyboardEvent, i: number) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const to = event.key === "ArrowUp" ? i - 1 : i + 1;
    if (to < 0 || to >= rows.length) return;
    onChange(move(rows, i, to));
  }

  return (
    <>
      {rows.map((row, i) => (
        <div
          key={i}
          className={`cat-row${dragging === i ? " dragging" : ""}${over?.index === i ? (over.below ? " drop-below" : " drop-above") : ""}`}
          draggable={dragging === i}
          onDragStart={(event) => event.dataTransfer.setData("text/plain", String(i))}
          onDragEnd={() => {
            setDragging(null);
            setOver(null);
          }}
          onDragOver={(event) => {
            if (dragging === null) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            setOver({ index: i, below: event.clientY > box.top + box.height / 2 });
          }}
          onDrop={(event) => {
            event.preventDefault();
            const from = Number(event.dataTransfer.getData("text/plain"));
            if (Number.isInteger(from) && over) drop(from, over);
          }}
        >
          <span
            className="row-grip"
            role="button"
            tabIndex={0}
            aria-label={`Reorder ${row.name || noun}. Drag to reorder, or Alt+Arrow keys`}
            onMouseDown={() => setDragging(i)}
            onMouseUp={() => setDragging(null)}
            onKeyDown={(event) => onGripKey(event, i)}
          >
            <GripIcon />
          </span>
          <input
            className="field"
            maxLength={props.nameMaxLength}
            value={row.name}
            placeholder={props.namePlaceholder}
            aria-label={`${noun} name`}
            onChange={(e) => update(i, { name: e.target.value } as Partial<T>)}
          />
          <input
            className="field"
            maxLength={DESCRIPTION_MAX}
            value={row.description}
            placeholder={props.descriptionPlaceholder}
            aria-label={`${noun} description`}
            onChange={(e) => update(i, { description: e.target.value } as Partial<T>)}
          />
          {/* Only once the ceiling is close enough to matter. */}
          {row.description.length > DESCRIPTION_WARN ? (
            <span className="row-count">{`${row.description.length}/${DESCRIPTION_MAX}`}</span>
          ) : null}
          {props.extra ? props.extra(row, (patch) => update(i, patch)) : null}
          <button
            type="button"
            className="btn quiet icon-only"
            aria-label={`Remove ${row.name || noun}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <RemoveIcon />
          </button>
        </div>
      ))}
    </>
  );
}
