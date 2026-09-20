import { describe, it, expect } from "vitest";
import { activeTreeKey, hasProjectBar, messagesLanding, parseFolder, parseStatus, rowsForSide, sideHref, sideOfPath, threadPath, treeRows, viewHref } from "../lib/folders";

describe("parseStatus", () => {
  it("takes only the statuses its folder has", () => {
    expect(parseStatus("inbox", "needs_reply")).toBe("needs_reply");
    expect(parseStatus("inbox", "waiting")).toBeUndefined();
    expect(parseStatus("inbox", "disposable")).toBe("disposable");
    // Safe to delete is an inbox idea; Deleted items does not carry it.
    expect(parseStatus("trash", "disposable")).toBeUndefined();
    expect(parseStatus("sent", "not_waiting")).toBe("not_waiting");
    expect(parseStatus("junk", "needs_reply")).toBeUndefined();
    expect(parseStatus("inbox", undefined)).toBeUndefined();
  });
});

describe("parseFolder", () => {
  it("falls back to the inbox for anything it does not know", () => {
    expect(parseFolder("sent")).toBe("sent");
    expect(parseFolder("trash")).toBe("trash");
    expect(parseFolder("archive")).toBe("inbox");
    expect(parseFolder(undefined)).toBe("inbox");
  });
});

const COUNTS = { inbox: 0, action: 0, owed: 7, knowing: 0, drafts: 2, needsReply: 5, unopened: 4, disposable: 6, waiting: 3 };

describe("treeRows", () => {
  it("lists Drafts, Inbox, Sent, Deleted items and Junk, with their children", () => {
    const rows = treeRows(COUNTS);
    expect(rows.map((r) => r.label)).toEqual([
      "Drafts",
      "Inbox",
      "Unopened",
      "Reply / Action Required",
      "Worth Knowing",
      "Safe to Delete",
      "Sent",
      "Waiting for reply",
      "Not waiting for reply",
      "Deleted items",
      "Archive",
      "Junk & Spam",
    ]);
    expect(rows.filter((r) => r.child).map((r) => r.key)).toEqual([
      "inbox:unopened",
      "inbox:owed",
      "inbox:knowing",
      "inbox:disposable",
      "sent:waiting",
      "sent:not_waiting",
    ]);
    expect(rows.every((r) => (r.child ? r.icon === null : r.icon !== null))).toBe(true);
  });

  it("carries the three counts and leaves the other rows at zero", () => {
    const byKey = Object.fromEntries(treeRows(COUNTS).map((r) => [r.key, r.count]));
    expect(byKey).toMatchObject({ drafts: 2, "inbox:owed": 7, "inbox:unopened": 4, "inbox:disposable": 6, "sent:waiting": 3, inbox: 0, sent: 0, trash: 0, junk: 0 });
  });

  it("takes the whole view with it, so a folder or a child row changes only itself", () => {
    const view = { account: "a1", since: "all", fin: "expense", project: "p1", cat: "FYI" };
    const byKey = Object.fromEntries(treeRows(COUNTS, { ...view, status: "needs_reply", folder: "sent", edit: "projects" }).map((r) => [r.key, r.href]));
    // The window, the money side, the project and the inbox all survive; the
    // row sets the status, and the open editor and the thread's folder do not
    // follow it to a folder page.
    expect(byKey["inbox:unopened"]).toBe("/inbox?account=a1&cat=FYI&fin=expense&since=all&status=unopened&project=p1");
    expect(byKey["inbox:disposable"]).toBe("/inbox?account=a1&cat=FYI&fin=expense&since=all&status=disposable&project=p1");
    expect(byKey.inbox).toBe("/inbox?account=a1&cat=FYI&fin=expense&since=all&project=p1");
    expect(byKey["sent:waiting"]).toBe("/sent?account=a1&cat=FYI&fin=expense&since=all&status=waiting&project=p1");
    expect(byKey.junk).toBe("/junk?account=a1&cat=FYI&fin=expense&since=all&project=p1");
    // The approval queue has no filters of its own.
    expect(byKey.drafts).toBe("/drafts");
  });
});

describe("activeTreeKey", () => {
  it("lights Drafts on the queue and Inboxes on the settings pages", () => {
    expect(activeTreeKey("/drafts")).toBe("drafts");
    expect(activeTreeKey("/connecting")).toBe("drafts");
    expect(activeTreeKey("/inboxes")).toBe("inboxes");
    expect(activeTreeKey("/accounts/new")).toBe("inboxes");
  });

  it("lights the folder a page shows, and its child row when a status narrows it", () => {
    expect(activeTreeKey("/inbox")).toBe("inbox");
    expect(activeTreeKey("/inbox", { status: "needs_reply" })).toBe("inbox:needs_reply");
    expect(activeTreeKey("/sent")).toBe("sent");
    expect(activeTreeKey("/sent", { status: "waiting" })).toBe("sent:waiting");
    expect(activeTreeKey("/deleted")).toBe("trash");
    expect(activeTreeKey("/junk")).toBe("junk");
  });

  it("keeps the row lit on a thread opened from that folder", () => {
    expect(activeTreeKey("/inbox/a1%3At1")).toBe("inbox");
    expect(activeTreeKey("/inbox/a1%3At1", { folder: "sent", status: "waiting" })).toBe("sent:waiting");
    expect(activeTreeKey("/inbox/a1%3At1", { folder: "junk" })).toBe("junk");
  });

  it("ignores a status that does not belong to the folder", () => {
    expect(activeTreeKey("/sent", { status: "needs_reply" })).toBe("sent");
    expect(activeTreeKey("/junk", { status: "waiting" })).toBe("junk");
  });
});

