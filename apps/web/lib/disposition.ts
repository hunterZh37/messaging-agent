/**
 * A `Content-Disposition` header value for a filename we did not choose.
 * A sender picks the name, so it can hold CR/LF (header injection), quotes
 * and backslashes (which end the quoted string early), and non-ASCII, which
 * has no place in a plain `filename=`. The name is stripped for the ASCII
 * fallback and repeated whole in `filename*`, where RFC 5987 lets it survive.
 */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const safe = filename.replace(/[\r\n"\\]/g, "");
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").trim() || "attachment";
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(safe)}`;
}

/** encodeURIComponent leaves a few characters RFC 5987 does not allow bare. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
