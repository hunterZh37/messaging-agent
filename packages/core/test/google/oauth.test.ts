import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { completeGoogleAuth, createGoogleAuthRequest, googleAccessToken, signsInWithGoogle } from "../../src/google/oauth";
import { testDb } from "../helpers/db";
import { accounts, mailCredentials, oauthTokens } from "../../src/db/schema";
import { loadConfig } from "../../src/config";
import { AccountAuthError } from "../../src/connectors/types";

const cfg = () => loadConfig({ GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret" }, "/unused");
const redirectUri = "http://127.0.0.1:3100/api/oauth/google/callback";

describe("createGoogleAuthRequest", () => {
  it("asks for the mailbox and the address, offline, with consent, pkce and state", async () => {
    const req = await createGoogleAuthRequest(cfg(), redirectUri);
    expect(req.url).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expect(req.url).toContain("client_id=g-id");
    expect(req.url).toContain(encodeURIComponent("https://mail.google.com/"));
    expect(req.url).toContain("access_type=offline");
    expect(req.url).toContain("prompt=consent");
    expect(req.url).toContain("code_challenge_method=S256");
    expect(req.url).toContain(`state=${req.state}`);
  });

  it("names the two .env keys when they are missing", async () => {
    await expect(createGoogleAuthRequest(loadConfig({}, "/unused"), redirectUri)).rejects.toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("completeGoogleAuth", () => {
  it("files the address as a Gmail inbox that signs in with Google, and drops any password it had", async () => {
    const db = testDb();
    db.insert(accounts).values({ id: "old", provider: "imap", email: "me@school.edu", displayName: null, createdAt: 1, kind: "gmail", status: "needs_signin" }).run();
    db.insert(mailCredentials).values({ accountId: "old", username: "me@school.edu", password: "stale" }).run();
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/token") ? json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "s" }) : json({ email: "Me@School.edu" }),
    );
    const a = await completeGoogleAuth(cfg(), db, { code: "c", codeVerifier: "v", redirectUri }, fetchImpl as unknown as typeof fetch);
    expect(a.id).toBe("old");
    expect(a.provider).toBe("imap");
    expect(a.kind).toBe("gmail");
    expect(a.imapHost).toBe("imap.gmail.com");
    expect(a.status).toBe("ok");
    expect(db.select().from(mailCredentials).all()).toEqual([]);
    expect(db.select().from(oauthTokens).where(eq(oauthTokens.accountId, "old")).get()?.refreshToken).toBe("rt");
    expect(signsInWithGoogle(db, "old")).toBe(true);
    const body = String((fetchImpl.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1].body);
    expect(body).toContain("client_secret=g-secret");
    expect(body).toContain("code_verifier=v");
  });

  it("refuses to file an account without a refresh token", async () => {
    const db = testDb();
    const fetchImpl = vi.fn(async () => json({ access_token: "at", expires_in: 3600 }));
    await expect(completeGoogleAuth(cfg(), db, { code: "c", codeVerifier: "v", redirectUri }, fetchImpl as unknown as typeof fetch)).rejects.toThrow(/refresh token/);
  });
});

describe("googleAccessToken", () => {
  function seed(db: ReturnType<typeof testDb>, expiryDate: number) {
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@school.edu", displayName: null, createdAt: 1, kind: "gmail" }).run();
    db.insert(oauthTokens).values({ accountId: "a1", refreshToken: "refresh-1", accessToken: "cached", expiryDate, scope: "x" }).run();
  }

  it("hands back the cached token while it lasts", async () => {
    const db = testDb();
    seed(db, Date.now() + 600_000);
    const fetchImpl = vi.fn();
    expect(await googleAccessToken(cfg(), db, "a1", fetchImpl as unknown as typeof fetch)()).toBe("cached");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes with the client secret when it is spent, and keeps what Google sends", async () => {
    const db = testDb();
    seed(db, Date.now() - 1);
    const fetchImpl = vi.fn(async () => json({ access_token: "fresh", expires_in: 3600 }));
    expect(await googleAccessToken(cfg(), db, "a1", fetchImpl as unknown as typeof fetch)()).toBe("fresh");
    const body = String((fetchImpl.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1].body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("client_secret=g-secret");
    const tok = db.select().from(oauthTokens).where(eq(oauthTokens.accountId, "a1")).get()!;
    expect(tok.accessToken).toBe("fresh");
    expect(tok.refreshToken).toBe("refresh-1");
  });

  it("says the sign-in expired, as an account error, when Google refuses the refresh", async () => {
    const db = testDb();
    seed(db, Date.now() - 1);
    const fetchImpl = vi.fn(async () => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    await expect(googleAccessToken(cfg(), db, "a1", fetchImpl as unknown as typeof fetch)()).rejects.toThrow(AccountAuthError);
  });
});
