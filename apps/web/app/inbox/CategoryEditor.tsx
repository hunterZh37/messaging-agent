"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { resortImportantAction, saveCategoriesAction } from "./actions";
import { EditorRows } from "./EditorRows";

export interface EditorCategory {
  id?: string;
  name: string;
  description: string;
}

/**
 * The sub-category editor, opened below the inbox chip rows by the Edit
 * chip (`?edit=1`). One Save writes the whole ordered list, so adding,
 * renaming, reordering, and removing are one decision, not four.
 */
export function CategoryEditor({ categories, closeHref }: { categories: EditorCategory[]; closeHref: string }) {
  const [rows, setRows] = useState<EditorCategory[]>(categories);
  const [error, setError] = useState<string | null>(null);
  const [resorted, setResorted] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [resorting, startResorting] = useTransition();
  const router = useRouter();

  const close = useCallback(() => {
    router.push(closeHref);
  }, [router, closeHref]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  function update(i: number, patch: Partial<EditorCategory>) {
    setRows(rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  }

  function onSave() {
    setError(null);
    startSaving(async () => {
      const r = await saveCategoriesAction(rows);
      if (r && "error" in r) {
        setError(r.error);
        return;
      }
      close();
    });
  }

  function onResort() {
    setError(null);
    setResorted(null);
    startResorting(async () => {
      const r = await resortImportantAction();
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setResorted(r.resorted === 1 ? "1 message re-sorted" : `${r.resorted} messages re-sorted`);
      router.refresh();
    });
  }

  return (
    <div className="cat-editor">
      <div className="meta">
        <span>Celeste files every important message under exactly one of these. Order is priority.</span>
      </div>

      <EditorRows
        rows={rows}
        onChange={setRows}
        noun="sub-category"
        namePlaceholder="Name"
        descriptionPlaceholder="What kind of mail belongs here?"
        nameMaxLength={40}
      />

      {error ? <div className="error">{error}</div> : null}

      <div className="row">
        <button type="button" className="btn quiet" onClick={() => setRows([...rows, { name: "", description: "" }])}>
          Add category
        </button>
        <button type="button" className="btn primary" onClick={onSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div className="row">
        <button type="button" className="btn quiet" onClick={onResort} disabled={resorting}>
          {resorting ? "Re-sorting…" : "Re-sort important mail"}
        </button>
        {resorted ? <span className="meta">{resorted}</span> : null}
      </div>
    </div>
  );
}
