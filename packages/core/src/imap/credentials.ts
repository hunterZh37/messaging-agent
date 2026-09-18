import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Config } from "../config";
import { AccountAuthError } from "../connectors/types";
import { googleAccessToken, signsInWithGoogle } from "../google/oauth";
import { now, type Db } from "../db/client";
import { accounts, mailCredentials, type AccountRow } from "../db/schema";
import { createImapClient, createSmtpClient } from "./client";
import type { ImapClient, ImapCredentials, ImapSettings, SmtpClient } from "./types";

/**
 * Creates or reconnects an inbox: one account row with its hosts, one
 * credentials row with the app password. The password lives here and nowhere
 * else — never in .env, never in a log line, never in a response body.
 */
export function saveImapAccount(
  db: Db,
  p: { email: string; settings: ImapSettings; username: string; password: string },
  clock: () => number = now,
): AccountRow {
  const email = p.email.trim().toLowerCase();
  const existing = db.select().from(accounts).where(eq(accounts.email, email)).get();
  const accountId = existing?.id ?? randomUUID();
  const fields = {
    provider: "imap" as const,
    imapHost: p.settings.imapHost,
    imapPort: p.settings.imapPort,
    smtpHost: p.settings.smtpHost,
    smtpPort: p.settings.smtpPort,
    kind: p.settings.kind,
    status: "ok" as const,
    lastError: null,
  };

  if (existing) {
    db.update(accounts).set(fields).where(eq(accounts.id, accountId)).run();
  } else {
    db.insert(accounts).values({ id: accountId, email, displayName: null, createdAt: clock(), ...fields }).run();
  }

  db.insert(mailCredentials)
    .values({ accountId, username: p.username, password: p.password })
    .onConflictDoUpdate({ target: mailCredentials.accountId, set: { username: p.username, password: p.password } })
    .run();

  return db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
}

/** The stored settings and password for an account, or an AccountAuthError explaining what to do. */
function requireImapAccount(db: Db, accountId: string, cfg?: Config): { settings: ImapSettings; creds: ImapCredentials; email: string } {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error(`No such account: ${accountId}`);
  if (account.status === "disconnected") {
    throw new AccountAuthError(accountId, `${account.email} is disconnected. Reconnect it from Inboxes.`);
  }
  const password = db.select().from(mailCredentials).where(eq(mailCredentials.accountId, accountId)).get();
  // No password: the account signs in with Google (2026-09-11), and the
  // token store says so; the token is fetched fresh at each connect.
  const creds: ImapCredentials | null = password
    ? { username: password.username, password: password.password }
    : cfg && signsInWithGoogle(db, accountId)
      ? { username: account.email, accessToken: googleAccessToken(cfg, db, accountId) }
      : null;
  if (!creds) throw new AccountAuthError(accountId, `${account.email} has no stored password or Google sign-in. Reconnect it from Inboxes.`);
  if (!account.imapHost || !account.imapPort || !account.smtpHost || !account.smtpPort) {
    throw new AccountAuthError(accountId, `${account.email} has no IMAP settings stored. Reconnect it from Inboxes.`);
  }
  return {
    email: account.email,
    settings: {
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      kind: account.kind ?? "generic",
    },
    creds,
  };
}

export function imapForAccount(db: Db, accountId: string, cfg?: Config): { imap: ImapClient; smtp: SmtpClient } {
  const { settings, creds } = requireImapAccount(db, accountId, cfg);
  return { imap: createImapClient(settings, creds), smtp: createSmtpClient(settings, creds) };
}

/**
 * Proves the operator's password works before anything is saved: connect,
 * read the folder list, disconnect. The server's own words come back in the
 * error so "wrong password" and "wrong host" stay distinguishable.
 */
export async function testImapLogin(
  settings: ImapSettings,
  creds: ImapCredentials,
  make: (settings: ImapSettings, creds: ImapCredentials) => ImapClient = createImapClient,
): Promise<void> {
  const client = make(settings, creds);
  try {
    await client.connect();
    await client.folders();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`IMAP login failed: ${message}`);
  } finally {
    try {
      await client.close();
    } catch {
      /* the connection is already gone; nothing to clean up */
    }
  }
}
