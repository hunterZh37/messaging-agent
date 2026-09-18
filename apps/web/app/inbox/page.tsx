import { FolderPage, type FolderSearchParams } from "./FolderPage";

export const dynamic = "force-dynamic";

export default async function InboxPage({ searchParams }: { searchParams: Promise<FolderSearchParams> }) {
  return <FolderPage folder="inbox" searchParams={await searchParams} />;
}
