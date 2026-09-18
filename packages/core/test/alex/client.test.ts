import { describe, it, expect } from "vitest";
import { accountRow, testDb } from "../helpers/db";
import { accounts, threads } from "../../src/db/schema";
import { addToAlex, AlexNotConnected, AlexRefused, ALEX_TOOL, argumentsFor, freeTimes, type AlexItem } from "../../src/alex/client";
import { itemOf, listAlexItems, retryAlexItem, sendToAlex } from "../../src/alex/items";

const CONFIG = { url: "https://alex.test/api/mcp", token: "t0ken" };

/** Alex, as far as the client can tell: one POST in, one JSON-RPC answer out. */
function fakeAlex(reply: (body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }) => unknown, seen: unknown[] = []) {
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push({ url: _url, headers: init?.headers, body });
    const answer = reply(body);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

/** What Alex's own tools answer with on success. */
function landed(result: Record<string, unknown>) {
  return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
}

const TODO: AlexItem = { kind: "actionable", title: "Send SOW PDF", dayISO: "2026-09-18T12:00:00.000Z" };

describe("the arguments each kind goes over as", () => {
  it("matches Alex's own schemas, one tool per kind", () => {
    expect(ALEX_TOOL).toEqual({ actionable: "create_actionable", event: "create_event" });
  });

  it("sends an actionable's times only as a pair, since Alex rejects half a range", () => {
    expect(argumentsFor(TODO)).toEqual({ title: "Send SOW PDF", dayISO: "2026-09-18T12:00:00.000Z" });
    expect(argumentsFor({ ...TODO, startISO: "2026-09-18T17:00:00.000Z" })).toEqual({
      title: "Send SOW PDF",
      dayISO: "2026-09-18T12:00:00.000Z",
    });
    expect(argumentsFor({ ...TODO, startISO: "2026-09-18T17:00:00.000Z", endISO: "2026-09-18T17:30:00.000Z" })).toMatchObject({
      startISO: "2026-09-18T17:00:00.000Z",
      endISO: "2026-09-18T17:30:00.000Z",
    });
  });

  it("leaves out what the operator did not fill in", () => {
    expect(argumentsFor({ kind: "event", title: "Walkthrough", startISO: "a", endISO: "b" })).toEqual({ title: "Walkthrough", startISO: "a", endISO: "b" });
  });

  // Only the two the operator can pick: reminders are Alex's to make (2026-09-16).
  it("offers an actionable and an event, and nothing else", () => {
    expect(Object.keys(ALEX_TOOL)).toEqual(["actionable", "event"]);
  });
});

describe("addToAlex", () => {
  it("calls one tool with the bearer token and no handshake: Alex holds no session", async () => {
    const alex = fakeAlex(() => landed({ ok: true, todoId: "todo_1" }));
    const written = await addToAlex(TODO, CONFIG, alex.impl);
    expect(written.id).toBe("todo_1");
    expect(alex.seen).toHaveLength(1);
    const call = alex.seen[0] as { url: string; headers: Record<string, string>; body: { method: string; params: { name: string } } };
    expect(call.url).toBe(CONFIG.url);
    expect(call.headers.authorization).toBe("Bearer t0ken");
    expect(call.body.method).toBe("tools/call");
    expect(call.body.params.name).toBe("create_actionable");
  });

  it("reads the id back under whichever name that tool uses", async () => {
    const event = fakeAlex(() => landed({ ok: true, eventId: "ev_3", videoLink: null }));
    await expect(addToAlex({ kind: "event", title: "t", startISO: "a", endISO: "b" }, CONFIG, event.impl)).resolves.toMatchObject({ id: "ev_3" });
  });

  // Alex reports a tool that failed as an ordinary result carrying isError, so
  // a client that only watches for JSON-RPC errors would call it a success.
  it("treats an isError result as a refusal, with Alex's own words", async () => {
    const alex = fakeAlex(() => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "endISO must be after startISO" }], isError: true } }));
    await expect(addToAlex(TODO, CONFIG, alex.impl)).rejects.toThrow("endISO must be after startISO");
  });

  it("says what to fix when the token is wrong, and when there is none", async () => {
    const alex = fakeAlex(() => new Response("no", { status: 401 }));
    await expect(addToAlex(TODO, CONFIG, alex.impl)).rejects.toThrow(/ALEX_MCP_TOKEN/);
    await expect(addToAlex(TODO, { ...CONFIG, token: undefined }, alex.impl)).rejects.toBeInstanceOf(AlexNotConnected);
  });

  it("calls a JSON-RPC error a refusal too", async () => {
    const alex = fakeAlex(() => ({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Unknown or unavailable tool: create_actionable" } }));
    await expect(addToAlex(TODO, CONFIG, alex.impl)).rejects.toBeInstanceOf(AlexRefused);
  });

  it("does not call an unreachable Alex a success", async () => {
    const impl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(addToAlex(TODO, CONFIG, impl)).rejects.toThrow("Alex could not be reached.");
  });
});

describe("the times Alex says are free", () => {
  it("asks get_availability for the range and the length, and reads the slots back", async () => {
    const alex = fakeAlex(() => landed({ slots: [{ start: "2026-09-16T22:30:00.000Z", end: "2026-09-16T22:45:00.000Z" }], timezone: "America/Los_Angeles", warnings: 0 }));
    const got = await freeTimes({ startISO: "a", endISO: "b", minutes: 15 }, CONFIG, alex.impl);
    expect(got).toEqual({ slots: [{ startISO: "2026-09-16T22:30:00.000Z", endISO: "2026-09-16T22:45:00.000Z" }], timezone: "America/Los_Angeles" });
    const call = alex.seen[0] as { body: { params: { name: string; arguments: Record<string, unknown> } } };
    expect(call.body.params.name).toBe("get_availability");
    expect(call.body.params.arguments).toEqual({ startISO: "a", endISO: "b", durationMinutes: 15 });
  });

  // It is a public tool, so a missing token is not a reason to refuse to look.
  it("works without a token, unlike the writes", async () => {
    const alex = fakeAlex(() => landed({ slots: [], timezone: "UTC", warnings: 0 }));
    await expect(freeTimes({ startISO: "a", endISO: "b", minutes: 15 }, { ...CONFIG, token: undefined }, alex.impl)).resolves.toMatchObject({ slots: [] });
    const call = alex.seen[0] as { headers: Record<string, string> };
    expect(call.headers.authorization).toBeUndefined();
  });

  it("treats a day with nothing free as an answer, not a failure", async () => {
    const alex = fakeAlex(() => landed({ slots: [], timezone: "America/Los_Angeles", warnings: 0 }));
    await expect(freeTimes({ startISO: "a", endISO: "b", minutes: 30 }, CONFIG, alex.impl)).resolves.toEqual({ slots: [], timezone: "America/Los_Angeles" });
  });
});

function threadDb() {
  const db = testDb();
  db.insert(accounts).values(accountRow({ id: "a1", provider: "imap", email: "me@example.com" })).run();
  db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "SOW", lastMessageAt: 100, lastFromOperator: false }).run();
  return db;
}

