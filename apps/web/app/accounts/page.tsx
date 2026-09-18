import { redirect } from "next/navigation";

/** The surface is called Inboxes now; old links still land in the right place. */
export default function AccountsPage() {
  redirect("/inboxes");
}
