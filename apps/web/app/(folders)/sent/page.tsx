import { FolderPage, type FolderSearchParams } from "../../inbox/FolderPage";

export const dynamic = "force-dynamic";

export default async function SentPage({ searchParams }: { searchParams: Promise<FolderSearchParams> }) {
  return <FolderPage folder="sent" searchParams={await searchParams} />;
}
