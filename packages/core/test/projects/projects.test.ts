import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, messages, projectAssignments, threads } from "../../src/db/schema";
import {
  addStarterProjects,
  createProject,
  getProject,
  listProjects,
  saveProjects,
  STARTER_PROJECTS,
} from "../../src/projects/projects";
import { fileThread } from "../../src/projects/classify";

function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts)
    .values([
      { id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 },
      { id: "a2", provider: "imap", email: "work@example.com", displayName: null, createdAt: 1 },
    ])
    .run();
  db.insert(threads)
    .values([{ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "SOW", lastMessageAt: 100, lastFromOperator: false }])
    .run();
  db.insert(messages)
    .values([
      {
        id: "a1:t1:m1",
        accountId: "a1",
        providerMessageId: "m1",
        threadId: "a1:t1",
        rfcMessageId: null,
        fromAddress: "maya@client.com",
        fromName: null,
        toAddresses: ["me@example.com"],
        ccAddresses: [],
        subject: "SOW",
        bodyText: "The signed SOW is attached.",
        bodyHtml: null,
        snippet: null,
        attachmentNames: [],
        isFromOperator: false,
        sentAt: 100,
        receivedAt: 1,
      },
    ])
    .run();
}

describe("listProjects and saveProjects", () => {
  it("keeps each inbox's list to itself, in position order", () => {
    const db = testDb();
    seed(db);
    saveProjects(db, "a1", [
      { name: "Consulting", description: "client work" },
      { name: "Immigration", description: "visa" },
    ]);
    saveProjects(db, "a2", [{ name: "Robotics research", description: "papers" }]);

    expect(listProjects(db, "a1").map((p) => p.name)).toEqual(["Consulting", "Immigration"]);
    expect(listProjects(db, "a2").map((p) => p.name)).toEqual(["Robotics research"]);
  });

  it("reorders, renames, and adds in one save", () => {
    const db = testDb();
    seed(db);
    saveProjects(db, "a1", [
      { name: "Consulting", description: "client work" },
      { name: "Immigration", description: "visa" },
    ]);
    const [consulting, immigration] = listProjects(db, "a1");

    saveProjects(db, "a1", [
      { id: immigration!.id, name: "Immigration", description: "visa" },
      { id: consulting!.id, name: "Advisory", description: "client work" },
      { name: "Finance agent", description: "Plaid" },
    ]);

    expect(listProjects(db, "a1").map((p) => p.name)).toEqual(["Immigration", "Advisory", "Finance agent"]);
    // The renamed row is still the same row, so nothing filed there moved.
    expect(listProjects(db, "a1")[1]!.id).toBe(consulting!.id);
  });

  it("keeps filed mail through a rename", () => {
    const db = testDb();
    seed(db);
    saveProjects(db, "a1", [{ name: "Consulting", description: "client work" }]);
    const project = listProjects(db, "a1")[0]!;
    fileThread(db, "a1:t1", project.id);

    saveProjects(db, "a1", [{ id: project.id, name: "Advisory", description: "client work" }]);

    const assignment = db.select().from(projectAssignments).where(eq(projectAssignments.messageId, "a1:t1:m1")).get();
    expect(assignment?.projectId).toBe(project.id);
    expect(assignment?.source).toBe("manual");
  });

  it("sends a deleted project's mail to Unfiled and keeps its source", () => {
    const db = testDb();
    seed(db);
    saveProjects(db, "a1", [{ name: "Consulting", description: "client work" }]);
    const project = listProjects(db, "a1")[0]!;
    fileThread(db, "a1:t1", project.id);

    saveProjects(db, "a1", []);

    expect(listProjects(db, "a1")).toEqual([]);
    const assignment = db.select().from(projectAssignments).where(eq(projectAssignments.messageId, "a1:t1:m1")).get();
    expect(assignment?.projectId).toBeNull();
    expect(assignment?.source).toBe("manual");
  });

  it("refuses a blank name, a duplicate, the reserved name, and too many", () => {
    const db = testDb();
    seed(db);
    expect(() => saveProjects(db, "a1", [{ name: "  ", description: "x" }])).toThrow("Every project needs a name.");
    expect(() =>
      saveProjects(db, "a1", [
        { name: "Consulting", description: "x" },
        { name: "consulting", description: "y" },
      ]),
    ).toThrow('"consulting" is listed twice.');
    expect(() => saveProjects(db, "a1", [{ name: "unfiled", description: "x" }])).toThrow("reserved");
    expect(() => saveProjects(db, "a1", [{ name: "x".repeat(41), description: "" }])).toThrow("longer than 40");
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `p${i}`, description: "" }));
    expect(() => saveProjects(db, "a1", many)).toThrow("24 projects or fewer");
  });
});

