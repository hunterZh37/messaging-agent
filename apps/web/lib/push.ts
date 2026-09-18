import webpush from "web-push";
import { deleteSubscription, listSubscriptions, needsReplySince, noticesFor, type Notice } from "@messaging-agent/core";
import { core } from "@/lib/core";

/**
 * Push notifications to the phone (2026-09-14, the mobile plan's option 1).
 * The keys that sign them live in .env as CELESTE_VAPID_PUBLIC and
 * CELESTE_VAPID_PRIVATE; with none set, nothing is sent and the toggle says so.
 */
export function vapidPublicKey(): string | null {
  core();
  return process.env.CELESTE_VAPID_PUBLIC?.trim() || null;
}

function configured(): boolean {
  core();
  const pub = process.env.CELESTE_VAPID_PUBLIC?.trim();
  const priv = process.env.CELESTE_VAPID_PRIVATE?.trim();
  if (!pub || !priv) return false;
  // The push services want a way to reach whoever runs this instance. A
  // mailto: or a URL both count; without one set there is nobody to reach,
  // so notifications stay off rather than going out under someone else's name.
  const subject = process.env.CELESTE_VAPID_SUBJECT?.trim();
  if (!subject) return false;
  webpush.setVapidDetails(subject, pub, priv);
  return true;
}

/** Sends each notice to every subscribed phone; a subscription the push service says is gone is forgotten. */
export async function sendNotices(notices: Notice[]): Promise<{ sent: number; gone: number }> {
  if (notices.length === 0 || !configured()) return { sent: 0, gone: 0 };
  const { db } = core();
  let sent = 0;
  let gone = 0;
  for (const sub of listSubscriptions(db)) {
    for (const n of notices) {
      try {
        await webpush.sendNotification(sub, JSON.stringify(n), { TTL: 3600, urgency: "high" });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          deleteSubscription(db, sub.endpoint);
          gone++;
          break;
        }
        console.error(`push: ${status ?? ""} ${(err as Error).message}`);
      }
    }
  }
  return { sent, gone };
}

// What has already been said, by the time the newest message said about was
// stored. Starts at the moment the server does: a restart never replays the
// day's mail to the phone.
const KEY = Symbol.for("celeste.pushSaidUpTo");

/**
 * Tells the phone about whatever landed in Need to reply since last time
 * (2026-09-14). Called after the chat watcher stores a text and after mail
 * is sorted, which is when mail can first be in Need to reply.
 */
export async function notifyNeedsReply(): Promise<void> {
  const g = globalThis as unknown as Record<symbol, number | undefined>;
  g[KEY] ??= Date.now();
  if (!configured()) return;
  const { db } = core();
  const rows = needsReplySince(db, g[KEY]!);
  if (rows.length === 0) return;
  g[KEY] = Math.max(g[KEY]!, ...rows.map((r) => r.message.receivedAt));
  const r = await sendNotices(noticesFor(rows));
  if (r.sent > 0) console.log(`push: ${r.sent} sent`);
}

/** Starts the clock of what has been said, at server start. */
export function startNotifying(): void {
  const g = globalThis as unknown as Record<symbol, number | undefined>;
  g[KEY] ??= Date.now();
}
