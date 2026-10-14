import { contentDisposition } from "./disposition";

/**
 * The only content types the attachments route will ever serve with the
 * sender's own MIME type. Everything else, `image/svg+xml` and `text/html`
 * included, goes out as `application/octet-stream` with a download
 * disposition, so an attachment can never execute inside the app's origin
 * (spec 11a). The thread view previews exactly this list.
 */
export const PREVIEWABLE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "image/heic", "image/heif"] as const;

/** An iPhone photo (most iMessage pictures, 2026-09-11): browsers cannot show it, so the route converts it to JPEG for a preview. */
export function needsJpegConversion(mimeType: string, filename: string): boolean {
  const m = mimeType.toLowerCase();
  return m === "image/heic" || m === "image/heif" || /\.hei[cf]$/i.test(filename);
}

export function isPreviewable(mimeType: string): boolean {
  return (PREVIEWABLE_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

export function isPdf(mimeType: string): boolean {
  return mimeType.toLowerCase() === "application/pdf";
}

/**
 * Response headers for one attachment's bytes.
 *
 * The disposition decides everything else. An inline response is one of the
 * five types a browser renders natively, so it carries no CSP at all: the
 * page-level policy would otherwise reach Chrome's built-in PDF viewer and
 * leave the operator staring at a blank frame. `nosniff` still pins the type
 * to the one we chose. A download response can be any type at all, so it goes
 * out as octet-stream under `default-src 'none'`.
 */
export function attachmentHeaders(p: { mimeType: string; filename: string; size: number; forceDownload: boolean }): Record<string, string> {
  const inline = !p.forceDownload && isPreviewable(p.mimeType);
  return {
    "Content-Type": inline ? p.mimeType : "application/octet-stream",
    "Content-Length": String(p.size),
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", p.filename),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=3600",
    ...(inline ? {} : { "Content-Security-Policy": "default-src 'none'" }),
  };
}

/** Attachment sizes as a chip shows them: `812 B`, `12 KB`, `1.4 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Where the bytes of a file on a draft come from. `download` forces the save
 * dialog for a type that would otherwise render in place (spec 8, 2026-09-10).
 */
export function draftAttachmentHref(draftId: string, attachmentId: string, download: boolean): string {
  const base = `/api/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`;
  return download ? `${base}?download=1` : base;
}

/**
 * What one file on a draft says beside its name: its size once it is there,
 * and what is happening to it while it is not (spec 8, 2026-09-10).
 */
export function draftAttachmentSizeLabel(file: { size: number; uploading?: boolean }): string {
  return file.uploading ? "attaching…" : formatSize(file.size);
}

/**
 * What a drop target says while a file is over it. With a draft open it names
 * who the file would go to, so dropping on the Ask panel and dropping on the
 * card are visibly the same act; with none open the file goes to the
 * conversation, where Celeste can read it (spec 10c, 2026-09-10). Operator,
 * 2026-09-10: "cannot click on the plus button" — a drop is never refused
 * now, it only lands in one place or the other, and the overlay says which.
 */
export function dropTargetLabel(draft: { to: string[] } | null | undefined): { accepts: boolean; label: string } {
  if (!draft) return { accepts: true, label: "Drop to give Celeste this file" };
  return { accepts: true, label: `Drop to attach to the draft to ${draft.to[0] ?? "(nobody)"}` };
}

/**
 * Where the bytes of a file in a conversation come from, under the same rules
 * a draft's file is served by: `download` forces the save dialog for a type
 * that would otherwise render in place (spec 10c, 2026-09-10).
 */
export function chatFileHref(chatId: string, fileId: string, download: boolean): string {
  const base = `/api/chats/${encodeURIComponent(chatId)}/files/${encodeURIComponent(fileId)}`;
  return download ? `${base}?download=1` : base;
}

/**
 * The button on a conversation's file chip, when a draft is open in the same
 * thread (spec 10c, 2026-09-10). It names who the mail goes to, so it can
 * never be read as sending: this puts the file on the card, and Send is still
 * the operator's own separate act. With no draft open there is no button.
 */
export function attachToDraftLabel(draft: { to: string[] } | null | undefined): { label: string; title: string } | null {
  if (!draft) return null;
  return { label: "Attach to draft", title: `Attach it to the draft to ${draft.to[0] ?? "(nobody)"}` };
}

/** Is this drag carrying files, rather than selected text or a link? */
export function draggingFiles(types: readonly string[] | undefined): boolean {
  return (types ?? []).includes("Files");
}

/**
 * The question a drop asks on the operator's behalf, so the confirmation that
 * Celeste read the file is a real answer rather than a claim by the app.
 */
export function attachedQuestion(filename: string): string {
  return `I attached ${filename} to the draft. What is it, in one line, and does it fit the thread?`;
}

/**
 * The same, for a file given to the conversation rather than to a draft
 * (spec 10c, 2026-09-10). There is no mail in the question because there is
 * no mail yet: the operator handed her a file and wants to know she read it.
 */
export function gaveQuestion(filename: string): string {
  return `I gave you ${filename}. What is it, in one line?`;
}

/**
 * The short label on an attachment tile: the file's kind in capitals (PDF,
 * PNG, DOCX), or "FILE" when the name gives nothing away. Operator,
 * 2026-09-10: "make the attachment look more obvious".
 */
export function fileKind(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filename.trim());
  return m ? m[1]!.toUpperCase() : "FILE";
}

/** The limits core enforces too (`draft/attachments.ts`), checked here so a drop is answered at once. */
export const MAX_COMPOSE_FILES = 10;
export const MAX_COMPOSE_FILE_BYTES = 25 * 1024 * 1024;

/** A file the composer would not take, and the reason in words a person would use. */
export interface RefusedFile {
  name: string;
  why: string;
}

/**
 * Which of these files the Compose page will carry (operator, 2026-10-14: "how
 * can I attach file here?" — it could not).
 *
 * Compose holds its files in the browser until Send, because a draft cannot
 * exist before there is a recipient and a subject and nothing else on that
 * page is written down before Send either. So this is the only check between
 * the drop and a provider's refusal, and it has to answer immediately and in
 * full: every refusal names its file, because a file that silently fails to
 * attach is discovered by the person who did not receive it.
 *
 * Counted against what is already held, not against the drop alone — ten files
 * dropped one at a time is still eleven if one was there first.
 */
export function takeFiles<T extends { name: string; size: number }>(
  held: readonly { name: string; size: number }[],
  incoming: readonly T[],
): { accepted: T[]; refused: RefusedFile[] } {
  const accepted: T[] = [];
  const refused: RefusedFile[] = [];
  for (const file of incoming) {
    // Zero bytes is a folder far more often than it is a file, and a folder
    // dropped on a mail is a mistake worth saying out loud.
    if (file.size === 0) {
      refused.push({ name: file.name, why: "empty" });
      continue;
    }
    if (file.size > MAX_COMPOSE_FILE_BYTES) {
      refused.push({ name: file.name, why: "larger than 25 MB" });
      continue;
    }
    if (held.length + accepted.length >= MAX_COMPOSE_FILES) {
      refused.push({ name: file.name, why: `more than ${MAX_COMPOSE_FILES} files` });
      continue;
    }
    accepted.push(file);
  }
  return { accepted, refused };
}

/**
 * What to say about the ones that did not go on. One file is named with its
 * reason, because that is what they can act on; several are counted, because a
 * toast listing five filenames is read by nobody.
 */
export function refusedLabel(refused: readonly RefusedFile[]): string | null {
  if (refused.length === 0) return null;
  if (refused.length === 1) return `${refused[0]!.name} was not attached: ${refused[0]!.why}`;
  return `${refused.length} files were not attached`;
}
