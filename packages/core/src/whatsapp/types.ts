/**
 * WhatsApp on this Mac (spec 10g, 2026-09-11): the native app keeps its
 * chats in ChatStorage.sqlite, which is read here and never written.
 * Everything that touches the app itself goes through an
 * `AppleScriptRunner`, so a test never opens WhatsApp.
 */

/** A one-to-one chat or a group, as ChatStorage keeps it. */
export interface WaChat {
  /** The session's JID, stable for the chat's life: `<number>@s.whatsapp.net`, `<lid>@lid` or `<id>@g.us`. */
  jid: string;
  name: string;
  kind: "person" | "group";
  /** The phone number a one-to-one chat can be opened with, when WhatsApp knows it. */
  phone: string | null;
}

export interface WaMedia {
  /** Under WhatsApp's container, `Message/` + this. */
  path: string;
  filename: string;
  size: number;
}

export interface WaMessage {
  pk: number;
  stanzaId: string;
  chat: WaChat;
  text: string | null;
  isFromMe: boolean;
  sentAt: number;
  /** Who wrote it in a group: the member's JID and the name WhatsApp shows for them. */
  senderJid: string | null;
  senderName: string | null;
  media: WaMedia | null;
}

export interface WhatsappSource {
  /** The operator's own JID and LID, worked out from the groups they are in; null when the store is empty. */
  own(): { jid: string; lid: string | null; phone: string } | null;
  messagesAfter(afterPk: number, sinceMs: number | null, limit: number): WaMessage[];
  /** The newest message the operator sent in this chat after the moment given, with this text, for confirming a send landed. */
  latestOwnMessage(chatJid: string, afterMs: number, text: string): WaMessage | null;
  /** How a chat stands: gone, or how many messages it still holds. */
  chatState(chatJid: string): { exists: boolean; removed: boolean; count: number };
  chat(chatJid: string): WaChat | null;
  /** The names WhatsApp shows for JIDs (push names), for group senders and mentions. */
  pushNames(): Map<string, string>;
  /** Names from the Mac's Contacts, for a chat WhatsApp names by its number (2026-09-14). Absent: the address book is read. */
  contactNames?(): Map<string, string>;
  /** Unread texts per chat JID as WhatsApp counts them (2026-09-14): zero means read, on the phone or here. */
  unreadCounts?(): Map<string, number>;
  close(): void;
}

/**
 * A WhatsApp group, by the JID its thread is keyed on (spec 10g).
 *
 * Replying to one is not supported, and cannot be: WhatsApp.app exposes its
 * menus and the focused control to accessibility but not its window contents,
 * so nothing on screen names the group that is open. A one-to-one chat is
 * named by the Chat menu's "Block <name>" item and can be confirmed; a group
 * has no such item. Rather than send a message into a chat it cannot identify,
 * Celeste does not offer to send at all (operator, 2026-09-16).
 */
export function isWhatsappGroup(providerThreadId: string): boolean {
  return providerThreadId.endsWith("@g.us");
}

/** Why the reply box is missing on a group, in the words the UI shows. */
export const WHATSAPP_GROUP_REPLY_OFF = "Replying to WhatsApp groups is not supported: the app does not say which group is open, so a message could go to the wrong one.";
