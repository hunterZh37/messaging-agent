import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createOutlookAuthRequest, outlookAccessToken } from "../../src/outlook/oauth";
import { testDb } from "../helpers/db";
import { accounts, oauthTokens } from "../../src/db/schema";
import { loadConfig, OUTLOOK_SCOPES } from "../../src/config";

function cfgWithMicrosoft() {
  return loadConfig({ MICROSOFT_CLIENT_ID: "ms-client-id" }, "/unused");
}

const redirectUri = "http://127.0.0.1:3100/api/oauth/microsoft/callback";

describe("createOutlookAuthRequest", () => {
  it("builds an authorize url carrying pkce, state, response_mode, and every scope", async () => {
    const req = await createOutlookAuthRequest(cfgWithMicrosoft(), redirectUri);
    expect(req.url).toContain("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(req.url).toContain("client_id=ms-client-id");
    expect(req.url).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
    expect(req.url).toContain("code_challenge=");
    expect(req.url).toContain("code_challenge_method=S256");
    expect(req.url).toContain(`state=${req.state}`);
    expect(req.url).toContain("response_mode=query");
    for (const scope of OUTLOOK_SCOPES) {
      expect(req.url).toContain(scope);
    }
  });

  it("produces a different state and code verifier on each call", async () => {
    const cfg = cfgWithMicrosoft();
    const a = await createOutlookAuthRequest(cfg, redirectUri);
    const b = await createOutlookAuthRequest(cfg, redirectUri);
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it("throws pointing at MICROSOFT_CLIENT_ID when unset", async () => {
    const cfg = loadConfig({}, "/unused");
    await expect(createOutlookAuthRequest(cfg, redirectUri)).rejects.toThrow(/MICROSOFT_CLIENT_ID/);
  });
});

describe("outlookAccessToken", () => {
  function seed(db: ReturnType<typeof testDb>, expiryDate: number | null) {
    db.insert(accounts).values({ id: "a1", provider: "outlook", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(oauthTokens).values({ accountId: "a1", refreshToken: "refresh-1", accessToken: "cached-token", expiryDate, scope: "x" }).run();
  }

  it("returns the cached access token without refreshing when it's still valid", async () => {
    const db = testDb();
    seed(db, Date.now() + 10 * 60_000);
    const fetchImpl = vi.fn();
    const getToken = outlookAccessToken(cfgWithMicrosoft(), db, "a1", fetchImpl as unknown as typeof fetch);
    expect(await getToken()).toBe("cached-token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes via the token endpoint when expired, persists the new access token, expiry, and a rotated refresh token", async () => {
    const db = testDb();
    seed(db, Date.now() - 1000);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const getToken = outlookAccessToken(cfgWithMicrosoft(), db, "a1", fetchImpl as unknown as typeof fetch);
    const before = Date.now();
    const token = await getToken();
    expect(token).toBe("new-access");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const body = String((init as RequestInit).body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=refresh-1");

    const row = db.select().from(oauthTokens).where(eq(oauthTokens.accountId, "a1")).get();
    expect(row?.accessToken).toBe("new-access");
    expect(row?.refreshToken).toBe("rotated-refresh");
    expect(row?.expiryDate).toBeGreaterThanOrEqual(before + 3600_000 - 1000);
  });

  it("keeps the existing refresh token when Microsoft doesn't rotate it", async () => {
    const db = testDb();
    seed(db, Date.now() - 1000);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const getToken = outlookAccessToken(cfgWithMicrosoft(), db, "a1", fetchImpl as unknown as typeof fetch);
    await getToken();
    const row = db.select().from(oauthTokens).where(eq(oauthTokens.accountId, "a1")).get();
    expect(row?.refreshToken).toBe("refresh-1");
  });

  it("throws pointing at the Accounts page when no token row exists", async () => {
    const db = testDb();
    const getToken = outlookAccessToken(cfgWithMicrosoft(), db, "missing");
    await expect(getToken()).rejects.toThrow(/Accounts page/);
  });

  it("surfaces the token endpoint's error_description on a failed refresh", async () => {
    const db = testDb();
    seed(db, Date.now() - 1000);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const getToken = outlookAccessToken(cfgWithMicrosoft(), db, "a1", fetchImpl as unknown as typeof fetch);
    await expect(getToken()).rejects.toThrow(/refresh token expired/);
  });
});
