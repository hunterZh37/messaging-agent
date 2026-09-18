import { ImapFlow } from "imapflow";
import type { CopyResponseObject } from "imapflow";
import { createTransport } from "nodemailer";
import type { ImapClient, ImapCredentials, ImapMessage, ImapSettings, SmtpClient } from "./types";

/**
 * The real IMAP client. Thin on purpose: every decision lives in sync.ts and
 * labels.ts, which run against FakeImapClient in tests.
 */
export function createImapClient(settings: ImapSettings, creds: ImapCredentials): ImapClient {
  // Built at connect time: an account that signs in with Google (2026-09-11)
  // hands over a fresh token then, not when the client object is made.
  const build = (auth: { user: string; pass?: string; accessToken?: string }) =>
    new ImapFlow({
      host: settings.imapHost,
      port: settings.imapPort,
      secure: true,
      auth,
      logger: false,
      // imapflow waits five minutes on a silent socket by default; a move or
      // a fetch that has gone quiet for a minute is not coming back, and the
      // app should hear so rather than hang with it (stress audit, 2026-09-11).
      connectionTimeout: 30_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
  let client = build({ user: creds.username, pass: creds.password ?? "" });

  return {
    async connect() {
      if (creds.accessToken) client = build({ user: creds.username, accessToken: await creds.accessToken() });
      await client.connect();
    },

    async close() {
      // logout() is the polite close; if the socket is already gone, drop it.
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },

    async folders() {
      const boxes = await client.list();
      const pathOf = (flag: string) => boxes.find((b) => b.specialUse === flag)?.path ?? null;
      return { inbox: "INBOX", sent: pathOf("\\Sent"), trash: pathOf("\\Trash"), junk: pathOf("\\Junk") };
    },

    async fetchNew(folder, afterUid, sinceDate) {
      const mailbox = await client.mailboxOpen(folder);
      const uidValidity = Number(mailbox.uidValidity);
      const messages: ImapMessage[] = [];

      let range: string | number[];
      if (afterUid === null) {
        const found = await client.search({ since: sinceDate ?? new Date(0) }, { uid: true });
        if (!found || found.length === 0) return { uidValidity, messages };
        range = found;
      } else {
        range = `${afterUid + 1}:*`;
      }

      // `source: true` fetches BODY.PEEK[], so nothing is marked \Seen.
      for await (const msg of client.fetch(range, { uid: true, source: true, threadId: true, labels: true, flags: true }, { uid: true })) {
        // `n:*` returns the newest message even when nothing is newer than n.
        if (afterUid !== null && msg.uid <= afterUid) continue;
        if (!msg.source) continue;
        messages.push({
          uid: msg.uid,
          source: msg.source,
          ...(msg.threadId ? { gmailThreadId: msg.threadId } : {}),
          ...(msg.labels ? { gmailLabels: [...msg.labels] } : {}),
          ...(msg.flags ? { seen: msg.flags.has("\\Seen") } : {}),
        });
      }
      return { uidValidity, messages };
    },

    async fetchOlder(folder, beforeUid, sinceDate) {
      const mailbox = await client.mailboxOpen(folder);
      const uidValidity = Number(mailbox.uidValidity);
      const messages: ImapMessage[] = [];
      // uid 1 is the oldest there can be: nothing sits below it.
      if (beforeUid !== null && beforeUid <= 1) return { uidValidity, messages };

      const query: { since?: Date; uid?: string; all?: boolean } = {};
      if (sinceDate) query.since = sinceDate;
      if (beforeUid !== null) query.uid = `1:${beforeUid - 1}`;
      if (!query.since && !query.uid) query.all = true;
      const found = await client.search(query, { uid: true });
      if (!found || found.length === 0) return { uidValidity, messages };

      // `source: true` fetches BODY.PEEK[], so nothing is marked \Seen.
      for await (const msg of client.fetch(found, { uid: true, source: true, threadId: true, labels: true, flags: true }, { uid: true })) {
        if (beforeUid !== null && msg.uid >= beforeUid) continue;
        if (!msg.source) continue;
        messages.push({
          uid: msg.uid,
          source: msg.source,
          ...(msg.threadId ? { gmailThreadId: msg.threadId } : {}),
          ...(msg.labels ? { gmailLabels: [...msg.labels] } : {}),
          ...(msg.flags ? { seen: msg.flags.has("\\Seen") } : {}),
        });
      }
      return { uidValidity, messages };
    },

    async fetchSource(folder, uid) {
      await client.mailboxOpen(folder);
      // `source: true` is BODY.PEEK[] again: the \Seen flag stays as it was.
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      return msg && msg.source ? msg.source : null;
    },

    async fetchFlags(folder, uids) {
      const seen = new Map<number, boolean>();
      if (uids.length === 0) return seen;
      await client.mailboxOpen(folder);
      // Flags only: no body, so nothing is fetched twice and nothing is marked.
      for await (const msg of client.fetch(uids, { uid: true, flags: true }, { uid: true })) {
        seen.set(msg.uid, msg.flags?.has("\\Seen") ?? false);
      }
      return seen;
    },

    async addLabels(folder, uid, labels) {
      await client.mailboxOpen(folder);
      if (settings.kind === "gmail") {
        await client.messageFlagsAdd({ uid: String(uid) }, labels, { uid: true, useLabels: true });
        return;
      }
      // IMAP keywords are atoms: no "/" and no spaces.
      await client.messageFlagsAdd({ uid: String(uid) }, labels.map((l) => l.replace(/\//g, "-")), { uid: true });
    },

    async move(folder, uids, destination) {
      if (uids.length === 0) return new Map();
      await client.mailboxOpen(folder);
      const range = uids.join(",");
      // MOVE is one atomic step and most servers have it. Where they do not,
      // the three steps below are the same journey, and the EXPUNGE names
      // the uids so nothing else the operator had flagged goes with them.
      const capabilities = client.capabilities as Map<string, unknown> | undefined;
      let result: CopyResponseObject | false;
      if (capabilities?.has("MOVE")) {
        result = await client.messageMove(range, destination, { uid: true });
      } else {
        result = await client.messageCopy(range, destination, { uid: true });
        await client.messageFlagsAdd(range, ["\\Deleted"], { uid: true });
        await client.messageDelete(range, { uid: true });
      }
      // A server with no UIDPLUS answers with no uidMap at all (spec 10a,
      // 2026-09-11): the caller leaves the id as it was and a restore falls
      // back to a Message-ID search instead.
      return result && result.uidMap ? result.uidMap : new Map();
    },

    async findByMessageId(folder, rfcMessageId) {
      await client.mailboxOpen(folder);
      const found = await client.search({ header: { "message-id": rfcMessageId } }, { uid: true });
      return found && found.length > 0 ? found[0]! : null;
    },
  };
}

export function createSmtpClient(settings: ImapSettings, creds: ImapCredentials): SmtpClient {
  // The transport is made per send: a Google token is fetched fresh for it.
  const transport = async () =>
    createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: true,
      auth: creds.accessToken ? { type: "OAuth2", user: creds.username, accessToken: await creds.accessToken() } : { user: creds.username, pass: creds.password ?? "" },
    });

  return {
    async send(msg) {
      const info = await (await transport()).sendMail({
        from: msg.from,
        to: msg.to,
        cc: msg.cc,
        subject: msg.subject,
        text: msg.text,
        ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
        ...(msg.references ? { references: msg.references } : {}),
        ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
      });
      return { messageId: info.messageId };
    },
  };
}
