import { describe, it, expect } from "vitest";
import { isSameOrigin } from "../lib/origin";
import config from "../next.config";

const from = (headers: Record<string, string>) => new Request("http://127.0.0.1:3100/api/drafts/d1/attachments", { headers });

describe("isSameOrigin", () => {
  it("accepts a request the app's own page made", () => {
    expect(isSameOrigin(from({ host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100", "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("refuses a request another site made, whatever Origin claims", () => {
    expect(isSameOrigin(from({ host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOrigin(from({ host: "127.0.0.1:3100", origin: "http://evil.example", "sec-fetch-site": "same-origin" }))).toBe(false);
  });

  it("falls back to Origin when the browser sends no Sec-Fetch-Site", () => {
    expect(isSameOrigin(from({ host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" }))).toBe(true);
    expect(isSameOrigin(from({ host: "127.0.0.1:3100", origin: "http://evil.example" }))).toBe(false);
  });

  it("accepts a same-origin GET, which carries Sec-Fetch-Site and no Origin (2026-09-13: the live pulse)", () => {
    expect(isSameOrigin(from({ host: "127.0.0.1:3100", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(from({ host: "127.0.0.1:3100", "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("refuses a request that names no origin at all", () => {
    // Every fetch that writes something sends Origin. One that does not is
    // not the app's page, so it does not get to attach a file to a draft.
    expect(isSameOrigin(from({ host: "127.0.0.1:3100" }))).toBe(false);
  });

  it("reads the host the browser used, so localhost and 127.0.0.1 each agree with themselves", () => {
    expect(isSameOrigin(from({ host: "localhost:3100", origin: "http://localhost:3100", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(from({ host: "localhost:3100", origin: "http://127.0.0.1:3100", "sec-fetch-site": "same-origin" }))).toBe(false);
  });
});

/**
 * The one policy the app sets for every page, and the three routes left out
 * of it: those serve bytes we did not write, and a page CSP over a PDF leaves
 * Chrome's viewer blank. Read straight off the config, so adding a route that
 * serves a file and forgetting the exclusion shows up here.
 */
describe("the app's CSP, and what it is not applied to", () => {
  const source = (config.headers as unknown as () => Promise<{ source: string }[]>)();

  async function covered(path: string): Promise<boolean> {
    const [rule] = await source;
    // Next matches the whole path against the source pattern, leading / included.
    return new RegExp(`^${rule!.source}$`).test(path);
  }

  it("leaves out the routes that serve a file's bytes", async () => {
    expect(await covered("/api/attachments/att-1")).toBe(false);
    expect(await covered("/api/drafts/d1/attachments/att-1")).toBe(false);
    expect(await covered("/api/chats/chat-1/files/f1")).toBe(false);
  });

  it("still covers every page, and the routes that only write", async () => {
    expect(await covered("/inbox/t1")).toBe(true);
    expect(await covered("/api/drafts/d1/attachments")).toBe(true);
    expect(await covered("/api/chats/chat-1/files")).toBe(true);
  });
});
