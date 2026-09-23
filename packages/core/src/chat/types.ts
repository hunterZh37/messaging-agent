/**
 * Ask Celeste (spec 10c): the operator asks, Celeste answers over the mail she
 * can see, and proposes actions the operator clicks. Nothing here executes
 * anything — a proposal is a button, not a side effect.
 *
 * This module imports nothing, so `db/schema.ts` can type its json columns
 * against it without a cycle.
 */

/** A message Celeste leaned on, rendered under her answer as a chip. */
export interface Citation {
  messageId: string;
  threadId: string;
  subject: string;
  /** `Name <address>` when the sender has a name, the address otherwise. */
  from: string;
}

/**
 * The draft the operator has open in the queue, as Ask Celeste is told about
 * it (spec 10c, 2026-09-10). The text is the one on the card right now,
 * including every edit and revision, and it is the operator's own writing:
 * trusted, unlike the mail it answers.
 */
export interface ContextDraft {
  draftId: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  /**
   * Files the operator dropped on the draft (spec 8, 2026-09-10). Attaching
   * one is their own act, so there is nothing to propose: she is shown what
   * is on the mail, and the text of a PDF so she can say what it is.
   * `textExcerpt` is null for anything with no text layer to read.
   */
  attachments?: ContextDraftAttachment[];
}

/** One file on the open draft, as Celeste is told about it. */
export interface ContextDraftAttachment {
  filename: string;
  mimeType: string;
  size: number;
  textExcerpt: string | null;
}

/**
 * One file the operator gave the conversation itself (spec 10c, 2026-09-10),
 * rather than the mail. It is not going anywhere: it is there so Celeste can
 * read it and say what it is, and only the operator's click on the chip puts
 * it on a draft.
 */
export interface ContextChatFile {
  filename: string;
  mimeType: string;
  size: number;
  textExcerpt: string | null;
}

/** What Celeste can offer to do. Every one of these needs the operator's click. */
export type ProposedActionKind = "draft_reply" | "draft_follow_up" | "file_to_project" | "mark_handled" | "open_thread" | "apply_draft" | "compose";

export const PROPOSED_ACTION_KINDS: ProposedActionKind[] = [
  "draft_reply",
  "draft_follow_up",
  "file_to_project",
  "mark_handled",
  "open_thread",
  "apply_draft",
  "compose",
];

/** A thread a proposal covers, named so the operator can see what they are agreeing to. */
export interface ProposedThread {
  id: string;
  subject: string;
  /** `Name <address>` when the sender has a name, the address otherwise. */
  from: string;
}

export interface ProposedAction {
  kind: ProposedActionKind;
  /**
   * Every thread the proposal covers. One proposal is one button, whether it
   * files one thread or sixteen: "put all of Victoria's mail under
   * Immigration" is a single decision for the operator to make.
   */
  threadIds: string[];
  /**
   * The same threads, with the subject and sender each one carries. Absent on
   * rows written before a proposal said what it was about, which is why
   * `threadIds` stays the list of record.
   */
  threads?: ProposedThread[];
  /** What a proposal carried before it could cover more than one thread. */
  threadId?: string;
  /**
   * Only for `compose`: the mail that would begin a conversation (operator,
   * 2026-09-22). A compose covers no thread, because there is none yet: the
   * refusal it replaces was "there's no existing thread to attach it to".
   */
  to?: string[];
  cc?: string[];
  subject?: string;
  /** Only for `file_to_project`: the project the operator would file them under. */
  projectName?: string;
  /** For `file_to_project`: the project does not exist yet, and the click makes it. */
  createProject?: boolean;
  /**
   * Only for `apply_draft`: the whole replacement body for the open draft.
   * Nothing writes it anywhere; the operator's click puts it on the card.
   */
  text?: string;
  /**
   * Only for `draft_reply` and `draft_follow_up`: what the operator asked
   * the draft to say, in their words (2026-09-14). Without it the drafter
   * wrote whatever it would have written on its own, and the operator's
   * "say that I have reached out to Ryan and ask for a final look" left no
   * trace on the card.
   */
  instruction?: string;
  /** A short why, shown on the button's row. */
  note?: string;
}

/** The threads a proposal covers, reading rows stored before proposals could hold several. */
export function actionThreadIds(action: ProposedAction): string[] {
  if (action.threadIds && action.threadIds.length > 0) return action.threadIds;
  return action.threadId ? [action.threadId] : [];
}

/** One hit from the keyword index, as the search tool returns it. */
export interface SearchHit {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  sentAt: number;
  snippet: string;
  /** mail, imessage or whatsapp (2026-09-11): where the message came from. */
  channel: "mail" | "imessage" | "whatsapp";
  /** In Deleted items here. */
  deleted?: boolean;
}

/* ------------------------------------------------------------------ *
 * The model client, narrowed to what the chat loop uses.
 *
 * Core owns this shape rather than the SDK's so a test can hand in a fake
 * without an API key anywhere near the suite; `createAnthropicChatClient`
 * adapts the real SDK onto it.
 * ------------------------------------------------------------------ */

export interface ChatSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface ChatTextBlock {
  type: "text";
  text: string;
}

export interface ChatToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ChatToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type ChatResponseBlock = ChatTextBlock | ChatToolUseBlock;

export interface ChatApiMessage {
  role: "user" | "assistant";
  content: string | (ChatTextBlock | ChatToolUseBlock | ChatToolResultBlock)[];
}

export interface ChatToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ChatRequest {
  system: ChatSystemBlock[];
  messages: ChatApiMessage[];
  tools: ChatToolDef[];
  max_tokens: number;
}

export interface ChatResponse {
  content: ChatResponseBlock[];
  stop_reason: string | null;
  /** Anthropic's cache counts ride along so the usage ledger can price them (spec 13). */
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export interface ChatClient {
  /** Recorded on the assistant row, so the queue can say what answered. */
  model: string;
  create(request: ChatRequest): Promise<ChatResponse>;
}
