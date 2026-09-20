import type { GraphMessage, OutlookClient, OutlookFolder } from "./types";

const BASE = "https://graph.microsoft.com/v1.0";

/**
 * How big a file may be before Graph refuses it inline. Its own limit is on
 * the whole request, so a base64 body of 3 MB is the safe line; anything
 * larger goes through an upload session instead (spec 8, 2026-09-10).
 */
export const OUTLOOK_INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;

/** Graph requires every chunk but the last to be a multiple of 320 KiB. This is twelve of them. */
export const OUTLOOK_UPLOAD_CHUNK_BYTES = 320 * 1024 * 12;

const FOLDER_ID: Record<OutlookFolder, string> = { inbox: "inbox", sent: "sentitems", trash: "deleteditems", junk: "junkemail" };

const SELECT =
  "id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,isDraft,isRead,categories";

interface GraphListResponse {
  value?: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/** How long one Graph call may take before it is given up on. Uploads pass their own signal. */
const GRAPH_TIMEOUT_MS = 45_000;

interface GraphErrorBody {
  error?: { message?: string };
}

/** Talks to Microsoft Graph over plain fetch. No MSAL, no Graph SDK. */
export function createOutlookClient(getAccessToken: () => Promise<string>): OutlookClient {
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await getAccessToken();
    return fetch(url, {
      ...init,
      // Graph has hung a call for minutes and the app hung with it: a delete
      // sat at "Deleting…" with no way out (stress audit, 2026-09-11). A
      // call that has not answered in this long is not going to.
      signal: init.signal ?? AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  }

  async function requireOk(res: Response): Promise<unknown> {
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : {};
    let message = text;
    try {
      const parsed = JSON.parse(text) as GraphErrorBody;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* body wasn't JSON; use raw text */
    }
    throw new Error(`Graph request failed: ${res.status} ${message}`);
  }

  return {
    async getProfile() {
      const res = await request(`${BASE}/me?$select=mail,userPrincipalName`);
      const data = (await requireOk(res)) as { mail?: string; userPrincipalName?: string };
      return { email: (data.mail ?? data.userPrincipalName ?? "").toLowerCase() };
    },

    async delta(folder, deltaLink, sinceIso) {
      let url = deltaLink;
      if (!url) {
        url = `${BASE}/me/mailFolders/${FOLDER_ID[folder]}/messages/delta?$select=${SELECT}&$expand=attachments($select=id,name,size,contentType,isInline)`;
        if (sinceIso) url += `&$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}`;
      }

      const messages: GraphMessage[] = [];
      // Tombstones: a message deleted or moved away since the last delta
      // comes back as an id and "@removed" and nothing else (2026-09-11:
      // fourteen of them sat in the inbox as blank mail from 1969).
      const removed: string[] = [];
      let finalDeltaLink: string | null = null;
      while (url) {
        const res = await request(url);
        if (res.status === 410) return "expired" as const;
        const data = (await requireOk(res)) as GraphListResponse;
        for (const m of data.value ?? []) {
          if (m["@removed"]) removed.push(m.id);
          else if (!m.isDraft) messages.push(m);
        }
        if (data["@odata.deltaLink"]) {
          finalDeltaLink = data["@odata.deltaLink"];
          url = null;
        } else if (data["@odata.nextLink"]) {
          url = data["@odata.nextLink"];
        } else {
          url = null;
        }
      }
      return { messages, removed, deltaLink: finalDeltaLink ?? deltaLink ?? "" };
    },

    async listMessages(folder, sinceIso) {
      let url: string | null =
        `${BASE}/me/mailFolders/${FOLDER_ID[folder]}/messages?$select=${SELECT}` +
        `&$expand=attachments($select=id,name,size,contentType,isInline)&$orderby=receivedDateTime desc&$top=50`;
      if (sinceIso) url += `&$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}`;

      const messages: GraphMessage[] = [];
      while (url) {
        const res: Response = await request(url);
        const data = (await requireOk(res)) as GraphListResponse;
        for (const m of data.value ?? []) {
          if (!m.isDraft) messages.push(m);
        }
        url = data["@odata.nextLink"] ?? null;
      }
      return messages;
    },

    async findMessage(rfcMessageId) {
      const filter = encodeURIComponent(`internetMessageId eq '${rfcMessageId.replace(/'/g, "''")}'`);
      for (const folder of ["trash", "inbox"] as const) {
        const res = await request(`${BASE}/me/mailFolders/${FOLDER_ID[folder]}/messages?$filter=${filter}&$select=id&$top=1`);
        const hit = ((await requireOk(res)) as GraphListResponse).value?.[0];
        if (hit) return { id: hit.id, folder };
      }
      const res = await request(`${BASE}/me/messages?$filter=${filter}&$select=id&$top=1`);
      const hit = ((await requireOk(res)) as GraphListResponse).value?.[0];
      return hit ? { id: hit.id, folder: "other" } : null;
    },

    async moveMessage(messageId, destination) {
      // Graph answers the move with the message under its new id (spec 10a,
      // 2026-09-11): a restore needs that id, so it is asked for and read.
      const res = await request(`${BASE}/me/messages/${encodeURIComponent(messageId)}/move?$select=id`, {
        method: "POST",
        body: JSON.stringify({ destinationId: FOLDER_ID[destination] }),
      });
      const data = (await requireOk(res)) as { id: string };
      return { id: data.id };
    },

    async ensureCategory(name) {
      const res = await request(`${BASE}/me/outlook/masterCategories`);
      // The master list needs MailboxSettings.ReadWrite, which the app does
      // not ask for. Without it a category still sticks to a message; it only
      // shows without a colour. So a 403 here is not a failure to label.
      if (res.status === 403) return;
      const data = (await requireOk(res)) as { value?: { displayName?: string }[] };
      const exists = (data.value ?? []).some((c) => c.displayName === name);
      if (exists) return;
      const created = await request(`${BASE}/me/outlook/masterCategories`, {
        method: "POST",
        body: JSON.stringify({ displayName: name, color: "preset0" }),
      });
      await requireOk(created);
    },

    async addCategories(messageId, names) {
      const res = await request(`${BASE}/me/messages/${messageId}?$select=categories`);
      const data = (await requireOk(res)) as { categories?: string[] };
      const merged = [...new Set([...(data.categories ?? []), ...names])];
      const patched = await request(`${BASE}/me/messages/${messageId}`, {
        method: "PATCH",
        body: JSON.stringify({ categories: merged }),
      });
      await requireOk(patched);
    },

    async getBody(messageId) {
      const res = await request(`${BASE}/me/messages/${messageId}?$select=body`);
      const data = (await requireOk(res)) as GraphMessage;
      return { contentType: data.body?.contentType ?? "text", content: data.body?.content ?? "" };
    },

    async listAttachments(messageId) {
      const res = await request(`${BASE}/me/messages/${messageId}/attachments?$select=id,name,size`);
      const data = (await requireOk(res)) as { value?: { id: string; name?: string; size?: number }[] };
      return (data.value ?? []).map((a) => ({ id: a.id, name: a.name ?? "", size: a.size ?? 0 }));
    },

    async getAttachmentBytes(messageId, attachmentId) {
      const res = await request(`${BASE}/me/messages/${messageId}/attachments/${attachmentId}/$value`);
      if (!res.ok) {
        // Same shape as requireOk's failure, but the body here is bytes, not JSON.
        await requireOk(res);
      }
      return Buffer.from(await res.arrayBuffer());
    },

    async createReply(messageId) {
      const res = await request(`${BASE}/me/messages/${messageId}/createReply`, { method: "POST", body: JSON.stringify({}) });
      const data = (await requireOk(res)) as { id: string };
      return { draftId: data.id };
    },

    async updateDraft(draftId, p) {
      const res = await request(`${BASE}/me/messages/${draftId}`, {
        method: "PATCH",
        body: JSON.stringify({
          // Graph carries one body, not two, so a marked reply goes as HTML
          // and a plain one stays text rather than being wrapped in tags it
          // never needed (operator, 2026-09-20).
          body: p.html ? { contentType: "html", content: p.html } : { contentType: "text", content: p.body },
          toRecipients: p.to.map((address) => ({ emailAddress: { address } })),
          ccRecipients: p.cc.map((address) => ({ emailAddress: { address } })),
        }),
      });
      await requireOk(res);
    },

    async addAttachment(draftId, file) {
      if (file.bytes.byteLength <= OUTLOOK_INLINE_ATTACHMENT_LIMIT) {
        const res = await request(`${BASE}/me/messages/${draftId}/attachments`, {
          method: "POST",
          body: JSON.stringify({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: file.filename,
            contentType: file.mimeType,
            contentBytes: file.bytes.toString("base64"),
          }),
        });
        await requireOk(res);
        return;
      }

      const opened = await request(`${BASE}/me/messages/${draftId}/attachments/createUploadSession`, {
        method: "POST",
        body: JSON.stringify({
          AttachmentItem: { attachmentType: "file", name: file.filename, size: file.bytes.byteLength, contentType: file.mimeType },
        }),
      });
      const { uploadUrl } = (await requireOk(opened)) as { uploadUrl?: string };
      if (!uploadUrl) throw new Error(`Graph opened no upload session for ${file.filename}`);

      const total = file.bytes.byteLength;
      for (let at = 0; at < total; at += OUTLOOK_UPLOAD_CHUNK_BYTES) {
        const end = Math.min(at + OUTLOOK_UPLOAD_CHUNK_BYTES, total);
        const chunk = file.bytes.subarray(at, end);
        // No bearer token: the upload url carries its own authorisation, and
        // Graph rejects the request when both are present.
        const res = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Length": String(chunk.byteLength), "Content-Range": `bytes ${at}-${end - 1}/${total}` },
          body: new Uint8Array(chunk),
        });
        // 308 is Graph asking for the next chunk; 200/201 is the last one landing.
        if (!res.ok && res.status !== 308) {
          throw new Error(`Graph upload of ${file.filename} failed: ${res.status} ${await res.text()}`);
        }
      }
    },

    async sendDraft(draftId) {
      const res = await request(`${BASE}/me/messages/${draftId}/send`, { method: "POST" });
      await requireOk(res);
    },
  };
}
