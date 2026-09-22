/**
 * Which changes can move the system diagram, and did they bring it along.
 *
 * Plain JavaScript with no imports at the top, for the same reason as
 * no-real-people.mjs: the git hooks run it with `node` before anything is
 * built, and the test suite imports the same rules. The diagram
 * (docs/diagrams/system-architecture.json) went 42 commits without an edit
 * while the system under it grew, because a rule in CLAUDE.md was the only
 * guard. This is the check that notices.
 *
 * It is deliberately coarse. It cannot tell whether a new file in
 * packages/core/src is a new component or a helper; it only says "this is the
 * kind of change that could redraw the picture, and the picture did not
 * change". The author (or the sync agent) decides; DIAGRAM_UNCHANGED=1 says
 * "looked, nothing to draw".
 *
 * CLI:
 *   node tools/diagram-drift.mjs --staged        drift in the index (pre-commit)
 *   node tools/diagram-drift.mjs --commit <rev>  drift in one commit (post-commit)
 * Exit 0 = no drift, 1 = drift (reasons on stdout), 2 = could not tell.
 */

export const DIAGRAM_JSON = "docs/diagrams/system-architecture.json";

/**
 * Source trees whose files are system pieces: adding, removing or renaming a
 * file here can add, remove or rename a box or an arrow.
 */
const STRUCTURAL = [
  /^packages\/[^/]+\/src\//,
  /^apps\/[^/]+\/lib\//,
  /^apps\/[^/]+\/app\/api\//,
  /^apps\/[^/]+\/app\/[^/]+\/page\.tsx$/,
  /^apps\/cli\//,
  /^scripts\//,
];

/**
 * Files whose every edit is architectural: how processes start and run.
 * Not the database schema: the diagram draws SQLite as one box, and a column
 * or a table never redraws it on its own.
 */
const ALWAYS = [
  /^scripts\/celeste-server\//,
  /(^|\/)[^/]+\.plist$/,
  /^pnpm-workspace\.yaml$/,
];

/** Never architectural, even inside a structural tree. */
const NEVER = [
  /(^|\/)test(s)?\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)fixtures?\//,
  /\.(css|scss|md|txt|png|jpe?g|svg|gif|webp|ico|snap)$/,
  /^docs\//,
];

const matches = (rules, path) => rules.some((r) => r.test(path));

/**
 * @param {{status: string, path: string, from?: string}[]} entries
 *   `git diff --name-status -M` rows: status A/M/D/R…, path, and for a
 *   rename the old path in `from`.
 * @param {{name: string, before: object|null, after: object|null}[]} [manifests]
 *   package.json files touched by the change, parsed before and after.
 * @returns {{touched: boolean, reasons: string[]}}
 *   `touched`: the diagram JSON is part of the change.
 */
export function drift(entries, manifests = []) {
  const reasons = [];
  let touched = false;

  for (const { status, path, from } of entries) {
    if (path === DIAGRAM_JSON) {
      touched = true;
      continue;
    }
    if (matches(NEVER, path)) continue;
    const kind = status[0];
    if (matches(ALWAYS, path)) {
      reasons.push(`${verb(kind)} ${path}`);
    } else if (kind !== "M" && (matches(STRUCTURAL, path) || (from && matches(STRUCTURAL, from)))) {
      reasons.push(kind === "R" ? `renamed ${from} → ${path}` : `${verb(kind)} ${path}`);
    }
  }

  for (const { name, before, after } of manifests) {
    for (const dep of dependencyChanges(before, after)) reasons.push(`${dep} in ${name}`);
  }

  return { touched, reasons };
}

function verb(kind) {
  return { A: "added", D: "removed", R: "renamed", C: "copied" }[kind] ?? "changed";
}

/** Added or removed runtime dependencies. Version bumps do not redraw anything. */
export function dependencyChanges(before, after) {
  const keys = (m) => new Set(Object.keys({ ...(m?.dependencies ?? {}), ...(m?.optionalDependencies ?? {}) }));
  const was = keys(before);
  const now = keys(after);
  const out = [];
  for (const d of now) if (!was.has(d)) out.push(`added dependency ${d}`);
  for (const d of was) if (!now.has(d)) out.push(`removed dependency ${d}`);
  return out;
}

/**
 * Parse `git diff --name-status -M -z` output: NUL-separated, so paths come
 * through byte for byte. Without -z git C-quotes any path with non-ASCII or
 * unusual bytes ("caf\303\251.ts"), and the rules above never match it.
 */
export function parseNameStatusZ(text) {
  const f = text.split("\0");
  const out = [];
  for (let i = 0; i < f.length && f[i]; ) {
    const status = f[i++];
    if (status.startsWith("R") || status.startsWith("C")) {
      out.push({ status, from: f[i++], path: f[i++] });
    } else {
      out.push({ status, path: f[i++] });
    }
  }
  return out;
}

/** Parse `git diff --name-status -M` output (tab-separated, for reading by eye). */
export function parseNameStatus(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, a, b] = line.split("\t");
      return status.startsWith("R") || status.startsWith("C")
        ? { status, from: a, path: b }
        : { status, path: a };
    });
}

async function main(argv) {
  const { execFileSync } = await import("node:child_process");
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
  const show = (spec) => {
    try {
      return JSON.parse(git("show", spec));
    } catch {
      return null;
    }
  };

  let listing, before, after;
  if (argv[0] === "--staged") {
    listing = git("diff", "--cached", "--name-status", "-M", "-z");
    before = (p) => show(`HEAD:${p}`);
    after = (p) => show(`:${p}`);
  } else if (argv[0] === "--commit" && argv[1]) {
    const rev = argv[1];
    const parent = git("rev-list", "--parents", "-n", "1", rev).trim().split(" ")[1];
    listing = parent
      ? git("diff", "--name-status", "-M", "-z", parent, rev)
      : git("diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", rev);
    before = (p) => (parent ? show(`${parent}:${p}`) : null);
    after = (p) => show(`${rev}:${p}`);
  } else {
    console.error("usage: diagram-drift.mjs --staged | --commit <rev>");
    return 2;
  }

  const entries = parseNameStatusZ(listing);
  const manifests = entries
    .filter((e) => e.path.endsWith("package.json") && !e.path.includes("node_modules/"))
    .map((e) => ({ name: e.path, before: before(e.from ?? e.path), after: after(e.path) }));

  const { touched, reasons } = drift(entries, manifests);
  if (touched || reasons.length === 0) return 0;
  for (const r of reasons) console.log(r);
  return 1;
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`diagram-drift: ${err.message}`);
      process.exit(2);
    },
  );
}
