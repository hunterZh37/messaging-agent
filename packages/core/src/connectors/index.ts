import { eq } from "drizzle-orm";
import { fetchImapAttachment, fetchOutlookAttachment } from "../attachments/fetch";
import { fetchImessageAttachment } from "../imessage/attachments";
import { openChatDb } from "../imessage/chatdb";
import { imessageSender, osascript } from "../imessage/send";
import { deleteConversation } from "../imessage/delete";
import { backfillImessageAccount, syncImessageAccount } from "../imessage/sync";
import { restoreImessageMessages, trashImessageMessages } from "../imessage/trash";
import type { ImessageSource } from "../imessage/types";
import { openChatStorage, mediaFile } from "../whatsapp/chatstore";
import { backfillWhatsappAccount, syncWhatsappAccount } from "../whatsapp/sync";
import { whatsappSender } from "../whatsapp/sender";
import { deleteInWhatsapp } from "../whatsapp/app";
import type { WhatsappSource } from "../whatsapp/types";
import { readFile } from "node:fs/promises";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { messages, oauthTokens, type AccountRow, type AttachmentRow, attachments } from "../db/schema";
import { imapForAccount } from "../imap/credentials";
import { applyImapLabels } from "../imap/labels";
import { imapSender } from "../imap/sender";
import { backfillImapAccount, syncImapAccount } from "../imap/sync";
import { restoreImapMessages, trashImapMessages } from "../imap/trash";
import { applyOutlookCategories } from "../outlook/labels";
import { outlookForAccount } from "../outlook/oauth";
import { outlookSender } from "../outlook/sender";
import { backfillOutlookAccount, syncOutlookAccount } from "../outlook/sync";
import { restoreOutlookMessages, trashOutlookMessages } from "../outlook/trash";
import { AccountAuthError, type MailConnector } from "./types";

/** The provider's own id for the message an attachment hangs off: what both providers' fetch paths address it by. */
function messageProviderId(db: Db, att: AttachmentRow): string {
  const message = db.select().from(messages).where(eq(messages.id, att.messageId)).get();
  if (!message) throw new Error(`Attachment ${att.id} points at a message that is gone`);
  return message.providerMessageId;
}

