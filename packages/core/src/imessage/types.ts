/**
 * The iMessage channel (operator, 2026-09-11: "integrate iMessage"; read +
 * reply, one-to-one chats, 30 days back, same gate as mail). Everything
 * core needs from Messages on this Mac goes through `ImessageSource`, so a
 * test can hand in rows without a chat.db, and every send goes through an
 * `AppleScriptRunner`, so a test never opens Messages.app.
 */

/** One one-to-one chat as chat.db keeps it. */
export interface ChatRow {
  rowid: number;
  /** Stable across the chat's life; the thread's provider id. */
  guid: string;
  /** The other party's handle: a phone number or an email. */
  handle: string;
  /** iMessage, SMS or RCS: which service a reply goes out on. */
  service: string;
}

/** One text as chat.db keeps it, already joined to its chat. */
export interface TextRow {
  rowid: number;
  guid: string;
  chatGuid: string;
  handle: string;
  service: string;
  /** Decoded body; null when the bubble was an attachment alone. */
  text: string | null;
  isFromMe: boolean;
  /** Read in Messages already (2026-09-14): on the phone, or on this Mac. Absent in fakes that never say. */
  isRead?: boolean;
  /** Epoch milliseconds. */
  sentAt: number;
  attachments: TextAttachment[];
}

export interface TextAttachment {
  guid: string;
  /** Absolute path on this Mac, or null when Messages has not downloaded it. */
  path: string | null;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ImessageSource {
  /** Which handle Messages sends as on this Mac; null when none can be read. */
  ownHandle(): string | null;
  /** Texts in one-to-one chats after `afterRowid` and, when given, not before `sinceMs`, oldest first. */
  textsAfter(afterRowid: number, sinceMs: number | null, limit: number): TextRow[];
  /** The newest text the operator sent in this chat after the moment given, for finding a send once it landed. */
  latestOwnText(chatGuid: string, afterMs: number): TextRow | null;
  /** Names for handles, from the address book. */
  contactNames(): Map<string, string>;
  /** The guids of inbound texts read in Messages since `sinceMs` (2026-09-14): what was read on the phone since the last sync. */
  readGuidsSince?(sinceMs: number): string[];
  /** How many texts a chat still holds, for checking a delete landed; absent in fakes that never delete. */
  chatTextCount?(chatGuid: string): number;
  /** The name Messages gives a chat itself (an RCS business, a group), when it has one. */
  chatDisplayName?(chatGuid: string): string | null;
  close(): void;
}

/** Runs one AppleScript and returns its stdout. Real: osascript. Tests: a fake. */
export type AppleScriptRunner = (script: string) => Promise<string>;
