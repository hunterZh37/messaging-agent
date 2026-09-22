import { readDiagram } from "@/lib/diagram";

export const dynamic = "force-dynamic";

/**
 * The system diagram, served to the frame on /architecture. Read from disk on
 * every request and never cached, so a commit, a pull or the background sync
 * agent shows up on the next reload rather than at the next build.
 */
export async function GET() {
  const html = await readDiagram();
  if (html === null) {
    return new Response("The system diagram has not been rendered yet.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
