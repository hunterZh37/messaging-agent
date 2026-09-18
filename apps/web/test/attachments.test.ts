import { describe, it, expect } from "vitest";
import {
  attachedQuestion,
  attachmentHeaders,
  attachToDraftLabel,
  chatFileHref,
  draftAttachmentHref,
  draftAttachmentSizeLabel,
  draggingFiles,
  dropTargetLabel,
  formatSize,
  gaveQuestion,
  isPdf,
  isPreviewable,
} from "../lib/attachments";

describe("isPreviewable", () => {
  it("accepts the five safe types, whatever their case", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "APPLICATION/PDF"]) {
      expect(isPreviewable(t)).toBe(true);
    }
  });

  it("refuses the types that could execute in the app's origin", () => {
    for (const t of ["image/svg+xml", "text/html", "application/xhtml+xml", "text/plain", "application/octet-stream"]) {
      expect(isPreviewable(t)).toBe(false);
    }
  });
});

describe("isPdf", () => {
  it("is true only for pdf", () => {
    expect(isPdf("application/pdf")).toBe(true);
    expect(isPdf("image/png")).toBe(false);
  });
});

describe("formatSize", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(812)).toBe("812 B");
    expect(formatSize(12288)).toBe("12 KB");
    expect(formatSize(1_468_006)).toBe("1.4 MB");
    expect(formatSize(52_428_800)).toBe("50 MB");
  });
});

describe("attachmentHeaders", () => {
  const pdf = { mimeType: "application/pdf", filename: "menu.pdf", size: 1200, forceDownload: false };

  it("serves a previewable type inline with no CSP, so Chrome's PDF viewer still renders", () => {
    const h = attachmentHeaders(pdf);
    expect(h["Content-Type"]).toBe("application/pdf");
    expect(h["Content-Disposition"]).toMatch(/^inline; /);
    expect(h["Content-Security-Policy"]).toBeUndefined();
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Cache-Control"]).toBe("private, max-age=3600");
    expect(h["Content-Length"]).toBe("1200");
  });

  it("locks a download down to octet-stream under default-src 'none'", () => {
    const h = attachmentHeaders({ ...pdf, forceDownload: true });
    expect(h["Content-Type"]).toBe("application/octet-stream");
    expect(h["Content-Disposition"]).toMatch(/^attachment; /);
    expect(h["Content-Security-Policy"]).toBe("default-src 'none'");
  });

  it("never serves an svg or html attachment inline", () => {
    for (const mimeType of ["image/svg+xml", "text/html"]) {
      const h = attachmentHeaders({ mimeType, filename: "x", size: 10, forceDownload: false });
      expect(h["Content-Type"]).toBe("application/octet-stream");
      expect(h["Content-Security-Policy"]).toBe("default-src 'none'");
    }
  });
});

describe("draftAttachmentHref", () => {
  it("points at the file on its own draft, and forces a download when asked", () => {
    expect(draftAttachmentHref("d1", "att-1", false)).toBe("/api/drafts/d1/attachments/att-1");
    expect(draftAttachmentHref("d1", "att-1", true)).toBe("/api/drafts/d1/attachments/att-1?download=1");
  });

  it("escapes ids, so one can never reach out of its own path", () => {
    expect(draftAttachmentHref("d/1", "../secret", false)).toBe("/api/drafts/d%2F1/attachments/..%2Fsecret");
  });
});

describe("draftAttachmentSizeLabel", () => {
  it("shows the size once the file is there", () => {
    expect(draftAttachmentSizeLabel({ size: 122_880 })).toBe("120 KB");
  });

  it("says what is happening while it is still going up", () => {
    expect(draftAttachmentSizeLabel({ size: 0, uploading: true })).toBe("attaching…");
  });
});

describe("dropTargetLabel", () => {
  it("names who the file would go to", () => {
    expect(dropTargetLabel({ to: ["jocelyn@example.com"] })).toEqual({
      accepts: true,
      label: "Drop to attach to the draft to jocelyn@example.com",
    });
  });

  it("takes the file for Celeste herself when no draft is open", () => {
    expect(dropTargetLabel(null)).toEqual({ accepts: true, label: "Drop to give Celeste this file" });
    expect(dropTargetLabel(undefined)).toEqual({ accepts: true, label: "Drop to give Celeste this file" });
  });

  it("still accepts a draft whose recipients have all been cleared", () => {
    expect(dropTargetLabel({ to: [] })).toEqual({ accepts: true, label: "Drop to attach to the draft to (nobody)" });
  });
});

describe("attachToDraftLabel", () => {
  it("names the mail the file would go onto, so it never reads as sending", () => {
    expect(attachToDraftLabel({ to: ["jocelyn@example.com"] })).toEqual({
      label: "Attach to draft",
      title: "Attach it to the draft to jocelyn@example.com",
    });
    expect(attachToDraftLabel({ to: [] })).toEqual({ label: "Attach to draft", title: "Attach it to the draft to (nobody)" });
  });

  it("offers nothing when there is no draft to attach to", () => {
    expect(attachToDraftLabel(null)).toBeNull();
  });
});

describe("draggingFiles", () => {
  it("is true for a drag carrying files and false for anything else", () => {
    expect(draggingFiles(["Files"])).toBe(true);
    expect(draggingFiles(["text/plain"])).toBe(false);
    expect(draggingFiles(undefined)).toBe(false);
  });
});

describe("attachedQuestion and gaveQuestion", () => {
  it("asks in the operator's own words what the file is", () => {
    expect(attachedQuestion("invoice.pdf")).toBe("I attached invoice.pdf to the draft. What is it, in one line, and does it fit the thread?");
  });

  it("asks nothing about a thread when the file went to the conversation", () => {
    expect(gaveQuestion("quote.pdf")).toBe("I gave you quote.pdf. What is it, in one line?");
  });
});

describe("chatFileHref", () => {
  it("points at the file in its own conversation, and forces a download when asked", () => {
    expect(chatFileHref("chat-1", "f1", false)).toBe("/api/chats/chat-1/files/f1");
    expect(chatFileHref("chat-1", "f1", true)).toBe("/api/chats/chat-1/files/f1?download=1");
  });

  it("escapes ids, so one can never reach out of its own path", () => {
    expect(chatFileHref("c/1", "../secret", false)).toBe("/api/chats/c%2F1/files/..%2Fsecret");
  });
});

describe("fileKind", () => {
  it("reads the kind off the extension and falls back to FILE", async () => {
    const { fileKind } = await import("../lib/attachments");
    expect(fileKind("Invoice 09_06_2026.pdf")).toBe("PDF");
    expect(fileKind("photo.JPEG")).toBe("JPEG");
    expect(fileKind("README")).toBe("FILE");
    expect(fileKind("archive.tar.gz")).toBe("GZ");
  });
});
