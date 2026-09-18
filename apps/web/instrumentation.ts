/**
 * Runs once when the server starts (Next.js instrumentation). It starts the
 * two things that bring messages in without a tab asking (2026-09-14): the
 * chat watcher, which syncs a text the moment Messages.app or WhatsApp writes
 * it, and the mail clock, which fetches mail every two minutes.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // A second server on this Mac (a trial run beside the real one) must not
  // sync the same inboxes at the same time as it.
  if (process.env.CELESTE_NO_BACKGROUND === "1") return;
  const { startChatWatchers } = await import("./lib/watch");
  startChatWatchers();
  const { startNotifying } = await import("./lib/push");
  startNotifying();
  const { startMailClock } = await import("./lib/mailClock");
  startMailClock();
  // The stats page is a second of scanning per range. Doing all four now,
  // once the server has settled, means the first press of a chip is as quick
  // as the second (operator, 2026-09-17). Detached: nothing waits on it, and
  // it gives way to the first real request.
  const { warmStats } = await import("./lib/statsCache");
  setTimeout(() => void warmStats(), 8_000).unref();
}
