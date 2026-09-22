/**
 * Live system diagram: `pnpm diagram`.
 *
 * Serves docs/diagrams/system-architecture.html on localhost and reloads the
 * open tab whenever the diagram changes. Saving the JSON re-renders it with
 * archify, so an edit shows up in the browser before anything is committed;
 * a commit, a pull or the background sync agent rewriting the HTML shows up
 * the same way. A render that fails leaves the last good diagram in place and
 * shows the error over it, without reloading, so pan and zoom survive a typo.
 *
 *   node tools/diagram-live.mjs [--port 4178] [--no-open]
 *
 * Spec: docs/superpowers/specs/2026-09-21-live-diagram-design.md
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "docs/diagrams");
const JSON_FILE = path.join(DIR, "system-architecture.json");
const HTML_FILE = path.join(DIR, "system-architecture.html");
const ARCHIFY = path.join(homedir(), ".claude/skills/archify/bin/archify.mjs");

const args = process.argv.slice(2);
const portAt = args.indexOf("--port");
const port = portAt === -1 ? 4178 : Number(args[portAt + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`--port needs a number from 1 to 65535, got ${JSON.stringify(args[portAt + 1] ?? "")}`);
  process.exit(2);
}
const open = !args.includes("--no-open");

/** The diagram's version: the HTML's mtime. A tab reloads only when it moves. */
let version = 0;
let lastError = null;
const clients = new Set();

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) send(res, event, data);
}

// The page learns its version when served. On every (re)connect the server
// says hello with the current one, so a tab that slept through a change, or
// outlived a server restart, catches up; a tab that is current does nothing.
function client(pageVersion) {
  return `<script>(() => {
  const mine = ${JSON.stringify(pageVersion)};
  const es = new EventSource("/__live");
  const banner = (text) => {
    let el = document.getElementById("__live_error");
    if (!text) return el && el.remove();
    if (!el) {
      el = document.createElement("div");
      el.id = "__live_error";
      el.setAttribute("role", "alert");
      el.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;max-height:40vh;overflow:auto;padding:12px 40px 12px 14px;border-radius:8px;background:#3b0d0d;color:#ffd7d7;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;box-shadow:0 4px 24px rgba(0,0,0,.4)";
      const close = document.createElement("button");
      close.textContent = "\\u00d7";
      close.setAttribute("aria-label", "Dismiss");
      close.style.cssText = "position:absolute;top:6px;right:8px;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:inherit;font:18px/1 system-ui;cursor:pointer";
      close.onclick = () => el.remove();
      const body = document.createElement("div");
      el.append(close, body);
      document.body.append(el);
    }
    const body = el.lastChild;
    body.textContent = "";
    const title = document.createElement("strong");
    title.textContent = "Render failed. This is the last good diagram.";
    body.append(title, "\\n" + text);
  };
  const check = (e) => {
    const s = JSON.parse(e.data);
    if (s.version !== mine) return location.reload();
    banner(s.error);
  };
  es.addEventListener("hello", check);
  es.addEventListener("state", check);
})();</script>`;
}

function state() {
  return { version, error: lastError };
}

function log(msg) {
  console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
}

let rendering = false;
let again = false;
function render() {
  if (rendering) return void (again = true);
  rendering = true;
  execFile(
    process.execPath,
    [ARCHIFY, "deliver", "architecture", JSON_FILE, HTML_FILE, "--quality", "showcase", "--json"],
    { cwd: ROOT, maxBuffer: 16 << 20 },
    (err, stdout, stderr) => {
      rendering = false;
      const was = lastError;
      if (err) {
        // `deliver --json` reports its failure as JSON on stdout; show the message, not the envelope.
        let message;
        try {
          message = JSON.parse(stdout).error;
        } catch {}
        lastError = String(message || stderr || stdout || err.message).trim().split("\n").slice(0, 12).join("\n");
        log("render failed, showing the last good diagram");
      } else {
        lastError = null;
      }
      // A changed HTML reaches tabs through the watcher; this only moves the banner.
      if (lastError !== was) broadcast("state", state());
      if (again) {
        again = false;
        render();
      }
    },
  );
}

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

const htmlVersion = async () => (await stat(HTML_FILE).catch(() => ({ mtimeMs: 0 }))).mtimeMs;

const onHtml = debounce(async () => {
  const now = await htmlVersion();
  if (now === version) return;
  version = now;
  log("diagram changed, reloading");
  broadcast("state", state());
}, 150);

// macOS reports one save as several events, some seconds apart; render only
// when the content really changed.
let lastJson = "";
const digest = async (file) => createHash("sha256").update(await readFile(file).catch(() => "")).digest("hex");
const onJson = debounce(async () => {
  const now = await digest(JSON_FILE);
  if (now === lastJson) return;
  lastJson = now;
  log("JSON saved, rendering");
  render();
}, 250);

// Watch the directory, not the files: editors and git replace files by rename,
// which silently ends a watch on the old inode.
watch(DIR, (_event, name) => {
  if (name === "system-architecture.html") onHtml();
  if (name === "system-architecture.json") onJson();
});

const WAITING = `<!doctype html><meta charset="utf-8"><title>Celeste diagram</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0f14;color:#c9d1d9;font:14px/1.5 system-ui">
<p>No diagram rendered yet. This page opens it as soon as it exists.</p>`;

const server = createServer(async (req, res) => {
  if (req.url === "/__live") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    send(res, "hello", state());
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.url !== "/" && req.url !== "/index.html") {
    res.writeHead(404).end("not found");
    return;
  }
  // Read the version before the file, so a render landing in between makes
  // the tab reload once more rather than show new bytes as the old version.
  const pageVersion = version;
  const html = await readFile(HTML_FILE, "utf8").catch(() => null);
  const page = html ?? WAITING;
  const inject = client(html === null ? 0 : pageVersion);
  const body = page.includes("</body>") ? page.replace(/<\/body>(?![\s\S]*<\/body>)/, `${inject}</body>`) : page + inject;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
});

// Keep-alive comments so proxies and sleeping tabs do not drop the stream.
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25_000).unref();

server.on("error", (err) => {
  console.error(err.code === "EADDRINUSE" ? `port ${port} is in use; try --port ${port + 1}` : err.message);
  process.exit(1);
});

server.listen(port, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${port}/`;
  version = await htmlVersion();
  lastJson = await digest(JSON_FILE);
  log(`live diagram at ${url}  (Ctrl-C to stop)`);
  // A pull or a checkout can leave the JSON ahead of its HTML; catch up first.
  const jsonAt = (await stat(JSON_FILE).catch(() => null))?.mtimeMs;
  if (jsonAt !== undefined && jsonAt > version) {
    log(version ? "JSON is newer than the diagram, rendering" : "no rendered diagram yet, rendering");
    render();
  }
  if (open && process.platform === "darwin") execFile("open", [url]);
  else if (open) log("open the URL above in a browser");
});
