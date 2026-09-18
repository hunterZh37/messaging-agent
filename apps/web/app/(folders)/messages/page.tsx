import { FolderPage, type FolderSearchParams } from "../../inbox/FolderPage";

export const dynamic = "force-dynamic";

/** Texts on this Mac (2026-09-11): the same folder page, over the chats. */
export default async function MessagesPage({ searchParams }: { searchParams: Promise<FolderSearchParams> }) {
  return <FolderPage folder="messages" searchParams={await searchParams} />;
}
