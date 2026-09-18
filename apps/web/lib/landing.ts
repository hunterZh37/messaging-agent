/**
 * Where Celeste opens (operator, 2026-09-15): Need to reply, or Unopened when
 * nothing needs a reply, or the Inbox when both are empty. Counted over what
 * the tree shows on a fresh open, so the row it lands on is never empty.
 */
export function landingHref(counts: { needsReply: number; unopened: number }): string {
  if (counts.needsReply > 0) return "/inbox?status=needs_reply";
  if (counts.unopened > 0) return "/inbox?status=unopened";
  return "/inbox";
}

/**
 * The addresses Celeste is opened by: the Inbox, and the Need to reply link
 * the phone's home-screen app was installed with. A thread, any other folder,
 * or a link with more on it is where the operator meant to go.
 */
export function isEntryAddress(pathname: string, search: string): boolean {
  return pathname === "/inbox" && (search === "" || search === "?" || search === "?status=needs_reply");
}

/** The tab's own mark that Celeste has opened in it. */
export const OPENED_KEY = "celeste-opened";

/**
 * Runs in the head of every page, before it paints. The first page of a tab
 * (a new tab, or the home-screen app launched afresh) that came in by an entry
 * address goes by `/`, which picks the row. Session storage belongs to the tab
 * and survives a reload, so a reload or a click on Inbox later stays put; a
 * session cookie did not work, because Chrome and the phone keep those long
 * after the app is closed (operator, 2026-09-15: "it is still need to reply
 * when it is empty"). When storage cannot be written nothing moves, so there
 * is no loop.
 */
export const OPEN_SCRIPT = `(function(){try{var k=${JSON.stringify(OPENED_KEY)};if(sessionStorage.getItem(k))return;sessionStorage.setItem(k,"1");if(sessionStorage.getItem(k)!=="1")return;var p=location.pathname,s=location.search;if(p==="/inbox"&&(s===""||s==="?"||s==="?status=needs_reply"))location.replace("/");}catch(e){}})();`;

/** The page `/` answers with: mark the tab as opened, then go. */
export function landingPage(href: string): string {
  const to = JSON.stringify(href);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0d0e0b"><title>Celeste</title><style>html{background:#0d0e0b}</style><script>try{sessionStorage.setItem(${JSON.stringify(OPENED_KEY)},"1")}catch(e){}location.replace(${to});</script><noscript><meta http-equiv="refresh" content="0;url=${href}"></noscript>`;
}
