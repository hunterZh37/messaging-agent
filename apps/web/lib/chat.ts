import type { ChatMessageRow, Citation, ProposedAction } from "@messaging-agent/core";

/** How Celeste cites a message in her answer: `[msg:<id>]` right after the sentence it supports. */
const CITATION = /\s*\[msg:([^\]\s]+)\]/g;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Escaped first, then the one inline mark Celeste writes. Nothing else survives as HTML. */
function formatText(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** Where a citation's chip sits, so the superscript in the answer can point at it. */
export function citeAnchorId(turnId: string, messageId: string): string {
  return `cite-${`${turnId}-${messageId}`.replace(/[^a-zA-Z0-9-]+/g, "-")}`;
}

/**
 * Celeste's answer as HTML (spec 10c). She writes light markdown — bold,
 * bulleted and numbered lists, paragraphs — and this renders that much and
 * nothing else: every character she wrote is escaped first, so the only tags
 * in the result are the ones built here. Mail is untrusted and so is what a
 * model makes of it; no HTML of hers ever reaches the DOM.
 *
 * `[msg:<id>]` markers become small superscript numbers, numbered in the
 * order they first appear and linked to their chip under the answer.
 */
export function renderAnswer(answer: string, hrefForCitation?: (messageId: string, ordinal: number) => string | undefined): string {
  const order: string[] = [];

  function reference(messageId: string): string {
    let at = order.indexOf(messageId);
    if (at === -1) at = order.push(messageId) - 1;
    const ordinal = at + 1;
    const href = hrefForCitation?.(messageId, ordinal);
    const label = String(ordinal);
    return href ? `<sup class="ask-ref"><a href="${escapeHtml(href)}">${label}</a></sup>` : `<sup class="ask-ref">${label}</sup>`;
  }

  // The id goes to the caller raw and into the href escaped: the text around
  // it is escaped separately, so a marker can never carry markup out.
  function inline(line: string): string {
    let out = "";
    let last = 0;
    for (const match of line.matchAll(CITATION)) {
      out += formatText(line.slice(last, match.index));
      out += reference(match[1]!);
      last = match.index + match[0].length;
    }
    return out + formatText(line.slice(last));
  }

  const html: string[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  let list: "ul" | "ol" | null = null;
  let start = 1;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.join("<br />")}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!list || items.length === 0) {
      list = null;
      items = [];
      return;
    }
    // A list that starts at 3 is the third thing she is counting, not the first.
    const attr = list === "ol" && start !== 1 ? ` start="${start}"` : "";
    html.push(`<${list}${attr}>${items.map((i) => `<li>${i}</li>`).join("")}</${list}>`);
    list = null;
    items = [];
  }

  for (const raw of answer.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = /^\s*[-*\u2022]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (list !== "ul") flushList();
      list = "ul";
      items.push(inline(bullet[1]!));
      continue;
    }
    const numbered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      if (list !== "ol") {
        flushList();
        start = Number(numbered[1]);
      }
      list = "ol";
      items.push(inline(numbered[2]!));
      continue;
    }
    flushList();
    paragraph.push(inline(line));
  }
  flushParagraph();
  flushList();
  return html.join("");
}

/** Enter sends, Shift+Enter starts a new line, and an IME candidate is neither. */
export function sendsOnEnter(ev: { key: string; shiftKey: boolean; nativeEvent?: { isComposing?: boolean } }): boolean {
  if (ev.key !== "Enter" || ev.shiftKey) return false;
  return ev.nativeEvent?.isComposing !== true;
}

/** Where the panel's width is remembered. Per browser, like the folder tree's own choices. */
export const ASK_WIDTH_KEY = "celeste-ask-width";

/** The width the panel opens at, and the one a double-click on its edge goes back to. */
export const ASK_WIDTH_DEFAULT = 380;

/** Narrower than this and a citation chip has nowhere to sit. */
export const ASK_WIDTH_MIN = 320;

/** How much of the window the panel may take. Past this it is the app, not a panel. */
export const ASK_WIDTH_MAX_FRACTION = 0.6;

/**
 * A width the panel can actually be: at least readable, never more than most
 * of the window, and a whole number of pixels. A stored value from a wider
 * screen, or nonsense in localStorage, comes back as something usable rather
 * than a panel the operator cannot get rid of.
 */
