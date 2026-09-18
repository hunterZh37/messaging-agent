import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Config } from "../config";
import { OUTLOOK_SCOPES } from "../config";
import { AccountAuthError } from "../connectors/types";
import { now, type Db } from "../db/client";
import { accounts, oauthTokens, type AccountRow } from "../db/schema";
import { createOutlookClient } from "./client";
import type { OutlookClient } from "./types";

const AUTHORIZE_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const SCOPE = OUTLOOK_SCOPES.join(" ");

function requireMicrosoft(cfg: Config): string {
  if (!cfg.microsoft.clientId) throw new Error("MICROSOFT_CLIENT_ID must be set in .env");
  return cfg.microsoft.clientId;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
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
  if (!res.ok) {
    throw new Error(`Microsoft token request failed: ${res.status} ${data.error_description ?? data.error ?? text}`);
  }
  return data;
}

/**
 * Same as requireTokenOk, but a non-2xx response on a *refresh* (a 400/401,
 * or an `invalid_grant` body) means the account's own sign-in has expired —
 * not a transient failure — so it throws AccountAuthError instead of a plain
 * Error, which is what the pipeline watches for to flip the account to
 * needs_signin.
 */
async function requireRefreshTokenOk(res: Response, accountId: string): Promise<TokenResponse> {
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as TokenResponse;
  if (!res.ok) {
    const message = data.error_description ?? data.error ?? text;
    if (data.error === "invalid_grant" || res.status === 400 || res.status === 401) {
      throw new AccountAuthError(accountId, `Microsoft sign-in expired: ${message}`);
    }
    throw new Error(`Microsoft token request failed: ${res.status} ${message}`);
  }
  return data;
}

/** Builds the PKCE authorization URL for a given redirect URI. The caller (web route) owns transport. */
export interface AuthRequest {
  url: string;
  codeVerifier: string;
  state: string;
}

export async function createOutlookAuthRequest(cfg: Config, redirectUri: string): Promise<AuthRequest> {
  const clientId = requireMicrosoft(cfg);
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = randomUUID();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return { url: `${AUTHORIZE_ENDPOINT}?${params.toString()}`, codeVerifier, state };
}

/** Exchanges the authorization code for tokens and upserts the account + oauth_tokens rows. The only place Outlook tokens are written. */
export async function completeOutlookAuth(
  cfg: Config,
  db: Db,
  p: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AccountRow> {
  const clientId = requireMicrosoft(cfg);
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
    scope: SCOPE,
  });
  const res = await fetchImpl(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const tokens = await requireTokenOk(res);
  if (!tokens.refresh_token) {
    throw new Error("Microsoft did not return a refresh token. Remove the app under account.live.com/consent/Manage and retry.");
  }

  const client = createOutlookClient(async () => tokens.access_token);
  const profile = await client.getProfile();

  const existing = db.select().from(accounts).where(eq(accounts.email, profile.email)).get();
  const accountId = existing?.id ?? randomUUID();
  if (!existing) {
    db.insert(accounts).values({ id: accountId, provider: "outlook", email: profile.email, displayName: null, createdAt: now() }).run();
  } else {
    db.update(accounts).set({ status: "ok", lastError: null }).where(eq(accounts.id, accountId)).run();
  }
  const expiryDate = now() + (tokens.expires_in ?? 0) * 1000;
  db.insert(oauthTokens)
    .values({ accountId, refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiryDate, scope: tokens.scope ?? null })
    .onConflictDoUpdate({
      target: oauthTokens.accountId,
      set: { refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiryDate, scope: tokens.scope ?? null },
    })
    .run();
  return db.select().from(accounts).where(eq(accounts.id, accountId)).get()!;
}

/**
 * Returns a function that resolves a usable access token for the account,
 * refreshing (and persisting the possibly-rotated refresh token) when the
 * cached access token is missing or within 60s of expiring.
 */
export function outlookAccessToken(cfg: Config, db: Db, accountId: string, fetchImpl: typeof fetch = fetch): () => Promise<string> {
  return async () => {
    const clientId = requireMicrosoft(cfg);
    const tok = db.select().from(oauthTokens).where(eq(oauthTokens.accountId, accountId)).get();
    if (!tok) throw new Error(`No OAuth tokens for account ${accountId}. Connect the account from the Accounts page.`);

    if (tok.accessToken && tok.expiryDate && tok.expiryDate - 60_000 > now()) {
      return tok.accessToken;
    }

    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: tok.refreshToken,
      scope: SCOPE,
    });
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

export function outlookForAccount(cfg: Config, db: Db, accountId: string): OutlookClient {
  return createOutlookClient(outlookAccessToken(cfg, db, accountId));
}
