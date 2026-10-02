/**
 * When Celeste asks the operator to sign an inbox back in (2026-10-01: "make
 * a pop-up and ask me to re-sign into these every single time they happen").
 *
 * Two of their inboxes had been locked out for two and a half days with
 * nothing on screen to say so. The rules the panel follows are here, away
 * from React, because what must not happen is subtle: it has to come back
 * every time Celeste is opened, stay away while they work, and never appear
 * over the page they fix it on.
 */

/**
 * The inboxes asked about, as one name. By their names rather than their
 * number, so another inbox going down asks again rather than hiding behind a
 * "Later" meant for the first.
 */
export function signinKey(emails: string[]): string {
  return [...emails].sort().join(",");
}

/** The pages where the operator is already dealing with it. */
export function fixingSignin(pathname: string): boolean {
  return pathname === "/inboxes" || pathname.startsWith("/connecting");
}

/**
 * Whether to put the panel up. `putOff` is what they last pressed Later on,
 * for as long as this page lives: a reload is a fresh ask, which is what
 * opening Celeste again means.
 */
export function askToSignIn(emails: string[], putOff: string | null, pathname: string): boolean {
  if (emails.length === 0) return false;
  if (fixingSignin(pathname)) return false;
  return signinKey(emails) !== putOff;
}
