/**
 * How an inbox that has stopped letting Celeste in gets let back in.
 *
 * Reconnect used to offer Google sign-in only while the account still held a
 * Google token, and a disconnect deletes that token. So the one button that
 * could restore the account vanished exactly when it was needed, and what
 * stood in its place was a box asking for an app password — which the
 * operator's school does not issue, since it disables 2-Step Verification.
 * That is the whole reason the account signs in with Google (operator,
 * 2026-10-19: "what is the app password", over a Stanford inbox reading
 * `disconnected`, its token already gone).
 *
 * The question is answered by what the account has always been rather than
 * what it still holds: an IMAP inbox Celeste keeps no password for is one
 * that was signed in with Google, token or no token.
 */
export function reconnectWith(
  provider: string,
  held: { hasPassword: boolean; hasGoogleToken?: boolean },
): "google" | "microsoft" | "password" {
  if (provider === "outlook") return "microsoft";
  if (provider === "imap" && !held.hasPassword) return "google";
  return "password";
}
