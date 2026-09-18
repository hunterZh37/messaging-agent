import { redirect } from "next/navigation";
import { requestIsUnlocked } from "@/lib/session";
import { UnlockForm } from "./UnlockForm";

export const metadata = { title: "Unlock Celeste" };

/** The lock screen a phone meets first (2026-09-14). */
export default async function UnlockPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Only a path inside the app: never somewhere a link could send the phone.
  const to = next && next.startsWith("/") && !next.startsWith("//") ? next : "/inbox";
  // Nothing to unlock for this Mac's own browser, or a phone already in
  // (2026-09-14: a tab sent here by the first version of the lock stayed here
  // on every reload). Straight on to where it was going.
  if (await requestIsUnlocked()) redirect(to);
  return (
    <main className="unlock">
      <div className="unlock-card">
        <h1>Celeste</h1>
        <p className="meta">Type the passcode set on your Mac.</p>
        <UnlockForm next={to} />
      </div>
    </main>
  );
}