export function clampAskWidth(width: number, viewport: number): number {
  if (!Number.isFinite(width)) return ASK_WIDTH_DEFAULT;
  const max = Math.max(ASK_WIDTH_MIN, Math.round(viewport * ASK_WIDTH_MAX_FRACTION));
  return Math.min(Math.max(Math.round(width), ASK_WIDTH_MIN), max);
}

/**
 * The width a drag is asking for: the edge is on the left of the panel, so
 * moving the pointer left widens it by however far it went. Clamping is the
 * caller's, which is what keeps this arithmetic worth reading.
 */
export function widthFromDrag(startWidth: number, startX: number, clientX: number): number {
  return startWidth + (startX - clientX);
}

/**
 * How far an arrow key moves the panel's edge. Left grows it, because the
 * edge is on the left and it is the edge that moves; Shift takes bigger
 * steps. Anything else moves nothing.
 */
export function resizeStep(key: string, shift: boolean): number {
  const step = shift ? 64 : 16;
  if (key === "ArrowLeft") return step;
  if (key === "ArrowRight") return -step;
  return 0;
}

/** ⌘/ on a Mac, Ctrl+/ everywhere else: the panel's toggle (spec 10c). */
export function togglesAsk(ev: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return ev.key === "/" && (ev.metaKey || ev.ctrlKey);
}

/** One turn on screen. The optimistic question is one of these before the answer lands. */
export interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  actions: ProposedAction[];
  /** The draft that was open when the turn happened, for an "Apply to draft" button. */
  contextDraftId: string | null;
  /** Who answered, written down with a revision the operator applies from here. */
  model: string | null;
  /**
   * The question a drop asked on the operator's behalf (spec 8, 2026-09-10),
   * so the bubble reads as the app speaking for them rather than as something
   * they typed. Only for the turn as it happens: a reload reads it back as
   * the ordinary question it was.
   */
  auto?: boolean;
}

/** A stored turn as the panel paints it. */
export function toTurn(row: ChatMessageRow): Turn {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    citations: row.citations ?? [],
    actions: row.actions ?? [],
    contextDraftId: row.contextDraftId ?? null,
    model: row.model ?? null,
  };
}

/** The conversation for questions that belong to no thread at all. */
export const ASK_GENERAL_CONTEXT = "general";

/** What the panel is a conversation about right now (spec 10c, 2026-09-10). */
export interface AskContext {
  /** The thread page's thread, when one is open. */
  threadId?: string | null;
  /** The thread of the draft on the card, because a draft is a reply in its thread. */
  draftThreadId?: string | null;
}

/**
 * Which conversation the panel should be on. A draft belongs to its thread,
 * so asking about the draft and asking about the mail it answers are the
 * same conversation; everything else is General.
 */
export function askContextKey(ctx: AskContext): string {
  return ctx.threadId ?? ctx.draftThreadId ?? ASK_GENERAL_CONTEXT;
}

/** The thread a question carries, which is nothing at all in General. */
export function askContextThreadId(ctx: AskContext): string | null {
  const key = askContextKey(ctx);
  return key === ASK_GENERAL_CONTEXT ? null : key;
}

/**
 * The two places a question can go, as tabs at the top of the panel
 * (operator, 2026-09-14: "super easy to navigate between general chat and
 * specialized chat"). `onScreen` is what the page has open, cleared or not;
 * `looking` is what the panel is on. No tabs at all when nothing is open:
 * General is the only place then, and a lone tab says nothing.
 */
export interface AskTab {
  key: "general" | "thread";
  label: string;
  active: boolean;
}

export function askTabs(input: { onScreen: { subject?: string | null; draftTo?: string | null } | null; looking: boolean }): AskTab[] {
  if (!input.onScreen) return [];
  const label = input.onScreen.subject ? input.onScreen.subject : input.onScreen.draftTo ? `Draft to ${input.onScreen.draftTo}` : "This thread";
  return [
    { key: "general", label: "General", active: !input.looking },
    { key: "thread", label, active: input.looking },
  ];
}

/** What an empty conversation invites, named after what the operator is looking at. */
export function askEmptyLine(ctx: AskContext): string {
  if (ctx.draftThreadId) return "Ask about this draft, or say what to change: shorter, more formal, add that I'm out Friday.";
  if (ctx.threadId) return "Ask about this thread.";
  return "Ask Celeste about anything in your mail. She answers and proposes; you decide.";
}

/**
 * What the box invites, given what is open (2026-09-14): with a draft on
 * screen this is where it gets revised, since the card's own field is gone.
 */
