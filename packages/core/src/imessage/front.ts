/**
 * Driving Messages.app or WhatsApp.app brings that app to the front; the
 * operator asked for Celeste back afterwards (2026-09-11). The script notes
 * what was in front when it started and, whatever it returns, activates
 * that again on its way out. Every `return` inside the script goes through
 * `done`, which is where the hand-back happens.
 */
export function returningToFront(lines: string[]): string {
  // A return stands at the start of a line or after a "then" on the same line.
  const body = lines.map((line) => line.replace(/(^\s*|\bthen )return (.+)$/, (_m, lead: string, value: string) => `${lead}return my done(${value})`));
  return [
    `property prevApp : ""`,
    `on done(r)`,
    `  delay 0.4`,
    `  if prevApp is not "" and prevApp is not "WhatsApp" and prevApp is not "Messages" then`,
    `    try`,
    `      tell application prevApp to activate`,
    `    end try`,
    `  end if`,
    `  return r`,
    `end done`,
    `try`,
    `  tell application "System Events" to set prevApp to name of first application process whose frontmost is true`,
    `end try`,
    ...body,
  ].join("\n");
}
