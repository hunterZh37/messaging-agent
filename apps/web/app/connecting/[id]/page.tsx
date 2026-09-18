import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { schema } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { Progress } from "./Progress";

export const dynamic = "force-dynamic";

export default async function ConnectingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db } = core();
  const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  if (!account) notFound();

  return (
    <main>
      <Progress accountId={account.id} email={account.email} />
    </main>
  );
}