export function askPlaceholder(ctx: { draftThreadId?: string | null }): string {
  return ctx.draftThreadId ? "Ask Celeste, or say what to change in the draft…" : "Ask Celeste…";
}

/**
 * Whether a draft appearing should open the panel by itself (2026-09-14).
 * Revising lives in the panel now, so a card without it beside would be a
 * draft with no way to talk to Celeste about it. Only on a desktop wide
 * enough for the panel to make room rather than cover the card, only while
 * closed, and once per draft: closing it again is the operator's word.
 */
export function opensAskForDraft(input: { open: boolean; width: number; draftId: string | null; openedFor: string | null }): boolean {
  if (input.open || !input.draftId) return false;
  if (input.width < 1200) return false;
  return input.openedFor !== input.draftId;
}

/** How much was said in a conversation, as History puts it under the title. */
export function chatCountLabel(messageCount: number): string {
  return messageCount === 1 ? "1 message" : `${messageCount} messages`;
}

/** Longest a conversation's name gets before it is cut: a row, not a paragraph. */
const ABOUT_MAX = 60;

/**
 * What a conversation is about, which is what the operator asked for
 * (2026-09-11). A thread's conversation is already named by its mail. Every
 * General one is called "General", so the first question is what tells them
 * apart: "General · why did Pear pass on us…".
 */
export function conversationAboutLabel(title: string | null | undefined, firstQuestion: string | null | undefined, max: number = ABOUT_MAX): string {
  const name = chatTitleLabel(title);
  const asked = firstQuestion?.replace(/\s+/g, " ").trim();
  const full = name === "General" && asked ? `${name} · ${asked}` : name;
  return full.length > max ? `${full.slice(0, max - 1).trimEnd()}…` : full;
}

/**
 * What a conversation cost, as its own row says it (spec 13, 2026-09-11).
 * Under a cent the exact figure means nothing and four decimals read as
 * noise, so it says so instead; exactly nothing says nothing.
 */