describe("viewHref", () => {
  it("keeps the page it is on and only changes what the link changes", () => {
    expect(viewHref("/inbox", { project: "p1" })).toBe("/inbox?project=p1");
    expect(viewHref("/deleted", { project: "unfiled" })).toBe("/deleted?project=unfiled");
    // A thread keeps its own path, so the header works beside an open message.
    expect(viewHref("/inbox/t1", { folder: "sent", project: "p1" })).toBe("/inbox/t1?folder=sent&project=p1");
  });

  it("carries the window, sub-category, money side and tree row through", () => {
    expect(viewHref("/inbox", { cat: "Scheduling", fin: "expense", since: "30d", status: "needs_reply", project: "p1" })).toBe(
      "/inbox?cat=Scheduling&fin=expense&since=30d&status=needs_reply&project=p1",
    );
  });

  it("sets one side of the money axis, and clears it to mean both", () => {
    const params = { fin: "income", since: "7d" };
    expect(viewHref("/inbox", params)).toBe("/inbox?fin=income&since=7d");
    expect(viewHref("/inbox", { ...params, fin: "expense" })).toBe("/inbox?fin=expense&since=7d");
    expect(viewHref("/inbox", { ...params, fin: undefined })).toBe("/inbox?since=7d");
  });

  it("drops a param the caller clears, which is how a tab goes back to All", () => {
    const params = { cat: "Scheduling", since: "7d", project: "p1" };
    expect(viewHref("/inbox", { ...params, project: undefined })).toBe("/inbox?cat=Scheduling&since=7d");
    expect(viewHref("/inbox", { ...params, cat: undefined })).toBe("/inbox?since=7d&project=p1");
    expect(viewHref("/inbox", {})).toBe("/inbox");
  });

  it("names the editor the Edit chip opens", () => {
    expect(viewHref("/sent", { since: "today", project: "p1", edit: "projects" })).toBe("/sent?since=today&project=p1&edit=projects");
    expect(viewHref("/inbox", { cat: "Scheduling", edit: "1" })).toBe("/inbox?cat=Scheduling&edit=1");
  });
});

describe("one link changes one dimension", () => {
  // The operator's complaint: clicking a tree row re-pressed the chips. Every
  // link is built from the whole view, so changing one leaves the rest alone.
  const view = { account: "a1", cat: "FYI", fin: "income", since: "30d", status: "needs_reply", project: "p1" };
  const DIMENSIONS = ["account", "cat", "fin", "since", "status", "project"] as const;

  it("leaves every other dimension exactly as it found it", () => {
    for (const changed of DIMENSIONS) {
      const href = viewHref("/inbox", { ...view, [changed]: "changed" });
      const got = new URLSearchParams(href.split("?")[1]);
      for (const other of DIMENSIONS) {
        if (other === changed) expect(got.get(other)).toBe("changed");
        else expect({ changed, other, value: got.get(other) }).toEqual({ changed, other, value: view[other] });
      }
    }
  });

  it("clears one dimension without touching the rest", () => {
    for (const cleared of DIMENSIONS) {
      const got = new URLSearchParams(viewHref("/inbox", { ...view, [cleared]: undefined }).split("?")[1]);
      expect(got.get(cleared)).toBeNull();
      for (const other of DIMENSIONS) {
        if (other !== cleared) expect({ cleared, other, value: got.get(other) }).toEqual({ cleared, other, value: view[other] });
      }
    }
  });

  it("opens a thread with the view intact, and the folder it came from", () => {
    expect(viewHref(threadPath("a1:t 1"), { ...view, folder: "sent" })).toBe(
      "/inbox/a1%3At%201?account=a1&cat=FYI&fin=income&since=30d&status=needs_reply&folder=sent&project=p1",
    );
  });
});

describe("hasProjectBar", () => {
  it("is true for every folder page, for a thread, and for Drafts", () => {
    expect(hasProjectBar("/inbox")).toBe(true);
    expect(hasProjectBar("/sent")).toBe(true);
    expect(hasProjectBar("/deleted")).toBe(true);
    expect(hasProjectBar("/junk")).toBe(true);
    expect(hasProjectBar("/inbox/t1")).toBe(true);
    expect(hasProjectBar("/drafts")).toBe(true);
  });

  it("is false for the inboxes page and the connect flow", () => {
    expect(hasProjectBar("/inboxes")).toBe(false);
    expect(hasProjectBar("/connecting/a1")).toBe(false);
  });
});

