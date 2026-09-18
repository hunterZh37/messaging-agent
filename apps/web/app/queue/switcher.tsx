import { cookies } from "next/headers";
import { schema } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { ACCOUNT_COOKIE, selectedAccountId } from "@/lib/selection";
import { AccountSwitcher } from "./AccountSwitcher";


/**
 * What every page needs from the inbox switcher: the selected inbox to filter
 * by, and the control itself to hand to `Nav`. `searchAccount` is the page's
 * `?account=`, which wins over the remembered cookie for that visit.
 */
export async function inboxSwitcher(searchAccount: string | undefined): Promise<{
  selectedId: string | undefined;
  switcher: React.ReactNode;
}> {
  const { db } = core();
  // Messages on this Mac is not a mailbox to switch to (2026-09-11): it has its own folder.
  const accounts = db.select().from(schema.accounts).all().filter((a) => a.provider !== "imessage" && a.provider !== "whatsapp");
  const cookie = (await cookies()).get(ACCOUNT_COOKIE)?.value;
  const selectedId = selectedAccountId(searchAccount, cookie, accounts);
  const rows = accounts.map((a) => ({
    id: a.id,
    email: a.email,
    status: a.status,
  }));
  return { selectedId, switcher: <AccountSwitcher accounts={rows} selectedId={selectedId} /> };
}
