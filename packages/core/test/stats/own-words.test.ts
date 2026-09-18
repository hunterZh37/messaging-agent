import { describe, it, expect } from "vitest";
import { ownWords } from "../../src/stats/own-words";

describe("ownWords", () => {
  it("stops at the quoted thread, keeping only what was written above it", () => {
    const body = [
      "Awesome Darin, thank you so much. Let me know if there's anything I need to do.",
      "",
      "Thank you,",
      "Hunter",
      "",
      "On Sun, Aug 2, 2026 at 5:53 PM See, Darin <d@example.com> wrote:",
      "",
      "Likewise, Hunter, and hope all is well sir",
    ].join("\n");

    const out = ownWords(body);
    expect(out).toContain("Awesome Darin");
    expect(out).not.toContain("Likewise");
    expect(out).not.toContain("wrote:");
  });

  it("drops a forwarded header block and everything under it", () => {
    const out = ownWords("Here you go.\n\nFrom: Someone <s@example.com>\nSent: Monday\nSubject: Re: thing");
    expect(out).toBe("Here you go.");
  });

  it("drops the -----Original Message----- form too", () => {
    const out = ownWords("Short reply.\n-----Original Message-----\nFrom: them");
    expect(out).toBe("Short reply.");
  });

  it("drops lines somebody else's client prefixed with >", () => {
    const out = ownWords("Agreed.\n> the original point\n> a second line");
    expect(out).toBe("Agreed.");
  });

  it("drops a phone signature, which is the client talking and not the operator", () => {
    expect(ownWords("On my way\n\nSent from my iPhone")).toBe("On my way");
  });

  it("caps a long body so one mail cannot outweigh a month of chat", () => {
    const out = ownWords("x".repeat(500), 100);
    expect(out).toHaveLength(101);
    expect(out?.endsWith("…")).toBe(true);
  });

  it("returns null for a body with nothing in it", () => {
    expect(ownWords(null)).toBeNull();
    expect(ownWords("   ")).toBeNull();
    expect(ownWords("On Mon, 1 Jan 2026 at 09:00, A <a@example.com> wrote:\n> everything")).toBeNull();
  });

  it("leaves an ordinary chat message exactly as it was", () => {
    expect(ownWords("sounds good, see you at 6")).toBe("sounds good, see you at 6");
  });
});
