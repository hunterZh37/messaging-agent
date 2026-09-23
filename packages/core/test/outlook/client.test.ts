import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createOutlookClient, OUTLOOK_INLINE_ATTACHMENT_LIMIT, OUTLOOK_UPLOAD_CHUNK_BYTES } from "../../src/outlook/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("createOutlookClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const getAccessToken = async () => "token-123";

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getProfile: reads mail, falling back to userPrincipalName, sends a bearer token", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ mail: "Me@Example.com" }));
    const client = createOutlookClient(getAccessToken);
    const p = await client.getProfile();
    expect(p.email).toBe("me@example.com");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/me?$select=mail,userPrincipalName");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-123");
  });

  it("getProfile: falls back to userPrincipalName when mail is absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ userPrincipalName: "Me@Example.com" }));
    const client = createOutlookClient(getAccessToken);
    expect((await client.getProfile()).email).toBe("me@example.com");
  });

  it("listMessages: filters by date, orders newest first, follows nextLink, and skips drafts", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            { id: "m1", isDraft: false },
            { id: "m2", isDraft: true },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: "m3", isDraft: false }] }));
    const client = createOutlookClient(getAccessToken);

    const r = await client.listMessages("inbox", "2024-01-01T00:00:00.000Z");

    expect(r.map((m) => m.id)).toEqual(["m1", "m3"]);
    const first = String(fetchMock.mock.calls[0]![0]);
    expect(first).toContain("/me/mailFolders/inbox/messages?");
    expect(first).toContain("$orderby=receivedDateTime desc");
    expect(first).toContain("$top=50");
    expect(first).toContain(encodeURIComponent("receivedDateTime ge 2024-01-01T00:00:00.000Z"));
    expect(String(fetchMock.mock.calls[1]![0])).toContain("$skip=50");
  });

  it("listMessages: sends no $filter when the whole mailbox is wanted", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ value: [] }));
    const client = createOutlookClient(getAccessToken);

    await client.listMessages("sent", null);

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/me/mailFolders/sentitems/messages?");
    expect(url).not.toContain("$filter");
  });

  it("delta: builds the initial request with $filter from sinceIso, skips drafts, returns the final deltaLink", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        value: [
          { id: "m1", isDraft: false },
          { id: "m2", isDraft: true },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?token=abc",
      }),
    );
    const client = createOutlookClient(getAccessToken);
    const r = await client.delta("inbox", null, "2024-01-01T00:00:00.000Z");
    expect(r).not.toBe("expired");
    if (r === "expired") throw new Error("unreachable");
    expect(r.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(r.deltaLink).toBe("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?token=abc");
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/me/mailFolders/inbox/messages/delta");
    expect(String(url)).toContain("$select=id,conversationId");
    expect(String(url)).toContain(encodeURIComponent("receivedDateTime ge 2024-01-01T00:00:00.000Z"));
  });

  it("delta: maps the sent folder to sentitems", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "d1" }));
    const client = createOutlookClient(getAccessToken);
    await client.delta("sent", null, null);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/me/mailFolders/sentitems/messages/delta");
  });

  it("delta: follows @odata.nextLink pages until it sees @odata.deltaLink", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: "m1" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next?p=2" }))
      .mockResolvedValueOnce(jsonResponse({ value: [{ id: "m2" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?p=final" }));
    const client = createOutlookClient(getAccessToken);
    const r = await client.delta("inbox", "https://graph.microsoft.com/v1.0/existing-link", null);
    if (r === "expired") throw new Error("unreachable");
    expect(r.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(r.deltaLink).toBe("https://graph.microsoft.com/v1.0/delta?p=final");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://graph.microsoft.com/v1.0/existing-link");
    expect(String(fetchMock.mock.calls[1]![0])).toBe("https://graph.microsoft.com/v1.0/next?p=2");
  });

  it("delta: takes the body as the sender wrote it, so HTML mail keeps its images", async () => {
    // Operator, 2026-09-11: with the text preference on, mail with images
    // rendered as gaps and "[logo]" placeholders.
    fetchMock.mockResolvedValueOnce(jsonResponse({ value: [], "@odata.deltaLink": "d1" }));
    const client = createOutlookClient(getAccessToken);
    await client.delta("inbox", null, null);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Prefer).toBeUndefined();
  });

  it("getBody: asks for one message's body alone", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "m1", body: { contentType: "html", content: "<p>hi</p>" } }));
    const client = createOutlookClient(getAccessToken);
    expect(await client.getBody("m1")).toEqual({ contentType: "html", content: "<p>hi</p>" });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://graph.microsoft.com/v1.0/me/messages/m1?$select=body");
  });

  it("delta: returns 'expired' on HTTP 410", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 410 }));
    const client = createOutlookClient(getAccessToken);
    expect(await client.delta("inbox", "stale-link", null)).toBe("expired");
  });

  it("ensureCategory: skips creating a category that already exists", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ value: [{ displayName: "agent/important" }] }));
    const client = createOutlookClient(getAccessToken);
    await client.ensureCategory("agent/important");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ensureCategory: creates a missing category with preset0", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ value: [] })).mockResolvedValueOnce(jsonResponse({ id: "cat1" }));
    const client = createOutlookClient(getAccessToken);
    await client.ensureCategory("agent/needs-reply");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ displayName: "agent/needs-reply", color: "preset0" });
  });

  it("addCategories: reads existing categories and PATCHes the union, never removing", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ categories: ["existing"] }))
      .mockResolvedValueOnce(jsonResponse({}));
    const client = createOutlookClient(getAccessToken);
    await client.addCategories("m1", ["agent/important"]);
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ categories: ["existing", "agent/important"] });
  });

  it("createMessage: POSTs to /me/messages with subject and recipients, returns the draft id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "draft-1" }));
    const client = createOutlookClient(getAccessToken);
    const r = await client.createMessage({ subject: "Let's talk", to: ["bob@x.com"], cc: ["carol@x.com"] });
    expect(r.draftId).toBe("draft-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/me/messages");
    expect(String(url)).not.toContain("/createReply");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      subject: "Let's talk",
      toRecipients: [{ emailAddress: { address: "bob@x.com" } }],
      ccRecipients: [{ emailAddress: { address: "carol@x.com" } }],
    });
  });

  it("createReply: returns the draft id from createReply", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "draft-1" }));
    const client = createOutlookClient(getAccessToken);
    const r = await client.createReply("m1");
    expect(r.draftId).toBe("draft-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/me/messages/m1/createReply");
    expect(init.method).toBe("POST");
  });

  it("updateDraft: PATCHes text body and recipients", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = createOutlookClient(getAccessToken);
    await client.updateDraft("draft-1", { body: "Yes, Friday.", to: ["bob@x.com"], cc: ["carol@x.com"] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/me/messages/draft-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      body: { contentType: "text", content: "Yes, Friday." },
      toRecipients: [{ emailAddress: { address: "bob@x.com" } }],
      ccRecipients: [{ emailAddress: { address: "carol@x.com" } }],
    });
  });

  it("sendDraft: POSTs to the send endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 202 }));
    const client = createOutlookClient(getAccessToken);
    await client.sendDraft("draft-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/me/messages/draft-1/send");
    expect(init.method).toBe("POST");
  });

  it("addAttachment: a small file goes inline as base64 on the draft", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "att-1" }, 201));
    const client = createOutlookClient(getAccessToken);

    await client.addAttachment("draft-1", { filename: "invoice.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4") });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/me/messages/draft-1/attachments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "invoice.pdf",
      contentType: "application/pdf",
      contentBytes: Buffer.from("%PDF-1.4").toString("base64"),
    });
  });

  it("addAttachment: a large file goes through an upload session, in chunks, to the url it hands back", async () => {
    const bytes = Buffer.alloc(OUTLOOK_UPLOAD_CHUNK_BYTES + 1, 7);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ uploadUrl: "https://upload.example/session/1" }, 201))
      .mockResolvedValueOnce(new Response("", { status: 308 }))
      .mockResolvedValueOnce(new Response("", { status: 201 }));
    const client = createOutlookClient(getAccessToken);

    await client.addAttachment("draft-1", { filename: "deck.pdf", mimeType: "application/pdf", bytes });

    const [sessionUrl, sessionInit] = fetchMock.mock.calls[0]!;
    expect(String(sessionUrl)).toContain("/me/messages/draft-1/attachments/createUploadSession");
    expect(JSON.parse(sessionInit.body as string)).toEqual({
      AttachmentItem: { attachmentType: "file", name: "deck.pdf", size: bytes.byteLength, contentType: "application/pdf" },
    });

    const ranges = fetchMock.mock.calls.slice(1).map(([url, init]) => {
      // The upload url is pre-authorised: sending the bearer token to it is what Graph rejects.
      expect(String(url)).toBe("https://upload.example/session/1");
      expect(init.method).toBe("PUT");
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      return (init.headers as Record<string, string>)["Content-Range"];
    });
    expect(ranges).toEqual([
      `bytes 0-${OUTLOOK_UPLOAD_CHUNK_BYTES - 1}/${bytes.byteLength}`,
      `bytes ${OUTLOOK_UPLOAD_CHUNK_BYTES}-${bytes.byteLength - 1}/${bytes.byteLength}`,
    ]);
  });

  it("addAttachment: a failed chunk says so rather than sending a half file", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ uploadUrl: "https://upload.example/session/1" }, 201))
      .mockResolvedValueOnce(new Response("out of space", { status: 507 }));
    const client = createOutlookClient(getAccessToken);

    await expect(
      client.addAttachment("draft-1", { filename: "deck.pdf", mimeType: "application/pdf", bytes: Buffer.alloc(OUTLOOK_INLINE_ATTACHMENT_LIMIT + 1) }),
    ).rejects.toThrow(/deck\.pdf/);
  });

  it("throws including the status and error.message on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "message not found" } }, 404));
    const client = createOutlookClient(getAccessToken);
    await expect(client.createReply("missing")).rejects.toThrow(/404/);
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "message not found" } }, 404));
    await expect(client.createReply("missing")).rejects.toThrow(/message not found/);
  });

  it("ensureCategory: a 403 on the master list is not a failure, the category still sticks to mail", async () => {
    // MailboxSettings.ReadWrite is not among the app's scopes, and a personal
    // account answers 403 for the master list. Labelling must go on regardless.
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: "Access is denied." } }, 403));
    const client = createOutlookClient(getAccessToken);
    await expect(client.ensureCategory("agent/important")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
