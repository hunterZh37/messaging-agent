import { FolderPage, type FolderSearchParams } from "../../inbox/FolderPage";

export const dynamic = "force-dynamic";

export default async function JunkPage({ searchParams }: { searchParams: Promise<FolderSearchParams> }) {
  return <FolderPage folder="junk" searchParams={await searchParams} />;
}
