export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Line-level LCS diff. Small inputs only (a draft is a few dozen lines). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/**
 * What a revision changed, word by word (operator, 2026-09-11: "I feel like
 * Celeste revise doesn't work", on a revision that had added one word). The
 * card marks the words that came in and strikes the ones that went, so a
 * small correct change is seen rather than taken for nothing.
 */
export type DiffPart = { kind: "same" | "ins" | "del"; text: string };

/** Words and the whitespace between them, so the marks land on words alone. */
function tokens(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  // Longest common subsequence over tokens; a mail is a few hundred words,
  // so the table is small.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push("del", a[i]!);
      i++;
    } else {
      push("ins", b[j]!);
      j++;
    }
  }
  while (i < n) push("del", a[i++]!);
  while (j < m) push("ins", b[j++]!);
  // A space the two sides happen to share in the middle of a change would
  // split one change into two; it goes with the words that follow it.
  const folded: DiffPart[] = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]!;
    const prev = folded[folded.length - 1];
    const next = parts[k + 1];
    if (p.kind === "same" && p.text.trim() === "" && prev && prev.kind !== "same" && next && next.kind !== "same") {
      next.text = p.text + next.text;
      continue;
    }
    if (prev && prev.kind === p.kind) prev.text += p.text;
    else folded.push({ ...p });
  }
  return folded;
}

/** How many separate places a revision touched. */
export function changeCount(parts: DiffPart[]): number {
  let count = 0;
  let inChange = false;
  for (const p of parts) {
    if (p.kind === "same") inChange = false;
    else if (!inChange) {
      count++;
      inChange = true;
    }
  }
  return count;
}