describe("what the thread records", () => {
  it("keeps a row for a write that landed, with Alex's id on it", async () => {
    const db = threadDb();
    const alex = fakeAlex(() => landed({ ok: true, todoId: "todo_1" }));
    const row = await sendToAlex(db, "a1:t1", TODO, CONFIG, () => 5, alex.impl);
    expect(row).toMatchObject({ status: "added", alexId: "todo_1", kind: "actionable", title: "Send SOW PDF", error: null });
    expect(listAlexItems(db, "a1:t1")).toHaveLength(1);
  });

  // Spec 10e: every attempt is a row, so a failure is on the thread to retry
  // rather than a toast the operator has already swiped away.
  it("keeps a row for one that did not, with the reason", async () => {
    const db = threadDb();
    const alex = fakeAlex(() => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "title is required" }], isError: true } }));
    const row = await sendToAlex(db, "a1:t1", TODO, CONFIG, () => 5, alex.impl);
    expect(row).toMatchObject({ status: "failed", alexId: null, error: "title is required" });
  });

  it("sends a failed one again exactly as it was, and leaves the failure on the record", async () => {
    const db = threadDb();
    const bad = fakeAlex(() => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Alex was asleep" }], isError: true } }));
    const failed = await sendToAlex(db, "a1:t1", TODO, CONFIG, () => 5, bad.impl);
    const good = fakeAlex(() => landed({ ok: true, todoId: "todo_2" }));
    const again = await retryAlexItem(db, failed.id, CONFIG, () => 6, good.impl);
    expect(again).toMatchObject({ status: "added", alexId: "todo_2" });
    expect((good.seen[0] as { body: { params: { arguments: unknown } } }).body.params.arguments).toEqual(argumentsFor(TODO));
    const rows = listAlexItems(db, "a1:t1");
    expect(rows.map((r) => r.status)).toEqual(["failed", "added"]);
  });

  it("will not send one that already landed a second time", async () => {
    const db = threadDb();
    const alex = fakeAlex(() => landed({ ok: true, todoId: "todo_1" }));
    const row = await sendToAlex(db, "a1:t1", TODO, CONFIG, () => 5, alex.impl);
    expect(await retryAlexItem(db, row.id, CONFIG, () => 6, alex.impl)).toBeNull();
    expect(alex.seen).toHaveLength(1);
  });

  it("reads each kind back as the item it was", () => {
    const row = { id: "x", threadId: "a1:t1", title: "t", createdAt: 1, status: "failed" as const, alexId: null, error: null };
    expect(itemOf({ ...row, kind: "event", whenISO: "s", endISO: "e" })).toEqual({ kind: "event", title: "t", startISO: "s", endISO: "e" });
    expect(itemOf({ ...row, kind: "actionable", whenISO: "d", endISO: null })).toEqual({ kind: "actionable", title: "t", dayISO: "d" });
    expect(itemOf({ ...row, kind: "actionable", whenISO: "s", endISO: "e" })).toMatchObject({ startISO: "s", endISO: "e" });
  });
});
