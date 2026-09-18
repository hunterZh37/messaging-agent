import { describe, it, expect } from "vitest";
import {
  actionDoneLabel,
  actionLabel,
  appliesToOpenDraft,
  ASK_GENERAL_CONTEXT,
  askContextKey,
  askContextThreadId,
  askEmptyLine,
  askPlaceholder,
  askTabs,
  opensAskForDraft,
  autoRunsDraft,
  revisesOpenDraft,
  ASK_WIDTH_DEFAULT,
  ASK_WIDTH_MIN,
  chatCountLabel,
  chatTitleLabel,
  citationChipLabel,
  citeAnchorId,
  clampAskWidth,
  renderAnswer,
  resizeStep,
  sendsOnEnter,
  widthFromDrag,
  threadChipLabel,
  threadsOf,
  togglesAsk,
} from "../lib/chat";

describe("renderAnswer", () => {
  it("renders bold", () => {
    expect(renderAnswer("The **March invoice** is due.")).toBe("<p>The <strong>March invoice</strong> is due.</p>");
  });

  it("renders a bulleted list, and the paragraph above it", () => {
    expect(renderAnswer("Two things:\n- pay Acme\n- answer Bob")).toBe("<p>Two things:</p><ul><li>pay Acme</li><li>answer Bob</li></ul>");
  });

  it("renders a numbered list, keeping the number it starts on", () => {
    expect(renderAnswer("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
    expect(renderAnswer("3. third\n4. fourth")).toBe('<ol start="3"><li>third</li><li>fourth</li></ol>');
  });

  it("splits paragraphs on a blank line and keeps a single break inside one", () => {
    expect(renderAnswer("One.\n\nTwo.")).toBe("<p>One.</p><p>Two.</p>");
    expect(renderAnswer("One.\nStill one.")).toBe("<p>One.<br />Still one.</p>");
  });

  it("escapes everything else, so markup in an answer stays text", () => {
    const html = renderAnswer('<img src=x onerror="alert(1)"> & <b>bold</b>');
    expect(html).toBe("<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;b&gt;bold&lt;/b&gt;</p>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });

  it("escapes inside a list item and inside bold too", () => {
    expect(renderAnswer("- **<script>** ok")).toBe("<ul><li><strong>&lt;script&gt;</strong> ok</li></ul>");
  });

  it("turns every marker into a numbered superscript, in the order first seen", () => {
    expect(renderAnswer("Acme billed you [msg:a1:m1]. Bob agreed [msg:a1:m2].")).toBe(
      '<p>Acme billed you<sup class="ask-ref">1</sup>. Bob agreed<sup class="ask-ref">2</sup>.</p>',
    );
  });

  it("gives a marker it has already numbered the same number again", () => {
    expect(renderAnswer("a [msg:x] b [msg:y] c [msg:x]")).toBe(
      '<p>a<sup class="ask-ref">1</sup> b<sup class="ask-ref">2</sup> c<sup class="ask-ref">1</sup></p>',
    );
  });

  it("links a superscript to its chip when the caller has one, and leaves it plain when not", () => {
    const html = renderAnswer("known [msg:a1:m1] unknown [msg:a1:m9]", (id, n) => (id === "a1:m1" ? `#cite-${n}` : undefined));
    expect(html).toBe('<p>known<sup class="ask-ref"><a href="#cite-1">1</a></sup> unknown<sup class="ask-ref">2</sup></p>');
  });

  it("never lets a marker carry markup out of the answer", () => {
    const html = renderAnswer("see [msg:a1:m1]", () => '"><script>alert(1)</script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("is empty for an empty answer", () => {
    expect(renderAnswer("")).toBe("");
  });
});

describe("citeAnchorId", () => {
  it("is a plain id whatever the message id holds", () => {
    expect(citeAnchorId("0001-000002", "a1:m1")).toBe("cite-0001-000002-a1-m1");
  });

  it("differs per turn, so two answers citing the same message do not collide", () => {
    expect(citeAnchorId("t1", "a1:m1")).not.toBe(citeAnchorId("t2", "a1:m1"));
  });
});

describe("sendsOnEnter", () => {
  it("sends on Enter, breaks the line on Shift+Enter", () => {
    expect(sendsOnEnter({ key: "Enter", shiftKey: false })).toBe(true);
    expect(sendsOnEnter({ key: "Enter", shiftKey: true })).toBe(false);
    expect(sendsOnEnter({ key: "a", shiftKey: false })).toBe(false);
  });

  it("leaves an IME candidate to the IME", () => {
    expect(sendsOnEnter({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true } })).toBe(false);
  });
});

describe("clampAskWidth", () => {
  it("leaves a sensible width alone", () => {
    expect(clampAskWidth(520, 1600)).toBe(520);
    expect(clampAskWidth(ASK_WIDTH_DEFAULT, 1600)).toBe(ASK_WIDTH_DEFAULT);
  });

  it("never goes below the minimum, however far the edge is dragged", () => {
    expect(clampAskWidth(120, 1600)).toBe(ASK_WIDTH_MIN);
    expect(clampAskWidth(-400, 1600)).toBe(ASK_WIDTH_MIN);
  });

  it("never takes more than three fifths of the window", () => {
    expect(clampAskWidth(1500, 1600)).toBe(960);
    expect(clampAskWidth(900, 1000)).toBe(600);
  });

  it("keeps the minimum on a window too small for the fraction", () => {
    expect(clampAskWidth(400, 400)).toBe(ASK_WIDTH_MIN);
  });

  it("rounds to whole pixels and falls back for nonsense", () => {
    expect(clampAskWidth(480.6, 1600)).toBe(481);
    expect(clampAskWidth(Number.NaN, 1600)).toBe(ASK_WIDTH_DEFAULT);
  });
});

describe("widthFromDrag", () => {
  it("widens by however far the pointer went left, and narrows going right", () => {
    expect(widthFromDrag(380, 1000, 900)).toBe(480);
    expect(widthFromDrag(380, 1000, 1100)).toBe(280);
    expect(widthFromDrag(380, 1000, 1000)).toBe(380);
  });

  it("measures from where the drag started, not from the last move", () => {
    // Two moves in one drag: the second is not relative to the first.
    expect(widthFromDrag(380, 1000, 950)).toBe(430);
    expect(widthFromDrag(380, 1000, 900)).toBe(480);
  });
});

describe("resizeStep", () => {
  it("grows on the left, shrinks on the right, and takes bigger steps with Shift", () => {
    expect(resizeStep("ArrowLeft", false)).toBe(16);
    expect(resizeStep("ArrowRight", false)).toBe(-16);
    expect(resizeStep("ArrowLeft", true)).toBe(64);
    expect(resizeStep("ArrowRight", true)).toBe(-64);
  });

  it("moves nothing for any other key", () => {
    expect(resizeStep("ArrowUp", false)).toBe(0);
    expect(resizeStep("a", true)).toBe(0);
  });
});

describe("togglesAsk", () => {
  it("is ⌘/ or Ctrl+/, nothing else", () => {
    expect(togglesAsk({ key: "/", metaKey: true, ctrlKey: false })).toBe(true);
    expect(togglesAsk({ key: "/", metaKey: false, ctrlKey: true })).toBe(true);
    expect(togglesAsk({ key: "/", metaKey: false, ctrlKey: false })).toBe(false);
    expect(togglesAsk({ key: "k", metaKey: true, ctrlKey: false })).toBe(false);
  });
});

describe("threadsOf", () => {
  it("reads the list, and the single thread a stored proposal used to carry", () => {
    expect(threadsOf({ kind: "mark_handled", threadIds: ["t1", "t2"] })).toEqual(["t1", "t2"]);
    expect(threadsOf({ kind: "mark_handled", threadIds: [], threadId: "t1" })).toEqual(["t1"]);
    expect(threadsOf({ kind: "mark_handled", threadIds: [] })).toEqual([]);
  });
});

describe("appliesToOpenDraft", () => {
  it("is live only while the draft the proposal was made over is the open one", () => {
    expect(appliesToOpenDraft("d1", "d1")).toBe(true);
    expect(appliesToOpenDraft("d1", "d2")).toBe(false);
    expect(appliesToOpenDraft("d1", null)).toBe(false);
    // A turn from before turns remembered the draft: whatever is open is what it meant.
    expect(appliesToOpenDraft(null, "d1")).toBe(true);
    expect(appliesToOpenDraft(null, null)).toBe(false);
  });
});

describe("actionLabel", () => {
  it("names every kind for one thread, and the project when there is one", () => {
    expect(actionLabel({ kind: "draft_reply", threadIds: ["t"] })).toBe("Draft a reply");
    expect(actionLabel({ kind: "draft_follow_up", threadIds: ["t"] })).toBe("Follow up");
    expect(actionLabel({ kind: "file_to_project", threadIds: ["t"], projectName: "Acme" })).toBe("File to Acme");
    expect(actionLabel({ kind: "file_to_project", threadIds: ["t"] })).toBe("File to a project");
    expect(actionLabel({ kind: "mark_handled", threadIds: ["t"] })).toBe("Mark handled");
    expect(actionLabel({ kind: "open_thread", threadIds: ["t"] })).toBe("Open");
    expect(actionLabel({ kind: "apply_draft", threadIds: ["t"], text: "New body." })).toBe("Apply to draft");
  });

  it("carries the count when a proposal covers several threads", () => {
    const six = ["1", "2", "3", "4", "5", "6"];
    expect(actionLabel({ kind: "file_to_project", threadIds: six, projectName: "Immigration" })).toBe("File 6 threads to Immigration");
    expect(actionLabel({ kind: "mark_handled", threadIds: six })).toBe("Mark 6 handled");
    expect(actionLabel({ kind: "draft_reply", threadIds: ["1", "2", "3"] })).toBe("Draft replies to 3 threads");
    expect(actionLabel({ kind: "draft_follow_up", threadIds: ["1", "2", "3"] })).toBe("Draft follow-ups to 3 threads");
    expect(actionLabel({ kind: "open_thread", threadIds: ["1", "2", "3"] })).toBe("Open 3 threads");
  });

  it("leads with the project when the click is what creates it", () => {
    const six = ["1", "2", "3", "4", "5", "6"];
    expect(actionLabel({ kind: "file_to_project", threadIds: six, projectName: "Immigration", createProject: true })).toBe(
      "Create Immigration and file 6 threads",
    );
    expect(actionLabel({ kind: "file_to_project", threadIds: ["1"], projectName: "Immigration", createProject: true })).toBe(
      "Create Immigration and file this thread",
    );
  });

  it("reads a proposal stored before proposals could hold several threads", () => {
    expect(actionLabel({ kind: "mark_handled", threadIds: [], threadId: "t1" })).toBe("Mark handled");
  });
});

describe("actionDoneLabel", () => {
  it("says how many it did, and how many it could not", () => {
    expect(actionDoneLabel("draft_reply", 3, 0)).toBe("3 drafts created");
    expect(actionDoneLabel("draft_reply", 1, 0)).toBe("1 draft created");
    expect(actionDoneLabel("draft_follow_up", 2, 1)).toBe("2 drafts created, 1 failed");
    expect(actionDoneLabel("file_to_project", 6, 0, "Immigration")).toBe("Filed 6 to Immigration");
    expect(actionDoneLabel("mark_handled", 6, 0)).toBe("6 marked handled");
    expect(actionDoneLabel("apply_draft", 1, 0)).toBe("Applied to the draft");
  });
});

describe("citationChipLabel", () => {
  it("is the subject and the sender's name, without the address", () => {
    expect(citationChipLabel({ subject: "March invoice", from: "Acme <billing@acme.test>" })).toBe("March invoice · Acme");
    expect(citationChipLabel({ subject: "Lunch", from: "bob@example.com" })).toBe("Lunch · bob@example.com");
  });
});

describe("threadChipLabel", () => {
  const action = {
    kind: "file_to_project" as const,
    threadIds: ["t1", "t2"],
    threads: [
      { id: "t1", subject: "Visa timeline", from: "Victoria Chen <victoria@example.com>" },
      { id: "t2", subject: "(no subject)", from: "noreply@example.com" },
    ],
  };
  it("names a thread by subject and sender", () => {
    expect(threadChipLabel(action, "t1", 0)).toBe("Visa timeline · Victoria Chen");
  });
  it("shows a bare address when the sender has no name", () => {
    expect(threadChipLabel(action, "t2", 1)).toBe("(no subject) · noreply@example.com");
  });
  it("falls back to the position for turns stored without names", () => {
    expect(threadChipLabel({ kind: "mark_handled", threadIds: ["t1", "t9"] }, "t9", 1)).toBe("Thread 2");
    expect(threadChipLabel(action, "t9", 2)).toBe("Thread 3");
  });
});

describe("askContextKey", () => {
  it("is the open thread's when there is one", () => {
    expect(askContextKey({ threadId: "a1:t1" })).toBe("a1:t1");
  });
  it("is the draft's thread when only a draft is open", () => {
    expect(askContextKey({ draftThreadId: "a1:t2" })).toBe("a1:t2");
  });
  it("puts a draft in the conversation of the thread it answers", () => {
    expect(askContextKey({ threadId: "a1:t1", draftThreadId: "a1:t1" })).toBe("a1:t1");
  });
  it("is General when nothing is open", () => {
    expect(askContextKey({})).toBe(ASK_GENERAL_CONTEXT);
    expect(askContextKey({ threadId: null, draftThreadId: null })).toBe(ASK_GENERAL_CONTEXT);
  });
  it("carries no thread on a question asked in General", () => {
    expect(askContextThreadId({})).toBeNull();
    expect(askContextThreadId({ draftThreadId: "a1:t2" })).toBe("a1:t2");
  });
});

describe("askEmptyLine", () => {
  it("names the draft when one is on the card", () => {
    expect(askEmptyLine({ threadId: "a1:t1", draftThreadId: "a1:t1" })).toContain("Ask about this draft, or say what to change");
  });
  it("names the thread when one is open", () => {
    expect(askEmptyLine({ threadId: "a1:t1" })).toBe("Ask about this thread.");
  });
  it("says what the panel is for when nothing is open", () => {
    expect(askEmptyLine({})).toContain("anything in your mail");
  });
});

describe("chatCountLabel", () => {
  it("counts one message in the singular", () => expect(chatCountLabel(1)).toBe("1 message"));
  it("counts the rest in the plural", () => {
    expect(chatCountLabel(0)).toBe("0 messages");
    expect(chatCountLabel(4)).toBe("4 messages");
  });
});

/**
 * A draft proposal for the thread whose card is already open, carrying the
 * operator's words (2026-09-14): the open draft is rewritten to say them,
 * never a second card of the same mail.
 */
describe("revisesOpenDraft", () => {
  const reply = (instruction: string | undefined, ...threadIds: string[]) => ({ kind: "draft_reply" as const, threadIds, ...(instruction !== undefined ? { instruction } : {}) });

  it("revises the open draft with the operator's words", () => {
    const action = reply("say I have reached out to Ryan", "a1:t1");
    expect(revisesOpenDraft([action], { draftThreadId: "a1:t1" })).toEqual({ action, instruction: "say I have reached out to Ryan" });
  });

  it("does the same for a follow-up", () => {
    const action = { kind: "draft_follow_up" as const, threadIds: ["a1:t1"], instruction: "nudge gently" };
    expect(revisesOpenDraft([action], { draftThreadId: "a1:t1" })?.instruction).toBe("nudge gently");
  });

  it("leaves a proposal without words alone: there is nothing to revise toward", () => {
    expect(revisesOpenDraft([reply(undefined, "a1:t1")], { draftThreadId: "a1:t1" })).toBeNull();
    expect(revisesOpenDraft([reply("  ", "a1:t1")], { draftThreadId: "a1:t1" })).toBeNull();
  });

  it("leaves a proposal for another thread, or for several, as a button", () => {
    expect(revisesOpenDraft([reply("x", "a1:t2")], { draftThreadId: "a1:t1" })).toBeNull();
    expect(revisesOpenDraft([reply("x", "a1:t1", "a1:t2")], { draftThreadId: "a1:t1" })).toBeNull();
  });

  it("does nothing when no draft is open", () => {
    expect(revisesOpenDraft([reply("x", "a1:t1")], { draftThreadId: null })).toBeNull();
    expect(revisesOpenDraft([reply("x", "a1:t1")], {})).toBeNull();
  });
});

/** With the card's revise field gone (2026-09-14), the box says the draft is revised here. */
describe("askPlaceholder", () => {
  it("invites a change to the draft when one is open", () => {
    expect(askPlaceholder({ draftThreadId: "a1:t1" })).toBe("Ask Celeste, or say what to change in the draft…");
  });
  it("is the plain invitation otherwise", () => {
    expect(askPlaceholder({ draftThreadId: null })).toBe("Ask Celeste…");
    expect(askPlaceholder({})).toBe("Ask Celeste…");
  });
});

/** A draft brings the panel with it on a wide desktop, once (2026-09-14). */
describe("opensAskForDraft", () => {
  const base = { open: false, width: 1400, draftId: "d1", openedFor: null };
  it("opens for a draft on a wide screen while the panel is closed", () => {
    expect(opensAskForDraft(base)).toBe(true);
  });
  it("stays out of the way on a phone or a narrow desktop, where it would cover the card", () => {
    expect(opensAskForDraft({ ...base, width: 1199 })).toBe(false);
    expect(opensAskForDraft({ ...base, width: 390 })).toBe(false);
  });
  it("does nothing when already open, or with no draft", () => {
    expect(opensAskForDraft({ ...base, open: true })).toBe(false);
    expect(opensAskForDraft({ ...base, draftId: null })).toBe(false);
  });
  it("opens once per draft: closed again by the operator, it stays closed for that card", () => {
    expect(opensAskForDraft({ ...base, openedFor: "d1" })).toBe(false);
    expect(opensAskForDraft({ ...base, openedFor: "d0" })).toBe(true);
  });
});

/** General or the thread on screen, as two tabs (2026-09-14). */
describe("askTabs", () => {
  it("is nothing when nothing is open: General is the only place then", () => {
    expect(askTabs({ onScreen: null, looking: false })).toEqual([]);
  });
  it("names the thread and marks which tab the panel is on", () => {
    expect(askTabs({ onScreen: { subject: "RFE letter" }, looking: true })).toEqual([
      { key: "general", label: "General", active: false },
      { key: "thread", label: "RFE letter", active: true },
    ]);
    expect(askTabs({ onScreen: { subject: "RFE letter" }, looking: false }).map((t) => t.active)).toEqual([true, false]);
  });
  it("names a draft by who it goes to when there is no thread subject", () => {
    expect(askTabs({ onScreen: { subject: null, draftTo: "dana@example.com" }, looking: true })[1]?.label).toBe("Draft to dana@example.com");
    expect(askTabs({ onScreen: { subject: "", draftTo: null }, looking: true })[1]?.label).toBe("This thread");
  });
});

describe("chatTitleLabel", () => {
  it("keeps the title it was given", () => expect(chatTitleLabel("March invoice · Bob")).toBe("March invoice · Bob"));
  it("has something to say for a conversation with no name", () => {
    expect(chatTitleLabel("")).toBe("Conversation");
    expect(chatTitleLabel(null)).toBe("Conversation");
  });
});

/**
 * The draft Celeste writes without being asked twice (spec 10c, 2026-09-10):
 * one thread, the one on screen, and no draft of it already in front of them.
 */
describe("autoRunsDraft", () => {
  const reply = (...threadIds: string[]) => ({ kind: "draft_reply" as const, threadIds });

  it("runs a reply for the thread the operator has open", () => {
    expect(autoRunsDraft([reply("a1:t1")], { threadId: "a1:t1" })).toEqual({ action: reply("a1:t1"), threadId: "a1:t1" });
  });

  it("runs a follow-up the same way", () => {
    const followUp = { kind: "draft_follow_up" as const, threadIds: ["a1:t1"] };
    expect(autoRunsDraft([followUp], { threadId: "a1:t1" })?.threadId).toBe("a1:t1");
  });

  it("leaves a proposal over several threads as a button", () => {
    expect(autoRunsDraft([reply("a1:t1", "a1:t2")], { threadId: "a1:t1" })).toBeNull();
  });

  it("leaves a proposal for a thread they are not on as a button", () => {
    expect(autoRunsDraft([reply("a1:t2")], { threadId: "a1:t1" })).toBeNull();
  });

  it("does nothing when no thread is open", () => {
    expect(autoRunsDraft([reply("a1:t1")], {})).toBeNull();
    expect(autoRunsDraft([reply("a1:t1")], { threadId: null })).toBeNull();
  });

  it("does not write a second draft of a thread whose draft is already on screen", () => {
    expect(autoRunsDraft([reply("a1:t1")], { threadId: "a1:t1", draftThreadId: "a1:t1" })).toBeNull();
  });

  it("still runs when the draft on screen belongs to another thread", () => {
    expect(autoRunsDraft([reply("a1:t1")], { threadId: "a1:t1", draftThreadId: "a1:t9" })?.threadId).toBe("a1:t1");
  });

  it("ignores everything that is not a draft", () => {
    const handled = { kind: "mark_handled" as const, threadIds: ["a1:t1"] };
    expect(autoRunsDraft([handled], { threadId: "a1:t1" })).toBeNull();
    expect(autoRunsDraft([handled, reply("a1:t1")], { threadId: "a1:t1" })?.threadId).toBe("a1:t1");
  });
});
