import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Config } from "../config";
import { AccountAuthError } from "../connectors/types";
import { now, type Db } from "../db/client";
import { accounts, mailCredentials, oauthTokens, type AccountRow } from "../db/schema";
import { GMAIL_SETTINGS } from "../imap/types";

/**
 * Sign in with Google (2026-09-11): for a Gmail or Workspace account that
 * cannot make an app password (the operator's school disables 2-Step
 * Verification). The token stands in for the password on IMAP and SMTP,
 * and the Gmail connector is otherwise unchanged. The app stays in Google's
 * Testing mode, so a sign-in lasts seven days and the inbox then asks for
 * another, as an Outlook inbox does when Microsoft's expires.
 */
const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";
/** Full mailbox access for IMAP and SMTP, and the address to sign in with. */
export const GOOGLE_SCOPES = ["https://mail.google.com/", "email"] as const;
const SCOPE = GOOGLE_SCOPES.join(" ");


function requireGoogle(cfg: Config): { clientId: string; clientSecret: string } {
  if (!cfg.google.clientId || !cfg.google.clientSecret) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env");
  return { clientId: cfg.google.clientId, clientSecret: cfg.google.clientSecret };
}

function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest().toString("base64url");
  return { codeVerifier, codeChallenge };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function requireTokenOk(res: Response): Promise<TokenResponse> {
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as TokenResponse;
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${data.error_description ?? data.error ?? text}`);
  return data;
}

async function requireRefreshTokenOk(res: Response, accountId: string): Promise<TokenResponse> {
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as TokenResponse;
  if (!res.ok) {
    const message = data.error_description ?? data.error ?? text;
    if (data.error === "invalid_grant" || res.status === 400 || res.status === 401) {
      throw new AccountAuthError(accountId, `Google sign-in expired: ${message}`);
    }
    throw new Error(`Google token request failed: ${res.status} ${message}`);
  }
  return data;
}

export interface GoogleAuthRequest {
  url: string;
  codeVerifier: string;
  state: string;
}

export async function createGoogleAuthRequest(cfg: Config, redirectUri: string): Promise<GoogleAuthRequest> {
  const { clientId } = requireGoogle(cfg);
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = randomUUID();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    // A refresh token comes only with offline access and an explicit consent.
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return { url: `${AUTHORIZE_ENDPOINT}?${params.toString()}`, codeVerifier, state };
}

/**
 * Trades the code for tokens, learns the address, and files the account as
 * a Gmail inbox with no password: the token store is what says it signs in
 * with Google. An inbox that had a password keeps its row and loses the
 * need for the password.
 */
export async function completeGoogleAuth(
  cfg: Config,
  db: Db,
  p: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AccountRow> {
  const { clientId, clientSecret } = requireGoogle(cfg);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
  });
  const res = await fetchImpl(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const tokens = await requireTokenOk(res);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Remove Celeste under myaccount.google.com/permissions and sign in again.");
  }
  const who = (await (await fetchImpl(USERINFO_ENDPOINT, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()) as { email?: string };
  const email = (who.email ?? "").trim().toLowerCase();
  if (!email) throw new Error("Google did not say which address signed in.");

  const existing = db.select().from(accounts).where(eq(accounts.email, email)).get();
  const accountId = existing?.id ?? randomUUID();
  const fields = { provider: "imap" as const, ...GMAIL_SETTINGS, status: "ok" as const, lastError: null };
  if (existing) db.update(accounts).set(fields).where(eq(accounts.id, accountId)).run();
  else db.insert(accounts).values({ id: accountId, email, displayName: null, createdAt: now(), ...fields }).run();
  // The token is the credential now; a password left over would be tried first.
  db.delete(mailCredentials).where(eq(mailCredentials.accountId, accountId)).run();
  const expiryDate = now() + (tokens.expires_in ?? 0) * 1000;
  db.insert(oauthTokens)
    .values({ accountId, refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiryDate, scope: tokens.scope ?? null })
    .onConflictDoUpdate({ target: oauthTokens.accountId, set: { refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiryDate, scope: tokens.scope ?? null } })
    .run();
  return db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
}

/** A fresh access token for the account, refreshed through Google when the cached one is within a minute of expiring. */
export function googleAccessToken(cfg: Config, db: Db, accountId: string, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  return async () => {
    const { clientId, clientSecret } = requireGoogle(cfg);
    const tok = db.select().from(oauthTokens).where(eq(oauthTokens.accountId, accountId)).get();
    if (!tok) throw new AccountAuthError(accountId, "This inbox has no Google sign-in. Reconnect it from Inboxes.");
    if (tok.accessToken && tok.expiryDate && tok.expiryDate - 60_000 > now()) return tok.accessToken;

    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: tok.refreshToken });
    const res = await fetchImpl(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const tokens = await requireRefreshTokenOk(res, accountId);
    const expiryDate = now() + (tokens.expires_in ?? 0) * 1000;
    db.update(oauthTokens)
      .set({ accessToken: tokens.access_token, expiryDate, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}) })
      .where(eq(oauthTokens.accountId, accountId))
      .run();
    return tokens.access_token;
  };
}

/** Whether an IMAP account signs in with Google rather than a password. */
export function signsInWithGoogle(db: Db, accountId: string): boolean {
  const password = db.select({ id: mailCredentials.accountId }).from(mailCredentials).where(eq(mailCredentials.accountId, accountId)).get();
  if (password) return false;
  return Boolean(db.select({ id: oauthTokens.accountId }).from(oauthTokens).where(eq(oauthTokens.accountId, accountId)).get());
}