describe("project description length", () => {
  it("has room for a description a model actually wrote", () => {
    const db = testDb();
    seed(db);
    // The proposed project list runs to a few hundred characters each; the
    // old 200 meant every Save in the editor failed on descriptions already
    // in the database.
    saveProjects(db, "a1", [{ name: "Banking", description: "x".repeat(600) }]);
    expect(listProjects(db, "a1")[0]!.description).toHaveLength(600);
    expect(() => saveProjects(db, "a1", [{ name: "Banking", description: "x".repeat(601) }])).toThrow(/600/);
  });
});

describe("createProject", () => {
  it("appends to this inbox's list and returns the row", () => {
    const db = testDb();
    seed(db);
    saveProjects(db, "a1", [{ name: "Consulting", description: "client work" }]);
    const created = createProject(db, "a1", "  Immigration  ", " visa ");

    expect(created.name).toBe("Immigration");
    expect(created.description).toBe("visa");
    expect(created.position).toBe(1);
    expect(listProjects(db, "a1").map((p) => p.name)).toEqual(["Consulting", "Immigration"]);
  });

  it("refuses a name this inbox already uses", () => {
    const db = testDb();
    seed(db);
    saveProjects(db, "a1", [{ name: "Consulting", description: "client work" }]);
    expect(() => createProject(db, "a1", "consulting", "")).toThrow("listed twice");
    // A different inbox may use the same name.
    expect(() => createProject(db, "a2", "Consulting", "")).not.toThrow();
  });
});

describe("addStarterProjects", () => {
  it("adds the seed list once and skips what is already there", () => {
    const db = testDb();
    seed(db);
    expect(addStarterProjects(db, "a1")).toBe(STARTER_PROJECTS.length);
    expect(listProjects(db, "a1").map((p) => p.name)).toEqual(STARTER_PROJECTS.map((p) => p.name));
    expect(addStarterProjects(db, "a1")).toBe(0);
    expect(listProjects(db, "a1")).toHaveLength(STARTER_PROJECTS.length);
  });

  it("carries the seed descriptions the embedder matches against", () => {
    expect(STARTER_PROJECTS.map((p) => p.name)).toEqual(["Clients", "Money", "Legal and admin", "Recruiting", "Suppliers and tools", "Personal"]);
    expect(STARTER_PROJECTS.every((p) => p.description.length > 0 && p.description.length <= 200)).toBe(true);
  });

  // They ship to everyone who installs this, so they describe kinds of mail
  // and never a particular person, company or address.
  it("names nobody and nothing that belongs to whoever wrote them", () => {
    const text = STARTER_PROJECTS.map((p) => `${p.name} ${p.description}`).join(" ");
    expect(text).not.toMatch(/@|https?:\/\/|\.(com|org|net|edu)\b/);
  });
});

describe("getProject", () => {
  it("finds a project inside its inbox and nowhere else", () => {
    const db = testDb();
    seed(db);
    const created = createProject(db, "a1", "Consulting", "client work");
    expect(getProject(db, "a1", created.id)?.name).toBe("Consulting");
    expect(getProject(db, "a2", created.id)).toBeNull();
  });
});
