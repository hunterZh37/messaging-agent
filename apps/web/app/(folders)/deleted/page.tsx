import { FolderPage, type FolderSearchParams } from "../../inbox/FolderPage";

export const dynamic = "force-dynamic";

export default async function DeletedPage({ searchParams }: { searchParams: Promise<FolderSearchParams> }) {
  return <FolderPage folder="trash" searchParams={await searchParams} />;
}
