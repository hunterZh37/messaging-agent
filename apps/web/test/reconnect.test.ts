import { describe, it, expect } from "vitest";
import { reconnectWith } from "../lib/reconnect";

/**
 * The way back into an inbox that has stopped letting Celeste in (operator,
 * 2026-10-19, shown an app-password box for a Stanford account that cannot
 * make one: "what is the app password").
 *
 * Reconnect offered Google sign-in only while the account still held a Google
 * token — and disconnecting deletes it. So the one button that could restore
 * the account disappeared at the moment it was needed, leaving a form asking
 * for a password Stanford does not issue, because the school disables 2-Step
 * Verification. That is the whole reason this account signs in with Google.
 *
 * What lasts is the other half: an IMAP inbox Celeste holds no password for
 * was signed in with Google, token or no token.
 */
describe("how to reconnect an inbox", () => {
  it("sends an Outlook inbox to Microsoft", () => {
    expect(reconnectWith("outlook", { hasPassword: false })).toBe("microsoft");
    expect(reconnectWith("outlook", { hasPassword: true })).toBe("microsoft");
  });

  it("sends an IMAP inbox with no stored password to Google", () => {
    expect(reconnectWith("imap", { hasPassword: false })).toBe("google");
  });

  it("still sends it to Google once the token is gone, which is when it is asked", () => {
    // The token row is deleted by a disconnect; this must not change the answer.
    expect(reconnectWith("imap", { hasPassword: false, hasGoogleToken: false })).toBe("google");
  });

  it("asks for the password on an inbox that is held by one", () => {
    expect(reconnectWith("imap", { hasPassword: true })).toBe("password");
  });

  it("asks for the password on a chat account, which has neither", () => {
    expect(reconnectWith("imessage", { hasPassword: false })).toBe("password");
    expect(reconnectWith("whatsapp", { hasPassword: false })).toBe("password");
  });
});