/** Picks the right provider's sync/labels/sender by account.provider. The one place the pipeline, CLI, and web app go to talk to an account. */
export function connectorForAccount(cfg: Config, db: Db, account: AccountRow): MailConnector {
  if (account.status === "disconnected") {
    throw new AccountAuthError(account.id, `${account.email} is disconnected. Reconnect it from Inboxes.`);
  }

  if (account.provider === "imap") {
    // Fail here, synchronously, when the password is missing, exactly as the
    // OAuth providers do. Each operation then opens its own connection: an
    // IMAP client is spent once it has logged out.
    imapForAccount(db, account.id, cfg);
    return {
      sync: (syncDb, syncAccount, opts) => syncImapAccount(syncDb, cfg, imapForAccount(syncDb, syncAccount.id, cfg).imap, syncAccount, opts),
      backfill: (bfDb, bfAccount, opts) => backfillImapAccount(bfDb, cfg, imapForAccount(bfDb, bfAccount.id, cfg).imap, bfAccount, opts),
      applyLabels: (labelsDb, accountId) => applyImapLabels(labelsDb, imapForAccount(labelsDb, accountId, cfg).imap, accountId),
      fetchAttachment: (attDb, attAccount, att) =>
        fetchImapAttachment(imapForAccount(attDb, attAccount.id, cfg).imap, messageProviderId(attDb, att), att),
      trash: (trashDb, trashAccount, messageIds) => trashImapMessages(trashDb, imapForAccount(trashDb, trashAccount.id, cfg).imap, messageIds),
      restore: (restoreDb, restoreAccount, messageIds) => restoreImapMessages(restoreDb, imapForAccount(restoreDb, restoreAccount.id, cfg).imap, messageIds),
      sender: {
        sendReply: (p) => imapSender(imapForAccount(db, account.id, cfg).smtp).sendReply(p),
      },
    };
  }

  if (account.provider === "imessage") {
    // Messages on this Mac (2026-09-11): read-only chat.db, sends by
    // AppleScript, deletes that stay local. Each operation opens the
    // database itself and closes it after.
    const withSource = async <T>(fn: (source: ImessageSource) => Promise<T>): Promise<T> => {
      const source = openChatDb(cfg.chatDbPath);
      try {
        return await fn(source);
      } finally {
        source.close();
      }
    };
    return {
      sync: (syncDb, syncAccount, opts) => withSource((source) => syncImessageAccount(syncDb, cfg, source, syncAccount, opts)),
      backfill: (bfDb, bfAccount, opts) => withSource((source) => backfillImessageAccount(bfDb, cfg, source, bfAccount, opts)),
      applyLabels: async () => ({ labeled: 0, failed: 0 }),
      fetchAttachment: (_attDb, _attAccount, att) => fetchImessageAttachment(att),
      // A delete drives Messages.app and then waits, briefly, for chat.db to
      // show the chat empty: the sheet's Delete lands a moment after the click.
      trash: (trashDb, _trashAccount, messageIds) =>
        trashImessageMessages(trashDb, messageIds, {
          deleteChat: async (chat) => {
            const names = await withSource(async (source) => [chat.handle, chat.subject, source.chatDisplayName?.(chat.guid) ?? ""]);
            // Whether chat.db already shows the chat empty, read for a
            // couple of seconds: the app's row catches up a moment after.
            const isGone = () =>
              withSource(async (source) => {
                for (let i = 0; i < 8; i++) {
                  if ((source.chatTextCount?.(chat.guid) ?? 0) === 0) return true;
                  await new Promise((r) => setTimeout(r, 300));
                }
                return false;
              });
            const said = await deleteConversation(osascript, chat.handle, names, { isGone });
            // Delete was pressed on the sheet of the right window, which is
            // as much as a person does. chat.db is read for a few seconds to
            // let the row catch up; an RCS chat keeps empty card rows after a
            // delete (2026-09-11), so a confirmed Delete stands either way.
            await withSource(async (source) => {
              for (let i = 0; i < 10; i++) {
                if ((source.chatTextCount?.(chat.guid) ?? 0) === 0) return;
                await new Promise((r) => setTimeout(r, 300));
              }
              // Delete pressed on the sheet, or no conversation for Messages
              // to delete (it is gone from the app already; chat.db keeps
              // rows for a while): either way the app holds no such chat.
              if (said === "deleted" || said === "nothing to delete") return;
              throw new Error(`Messages said "${said}" but the chat still holds texts`);
            });
          },
        }),
      restore: (restoreDb, _restoreAccount, messageIds) => restoreImessageMessages(restoreDb, messageIds),
      sender: {
        sendReply: (p) => withSource((source) => imessageSender(source).sendReply(p)),
      },
    };
  }

  if (account.provider === "whatsapp") {
    // WhatsApp on this Mac (spec 10g, 2026-09-11): read-only ChatStorage,
    // sends and deletes by driving WhatsApp.app, each confirmed by reading
    // the store afterwards. Each operation opens the database itself.
    const withStore = async <T>(fn: (source: WhatsappSource) => Promise<T>): Promise<T> => {
      const source = openChatStorage(cfg.whatsappDbPath);
      try {
        return await fn(source);
      } finally {
        source.close();
      }
    };
    return {
      sync: (syncDb, syncAccount, opts) => withStore((source) => syncWhatsappAccount(syncDb, cfg, source, syncAccount, opts)),
      backfill: (bfDb, bfAccount, opts) => withStore((source) => backfillWhatsappAccount(bfDb, cfg, source, bfAccount, opts)),
      applyLabels: async () => ({ labeled: 0, failed: 0 }),
      fetchAttachment: async (_attDb, _attAccount, att) => {
        if (!att.providerAttachmentId) throw new Error("WhatsApp has no file for this attachment.");
        return readFile(mediaFile(att.providerAttachmentId));
      },
      trash: (trashDb, _trashAccount, messageIds) =>
        trashImessageMessages(trashDb, messageIds, {
          deleteChat: (chat) =>
            withStore(async (source) => {
              const wa = source.chat(chat.guid);
              if (!wa) return; // Already gone from WhatsApp: nothing to do there.
              await deleteInWhatsapp(osascript, wa);
              for (let i = 0; i < 12; i++) {
                const state = source.chatState(chat.guid);
                if (!state.exists || state.removed || state.count === 0) return;
                await new Promise((r) => setTimeout(r, 400));
              }
              throw new Error(`WhatsApp confirmed, but the chat with ${wa.name} still holds messages`);
            }),
        }),
      restore: (restoreDb, _restoreAccount, messageIds) => restoreImessageMessages(restoreDb, messageIds),
      sender: {
        sendReply: (p) => withStore((source) => whatsappSender(source, osascript).sendReply(p)),
      },
    };
  }

  const tok = db.select().from(oauthTokens).where(eq(oauthTokens.accountId, account.id)).get();
  if (!tok) {
    throw new AccountAuthError(account.id, `${account.email} has no stored credentials. Connect it from Inboxes.`);
  }

  const client = outlookForAccount(cfg, db, account.id);
  return {
    sync: (syncDb, syncAccount, opts) => syncOutlookAccount(syncDb, cfg, client, syncAccount, opts),
    backfill: (bfDb, bfAccount, opts) => backfillOutlookAccount(bfDb, cfg, client, bfAccount, opts),
    applyLabels: (labelsDb, accountId) => applyOutlookCategories(labelsDb, client, accountId),
    fetchAttachment: (attDb, _attAccount, att) =>
      fetchOutlookAttachment(client, messageProviderId(attDb, att), att, (providerAttachmentId) =>
        attDb.update(attachments).set({ providerAttachmentId }).where(eq(attachments.id, att.id)).run(),
      ),
    trash: (trashDb, _trashAccount, messageIds) => trashOutlookMessages(trashDb, client, messageIds),
    restore: (restoreDb, _restoreAccount, messageIds) => restoreOutlookMessages(restoreDb, client, messageIds),
    sender: outlookSender(client),
  };
}
