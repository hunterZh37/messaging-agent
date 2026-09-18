import type { NextConfig } from "next";

// Sender HTML bodies render via dangerouslySetInnerHTML after server-side
// sanitization (see packages/core/src/text/sanitize.ts). This CSP is the
// second layer: no script execution regardless of what slips past the
// sanitizer, and remote images only load over https or from this origin
// (image attachments come back from /api/attachments). `unsafe-eval` and
// `unsafe-inline` on script-src are required by Next.js dev/HMR; a stricter
// nonce-based policy is future work, not needed for this pass. `frame-src
// 'self'` is what lets the PDF preview iframe load from /api/attachments;
// that route only ever serves a PDF with its own MIME type, everything else
// goes out as an octet-stream download.
const csp =
  "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; frame-src 'self'; object-src 'none'";

const config: NextConfig = {
  transpilePackages: ["@messaging-agent/core"],
  // `pdf-parse` reads the text of a file dropped on a draft (spec 8,
  // 2026-09-10); it carries pdfjs and a native canvas binding, so it is left
  // to node like the rest of these rather than bundled.
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "imapflow", "nodemailer", "mailparser", "pdf-parse", "@anthropic-ai/sdk"],
  agentRules: false,
  // The phone reaches the app through Tailscale on the Mac's own ts.net name
  // (2026-09-14); a server action from there is not a cross-site one.
  experimental: { serverActions: { allowedOrigins: ["*.ts.net"] } },
  async headers() {
    return [
      {
        // Everything but the three attachment routes, whose responses are
        // bytes we did not write: a page CSP on a PDF blanks out Chrome's
        // viewer, so those routes set their own (see
        // app/api/attachments/[id]/route.ts, and the two that serve a file
        // the operator gave us under the same rules — one on a draft, one on
        // a conversation).
        source: "/((?!api/attachments/|api/drafts/[^/]+/attachments/[^/]+|api/chats/[^/]+/files/[^/]+).*)",
        headers: [{ key: "Content-Security-Policy", value: csp }],
      },
    ];
  },
};

export default config;
