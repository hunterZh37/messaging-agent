/**
 * Tiny PDFs, built here rather than committed as binaries: a test that says
 * what is in the file it feeds the extractor reads better than one that
 * trusts a blob nobody can open in a diff.
 */

/** A PDF of the objects given, with the xref offsets a reader needs to find them. */
function buildPdf(objects: string[]): Buffer {
  const header = "%PDF-1.4\n";
  let body = "";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(header.length + body.length);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const startxref = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) xref += `${String(at).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(header + body + xref + trailer, "latin1");
}

/** One page laid out to fit whatever is asked for: text off the page is text no extractor sees. */
function page(stream: string, width: number, height: number): Buffer {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

function escapeText(line: string): string {
  return line.replace(/([\\()])/g, "\\$1");
}

/** A page of real text, one line per entry, the way an invoice's own lines would read. */
export function linesPdf(lines: string[]): Buffer {
  const width = Math.max(200, Math.round(Math.max(...lines.map((l) => l.length)) * 7) + 40);
  const height = Math.max(100, lines.length * 20 + 40);
  const stream = [
    "BT /F1 12 Tf",
    ...lines.map((line, i) => `1 0 0 1 20 ${height - 30 - i * 20} Tm (${escapeText(line)}) Tj`),
    "ET",
  ].join("\n");
  return page(stream, width, height);
}

/** The one-liner most tests want. */
export function textPdf(text: string): Buffer {
  return linesPdf([text]);
}

/** A page with no text layer at all: a scan, as far as the extractor can tell. */
export function blankPdf(): Buffer {
  return page("", 200, 100);
}
