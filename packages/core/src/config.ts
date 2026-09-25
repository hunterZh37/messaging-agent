import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseModelRef, type ModelRef } from "./models/types";

/**
 * What each role runs when the environment says nothing. A bare name means
 * Anthropic; `CELESTE_MODEL_SORTER=ollama:qwen3:8b` puts a local model
 * behind that one role and leaves the others alone (spec 12).
 */
export const MODELS = {
  sorter: "claude-haiku-4-5",
  drafter: "claude-sonnet-5",
  /** Ask Celeste (spec 10c): a conversation with tools, not a classification. */
  chat: "claude-sonnet-5",
  /**
   * Reading the operator's own tone back to them on the stats page. Local by
   * default and on purpose: it reads tens of thousands of the operator's own
   * messages, which is both the largest bill any role here could run up and
   * the last body of text that should leave the machine.
   */
  stats: "ollama:qwen3:8b",
} as const;

/** The roles a model can be swapped behind, in the order the app lists them. */
export const MODEL_ROLES = ["sorter", "sorter_backlog", "drafter", "chat", "stats"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** The environment variable that overrides each role's model. */
export const MODEL_ENV_VARS: Record<ModelRole, string> = {
  sorter: "CELESTE_MODEL_SORTER",
  sorter_backlog: "CELESTE_MODEL_SORTER_BACKLOG",
  drafter: "CELESTE_MODEL_DRAFTER",
  chat: "CELESTE_MODEL_CHAT",
  stats: "CELESTE_MODEL_STATS",
};

/** Local embedding model, pulled with `ollama pull nomic-embed-text`. */
export const EMBED_MODEL = "nomic-embed-text";

export const OUTLOOK_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"] as const;

export const LABELS = {
  important: "agent/important",
  needsReply: "agent/needs-reply",
} as const;

export const OUTLOOK_CATEGORIES = LABELS;

export interface Config {
  dataDir: string;
  dbPath: string;
  /** Attachment bytes, content-addressed by sha256 (spec 11a). */
  blobsDir: string;
  criteriaPath: string;
  voicePath: string;
  /** What the backlog model's verdicts taught the trickle model (spec 7a). Rewritten by the agent, editable by hand. */
  rulesPath: string;
  /** The rules file the last distillation replaced, kept so a bad rewrite is one copy away from undone. */
  rulesPrevPath: string;
  blocklistPath: string;
  microsoft: { clientId: string | undefined };
  /** Sign in with Google (2026-09-11): the OAuth client that stands in for a Gmail app password. */
  google: { clientId: string | undefined; clientSecret: string | undefined };
  anthropicApiKey: string | undefined;
  /** TypeSafe, for the Jev sorter (operator, 2026-09-21: make it the live one). */
  typesafeApiKey: string | undefined;
  /**
   * What to call the operator in a prompt. Celeste answers about "their" mail
   * and signs replies, so a name helps; unset, she says "the operator" and
   * nothing breaks.
   */
  operatorName: string | undefined;
  /** Where the local embedding and OCR models run (spec 11a). Nothing leaves the Mac. */
  ollamaUrl: string;
  /** The embedding model behind project filing. 768 dimensions. */
  embedModel: string;
  /** Which model answers for each role (spec 12). Overridden per role from the environment. */
  models: Record<ModelRole, ModelRef>;
  /** Messages on this Mac (2026-09-11): the database Messages.app writes, read here and never written. */
  chatDbPath: string;
  /** WhatsApp's ChatStorage.sqlite on this Mac (spec 10g). */
  whatsappDbPath: string;
  /**
   * A scheduling agent to hand actionables and events to (spec 10e), reached
   * over MCP. Both halves are the operator's own: there is no default server,
   * because an unconfigured install must never call somebody else's.
   */
  alex: { url: string | undefined; token: string | undefined };
  /**
   * Where this Celeste answers from for somebody else's click: the address
   * that goes into a link handed to Alex (2026-09-23). Unset means ask
   * Tailscale, which is what the phone uses to reach this Mac.
   */
  publicUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): Config {
  const dataDir = env.MESSAGING_AGENT_DATA_DIR?.trim() || path.join(homeDir, "messaging-agent");
  return {
    dataDir,
    dbPath: path.join(dataDir, "messaging-agent.sqlite"),
    blobsDir: path.join(dataDir, "blobs"),
    criteriaPath: path.join(dataDir, "criteria.md"),
    voicePath: path.join(dataDir, "voice.md"),
    rulesPath: path.join(dataDir, "rules.md"),
    rulesPrevPath: path.join(dataDir, "rules.prev.md"),
    blocklistPath: path.join(dataDir, "blocklist.txt"),
    chatDbPath: env.CELESTE_CHAT_DB?.trim() || path.join(homeDir, "Library/Messages/chat.db"),
    whatsappDbPath: env.CELESTE_WHATSAPP_DB?.trim() || path.join(homeDir, "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite"),
    microsoft: { clientId: env.MICROSOFT_CLIENT_ID },
    google: { clientId: env.GOOGLE_CLIENT_ID?.trim() || undefined, clientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || undefined },
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    typesafeApiKey: env.TYPESAFE_API_KEY?.trim() || undefined,
    operatorName: env.CELESTE_OPERATOR_NAME?.trim() || undefined,
    ollamaUrl: env.OLLAMA_URL?.trim() || "http://127.0.0.1:11434",
    embedModel: EMBED_MODEL,
    models: models(env),
    alex: {
      url: env.ALEX_MCP_URL?.trim() || undefined,
      token: env.ALEX_MCP_TOKEN?.trim() || undefined,
    },
    publicUrl: env.CELESTE_PUBLIC_URL?.trim() || undefined,
  };
}

/**
 * Which model answers for each role. The backlog sorter falls back to
 * whatever the trickle sorter resolved to, env override included, so an
 * operator who never names one keeps a single sorter and nothing changes
 * under them (spec 7a).
 */
function models(env: NodeJS.ProcessEnv): Record<ModelRole, ModelRef> {
  // Jev sorts when there is a key for it (operator, 2026-09-21). It answers
  // typed questions instead of writing prose, and on this mailbox it settled
  // a message in 0.18s against the local model's 5.7s, so where it can be
  // reached it is the one that should be doing this. Naming a sorter
  // explicitly still wins, and with no key nothing changes.
  const named = env[MODEL_ENV_VARS.sorter]?.trim();
  const sorter = parseModelRef(named || (env.TYPESAFE_API_KEY?.trim() ? "typesafe:jev-latest" : MODELS.sorter));
  const backlog = env[MODEL_ENV_VARS.sorter_backlog]?.trim();
  return {
    sorter,
    sorter_backlog: backlog ? parseModelRef(backlog) : sorter,
    drafter: parseModelRef(env[MODEL_ENV_VARS.drafter]?.trim() || MODELS.drafter),
    chat: parseModelRef(env[MODEL_ENV_VARS.chat]?.trim() || MODELS.chat),
    stats: parseModelRef(env[MODEL_ENV_VARS.stats]?.trim() || MODELS.stats),
  };
}

/** True when nothing names a backlog model, so the app can say "same as sorter" rather than repeat it. */
export function backlogSorterIsTrickle(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env[MODEL_ENV_VARS.sorter_backlog]?.trim();
}

const CRITERIA_TEMPLATE = `# Importance criteria

The sorter reads this file on every run. Edit it freely. Be concrete.

## Always important
- Anyone at my current clients or employer.
- Anything about money I owe or am owed.
- Family.

## Never important
- Newsletters, marketing, receipts, shipping notifications.
- Automated notifications from apps unless they mention a failure.

## Needs a reply when
- A person asks me a direct question or requests a decision.
- Someone proposes a meeting time.
`;

const VOICE_TEMPLATE = `# Voice

How I write replies. The drafter follows this over its own defaults.

- Short. Two to four sentences unless the question needs more.
- Plain words. No corporate filler.
- Warm with friends, direct with vendors, formal only with lawyers and banks.
- Sign off with just my first name.

## Sample replies I have sent

(Paste two or three real replies here.)
`;

const BLOCKLIST_TEMPLATE = `# One email address or phone number per line. Lines starting with # are ignored.
# Blocked senders are never stored and never reach a model.
`;

async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

export async function ensureConfigFiles(cfg: Config): Promise<void> {
  await mkdir(cfg.dataDir, { recursive: true });
  await writeIfMissing(cfg.criteriaPath, CRITERIA_TEMPLATE);
  await writeIfMissing(cfg.voicePath, VOICE_TEMPLATE);
  await writeIfMissing(cfg.blocklistPath, BLOCKLIST_TEMPLATE);
}

export async function readTextFile(file: string): Promise<string> {
  return readFile(file, "utf8");
}
