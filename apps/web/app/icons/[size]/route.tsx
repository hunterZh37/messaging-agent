import { appIcon } from "@/lib/appIcon";

const SIZES = new Set([192, 512]);

/** The manifest's icons, 192 and 512 pixels square (2026-09-14). */
export async function GET(_req: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!SIZES.has(size)) return new Response("Not found", { status: 404 });
  return appIcon(size);
}
