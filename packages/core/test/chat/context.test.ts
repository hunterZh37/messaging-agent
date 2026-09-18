import { describe, it, expect } from "vitest";
import { testDb } from "../helpers/db";
import { describeThreads } from "../../src/chat/context";
import { appendChatMessage, getOrCreateChat, listChatMessages } from "../../src/chat/store";
import { seedMail } from "./seed";

describe("describeThreads", () => {
  it("names each thread by subject and the last writer who is not the operator", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", threadId: "a1:t1", subject: "Visa timeline", fromName: "Victoria Chen", fromAddress: "victoria@example.com", sentAt: 1 },
      { id: "m2", threadId: "a1:t1", subject: "Re: Visa timeline", fromName: "Paralegal", fromAddress: "para@example.com", sentAt: 2 },
      { id: "m3", threadId: "a1:t1", subject: "Re: Visa timeline", isFromOperator: true, fromName: "Me", fromAddress: "me@example.com", sentAt: 3 },
    ]);
    expect(describeThreads(db, ["a1:t1"])).toEqual([{ id: "a1:t1", subject: "Visa timeline", from: "Paralegal <para@example.com>" }]);
  });

  it("keeps the order asked for, skips unknown ids, and names an operator-only thread by its sender", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", threadId: "a1:t1", subject: "One" },
      { id: "m2", threadId: "a1:t2", subject: "Sent", isFromOperator: true, fromName: null, fromAddress: "me@example.com" },
    ]);
    expect(describeThreads(db, ["a1:t2", "a1:missing", "a1:t1"])).toEqual([
      { id: "a1:t2", subject: "Sent", from: "me@example.com" },
      { id: "a1:t1", subject: "One", from: "Bob <bob@example.com>" },
    ]);
    expect(describeThreads(db, [])).toEqual([]);
  });
});

describe("listChatMessages", () => {
  it("names the threads of proposals stored before proposals carried names", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", threadId: "a1:t1", subject: "Visa timeline", fromName: "Victoria Chen", fromAddress: "victoria@example.com" }]);
    const chat = getOrCreateChat(db);
    appendChatMessage(
      db,
      {
        chatId: chat.id,
        role: "assistant",
        content: "Filed.",
        contextThreadId: null,
        citations: [],
        actions: [{ kind: "file_to_project", threadIds: ["a1:t1"], projectName: "Immigration" }, { kind: "open_thread", threadIds: [], threadId: "a1:t1" }],
        model: "fake",
        inputTokens: 1,
        outputTokens: 1,
      },
      () => 5,
    );
    const [row] = listChatMessages(db, chat.id);
    expect(row!.actions?.map((a) => a.threads)).toEqual([
      [{ id: "a1:t1", subject: "Visa timeline", from: "Victoria Chen <victoria@example.com>" }],
      [{ id: "a1:t1", subject: "Visa timeline", from: "Victoria Chen <victoria@example.com>" }],
    ]);
  });
});