describe("activeTreeKey on the Usage page", () => {
  it("lights the Usage row, not Drafts", async () => {
    const { activeTreeKey } = await import("../lib/folders");
    expect(activeTreeKey("/usage")).toBe("usage");
    expect(activeTreeKey("/drafts")).toBe("drafts");
  });
});

/** Mail or Messages, top left (operator, 2026-09-14). */
describe("the Mail / Messages toggle", () => {
  const WITH_TEXTS = { ...COUNTS, texts: { needsReply: 9, unopened: 1, disposable: 3 } };

  it("splits the tree: mail folders on one side, the chat rows on the other", () => {
    const rows = treeRows(WITH_TEXTS);
    expect(rowsForSide(rows, "mail").map((r) => r.key)).toEqual(["drafts", "inbox", "inbox:unopened", "inbox:owed", "inbox:knowing", "inbox:disposable", "sent", "sent:waiting", "sent:not_waiting", "trash", "hidden", "junk"]);
    expect(rowsForSide(rows, "messages").map((r) => r.key)).toEqual(["messages", "messages:needs_reply", "messages:unopened", "messages:disposable", "messages:hidden"]);
  });

  // Hidden stands beside Deleted items rather than under Inbox, so the mail
  // side's row is keyed "hidden" and the open list still lights it up.
  it("lights the Hidden row on both sides", () => {
    expect(activeTreeKey("/inbox", { status: "hidden" })).toBe("hidden");
    expect(activeTreeKey("/messages", { status: "hidden" })).toBe("messages:hidden");
    const rows = treeRows(WITH_TEXTS);
    expect(rows.find((r) => r.key === "hidden")?.href).toBe("/inbox?status=hidden");
    expect(rows.find((r) => r.key === "messages:hidden")?.href).toBe("/messages?status=hidden");
  });

  it("knows which side a page is on, and leaves the settings pages to the side last chosen", () => {
    expect(sideOfPath("/messages", undefined)).toBe("messages");
    expect(sideOfPath("/inbox/a1%3At1", "messages")).toBe("messages");
    expect(sideOfPath("/inbox/a1%3At1", "sent")).toBe("mail");
    expect(sideOfPath("/inbox", undefined)).toBe("mail");
    expect(sideOfPath("/drafts", undefined)).toBe("mail");
    expect(sideOfPath("/deleted", undefined)).toBe("mail");
    expect(sideOfPath("/inboxes", undefined)).toBeNull();
    expect(sideOfPath("/usage", undefined)).toBeNull();
  });

  it("keeps the list the operator is on, the window, and the inbox only for Mail (2026-09-15)", () => {
    expect(sideHref("messages", { since: "7d", account: "a1", project: "p1", status: "unopened" })).toBe("/messages?since=7d&status=unopened");
    expect(sideHref("mail", { since: "7d", account: "a1", project: "p1", status: "disposable" })).toBe("/inbox?account=a1&since=7d&status=disposable");
    expect(sideHref("mail", { status: "needs_reply" })).toBe("/inbox?status=needs_reply");
  });

  it("lands on the plain folder when there is no list, or the other side does not have it", () => {
    expect(sideHref("messages", { since: "7d" })).toBe("/messages?since=7d");
    expect(sideHref("mail", {})).toBe("/inbox");
    expect(sideHref("messages", { status: "no_reply" })).toBe("/messages");
    expect(sideHref("messages", { status: "waiting", folder: "sent" })).toBe("/messages");
  });

  // Chats are read the other way round from mail (operator, 2026-09-15):
  // what nobody has opened pulls first, then what needs a reply.
  it("opens Messages on Unopened, or Need to reply, or all chats", () => {
    const at = (unopened: number, needsReply: number) => sideHref("messages", { since: "7d", status: "disposable" }, { unopened, needsReply });
    expect(at(3, 2)).toBe("/messages?since=7d&status=unopened");
    expect(at(0, 2)).toBe("/messages?since=7d&status=needs_reply");
    expect(at(0, 0)).toBe("/messages?since=7d");
  });

  it("leaves Mail's own rule alone: the list the operator is on comes along", () => {
    expect(sideHref("mail", { status: "unopened" }, { unopened: 0, needsReply: 9 })).toBe("/inbox?status=unopened");
  });

  it("carries the list across when no chat counts are to hand, as it did", () => {
    expect(sideHref("messages", { status: "needs_reply" })).toBe("/messages?status=needs_reply");
  });
});

describe("messagesLanding", () => {
  it("prefers what is unopened, since a chat nobody has read is the one that pulls", () => {
    expect(messagesLanding({ unopened: 1, needsReply: 40 })).toBe("unopened");
    expect(messagesLanding({ unopened: 0, needsReply: 1 })).toBe("needs_reply");
    expect(messagesLanding({ unopened: 0, needsReply: 0 })).toBeUndefined();
    expect(messagesLanding(undefined)).toBeUndefined();
  });
});