export function conversationCostLabel(costUsd: number): string {
  if (costUsd <= 0) return "$0";
  if (costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

/** The tokens a conversation went through, rounded to what the operator can act on. */
export function conversationTokensLabel(inputTokens: number, outputTokens: number): string {
  const total = Math.round(inputTokens + outputTokens);
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tokens`;
  if (total >= 1000) return `${Math.round(total / 1000)}k tokens`;
  return `${total} token${total === 1 ? "" : "s"}`;
}

/**
 * The line under the open conversation's title: about this much money, about
 * this many tokens. Approximate on purpose — the prices are list prices.
 */
export function conversationUsageLabel(usage: { costUsd: number; inputTokens: number; outputTokens: number } | null): string | null {
  if (!usage) return null;
  if (usage.inputTokens + usage.outputTokens <= 0) return null;
  return `≈ ${conversationCostLabel(usage.costUsd)} · ${conversationTokensLabel(usage.inputTokens, usage.outputTokens)}`;
}

/** A conversation's name, with something to fall back on when it has none. */
export function chatTitleLabel(title: string | null | undefined): string {
  return title?.trim() || "Conversation";
}

/**
 * The threads a proposal covers. Core says the same thing in
 * `actionThreadIds`; it is two lines here so this module stays pure and the
 * browser never pulls the database in behind it.
 */
export function threadsOf(action: ProposedAction): string[] {
  if (action.threadIds && action.threadIds.length > 0) return action.threadIds;
  return action.threadId ? [action.threadId] : [];
}

/**
 * The chip for one thread of a proposal: its subject and who it is with
 * ("Visa timeline · Victoria Chen"), so the operator can see what a bulk
 * button covers before pressing it. Turns stored before proposals carried
 * names fall back to the position ("Thread 2"). A sender written as
 * `Name <address>` shows the name alone; a bare address shows as is.
 */
export function threadChipLabel(action: ProposedAction, threadId: string, index: number): string {
  const t = action.threads?.find((x) => x.id === threadId);
  if (!t) return `Thread ${index + 1}`;
  const name = t.from.replace(/\s*<[^>]*>\s*$/, "").trim();
  return name ? `${t.subject} · ${name}` : t.subject;
}

/**
 * The draft proposal that runs on its own, without waiting for a click (spec
 * 10c, 2026-09-10). Operator: asking Celeste for a draft of the mail on screen
 * should put the draft on screen, not a button that would. So one proposal
 * over the one thread they have open runs at once — unless that thread's draft
 * is already in front of them, which would be a second draft of the same mail.
 * Everything wider than that, and anything for a thread they are not on, keeps
 * its button: a sweep over six threads is still their decision to make.
 */
export function autoRunsDraft(
  actions: ProposedAction[],
  open: { threadId?: string | null; draftThreadId?: string | null },
): { action: ProposedAction; threadId: string } | null {
  const threadId = open.threadId;
  if (!threadId || open.draftThreadId === threadId) return null;
  for (const action of actions) {
    if (action.kind !== "draft_reply" && action.kind !== "draft_follow_up") continue;
    const threads = threadsOf(action);
    if (threads.length === 1 && threads[0] === threadId) return { action, threadId };
  }
  return null;
}

/**
 * A draft proposal that lands on the card already open (2026-09-14). Told to
 * "draft an email saying X" over a thread whose draft is in front of them,
 * Celeste sometimes proposes a new draft instead of `apply_draft`; the
 * answer to that is not a second card but the open one rewritten to say X,
 * the way a change asked for in the panel does. Only a proposal that carries their
 * words qualifies: without an instruction there is nothing to revise toward,
 * and the button stays, as it did.
 */
export function revisesOpenDraft(
  actions: ProposedAction[],
  open: { draftThreadId?: string | null },
): { action: ProposedAction; instruction: string } | null {
  const threadId = open.draftThreadId;
  if (!threadId) return null;
  for (const action of actions) {
    if (action.kind !== "draft_reply" && action.kind !== "draft_follow_up") continue;
    const instruction = action.instruction?.trim() ?? "";
    if (instruction === "") continue;
    const threads = threadsOf(action);
    if (threads.length === 1 && threads[0] === threadId) return { action, instruction };
  }
  return null;
}

/**
 * Whether an "Apply to draft" button still has somewhere to land: the draft
 * that was open when Celeste offered it is the one on screen now. A turn
 * stored before turns remembered the draft (no `turnDraftId`) applies to
 * whatever is open, which is the only draft it could have meant.
 */
export function appliesToOpenDraft(turnDraftId: string | null | undefined, openDraftId: string | null | undefined): boolean {
  if (!openDraftId) return false;
  return !turnDraftId || turnDraftId === openDraftId;
}

/**
 * What a proposed action's button says. One proposal is one button however
 * many threads it covers, so the label carries the count: the operator is
 * agreeing to the whole thing, not to the first of six (spec 10c).
 */
export function actionLabel(action: ProposedAction): string {
  const count = threadsOf(action).length;
  const many = count > 1;
  switch (action.kind) {
    case "draft_reply":
      return many ? `Draft replies to ${count} threads` : "Draft a reply";
    case "draft_follow_up":
      return many ? `Draft follow-ups to ${count} threads` : "Follow up";
    case "file_to_project": {
      const name = action.projectName ?? "a project";
      // A project that does not exist yet is the bigger half of what the
      // click does, so it leads the label rather than hiding inside it.
      if (action.createProject) return many ? `Create ${name} and file ${count} threads` : `Create ${name} and file this thread`;
      return many ? `File ${count} threads to ${name}` : action.projectName ? `File to ${name}` : "File to a project";
    }
    case "mark_handled":
      return many ? `Mark ${count} handled` : "Mark handled";
    case "open_thread":
      return many ? `Open ${count} threads` : "Open";
    // One draft, always: the card the operator has open. The click puts
    // Celeste's text on it and stops there (spec 10c, 2026-09-10).
    case "apply_draft":
      return "Apply to draft";
  }
}

/** What the button says once it has run: how many it did, and how many it could not. */
export function actionDoneLabel(kind: ProposedAction["kind"], done: number, failed: number, projectName?: string): string {
  const tail = failed > 0 ? `, ${failed} failed` : "";
  switch (kind) {
    case "draft_reply":
    case "draft_follow_up":
      return `${done} ${done === 1 ? "draft" : "drafts"} created${tail}`;
    case "file_to_project":
      return `Filed ${done} to ${projectName ?? "the project"}${tail}`;
    case "mark_handled":
      return `${done} marked handled${tail}`;
    case "open_thread":
      return "Opened";
    case "apply_draft":
      return "Applied to the draft";
  }
}

/** A citation chip's words: the subject, then who sent it, without the address. */
export function citationChipLabel(citation: { subject: string; from: string }): string {
  const sender = citation.from.replace(/\s*<[^>]*>\s*$/, "").trim() || citation.from;
  return `${citation.subject} · ${sender}`;
}
