import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { desc, eq } from "drizzle-orm";
import { Geist } from "next/font/google";
import { conversationUsage, listChatMessages, openChatFor, schema } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { ASK_COOKIE } from "@/lib/selection";
import { requestIsUnlocked } from "@/lib/session";
import { OPEN_SCRIPT } from "@/lib/landing";
import { AskProvider } from "./ask/AskProvider";
import { SendProvider } from "./queue/SendProvider";
import { SyncProvider } from "./queue/sync";
import { TopBar } from "./queue/TopBar";
import { ThemeGuard } from "./queue/ThemeGuard";
import "./globals.css";
import "./phone.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

export const metadata = {
  title: "Celeste",
  // Added to the home screen, it opens full screen under a see-through status bar (2026-09-14).
  appleWebApp: { capable: true, title: "Celeste", statusBarStyle: "black-translucent" as const },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  // The page runs under the status bar and the home indicator, and makes room with safe-area insets.
  viewportFit: "cover" as const,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f4f6" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0e0b" },
  ],
};
export const dynamic = "force-dynamic";

// Runs before styles apply so the correct theme paints on first frame: no
// flash of the wrong theme. Reads the saved choice, else follows the OS.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("celeste-theme");if(t!=="day"&&t!=="night"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"day":"night";}document.documentElement.dataset.theme=t;}catch(e){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // A phone that has not unlocked gets the page and nothing of the app around
  // it (2026-09-14): no inbox names, no Ask conversation in the HTML.
  if (!(await requestIsUnlocked())) {
    return (
      <html lang="en" className={geist.variable} suppressHydrationWarning>
        <head>
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        </head>
        <body suppressHydrationWarning>{children}</body>
      </html>
    );
  }
  const { db } = core();
  const lastSyncAt = db.select({ at: schema.watermarks.lastSyncAt }).from(schema.watermarks).orderBy(desc(schema.watermarks.lastSyncAt)).get()?.at ?? null;
  const accountCount = db.select().from(schema.accounts).all().length;
  const needsSignin = db
    .select({ email: schema.accounts.email })
    .from(schema.accounts)
    .where(eq(schema.accounts.status, "needs_signin"))
    .all()
    .map((a) => a.email);

  // General is the conversation the panel opens on (spec 10c, 2026-09-10), so
  // it paints from the server rather than fetching after mount. A page with a
  // thread or a draft says so once it is mounted, and the panel swaps to that
  // thread's conversation.
  const generalChat = openChatFor(db, {});
  const initialChat = { chat: generalChat, turns: listChatMessages(db, generalChat.id), usage: conversationUsage(db, generalChat.id) };
  const askOpen = (await cookies()).get(ASK_COOKIE)?.value === "1";

  return (
    <html lang="en" className={geist.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Opening Celeste picks the row to land on (2026-09-15). */}
        <script dangerouslySetInnerHTML={{ __html: OPEN_SCRIPT }} />
      </head>
      {/* Extensions (Grammarly and friends) stamp attributes on body before React loads. */}
      <body suppressHydrationWarning>
        <ThemeGuard />
        <SyncProvider lastSyncAt={lastSyncAt} accountCount={accountCount}>
          <AskProvider initialOpen={askOpen} initialChat={initialChat}>
            <TopBar accountCount={accountCount} needsSignin={needsSignin} />
            {/* The send gate sits above the routes, so the six seconds and
                the Undo go on counting while the operator reads something
                else (spec 8, 2026-09-10). */}
            <SendProvider>{children}</SendProvider>
          </AskProvider>
        </SyncProvider>
      </body>
    </html>
  );
}
