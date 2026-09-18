import { describe, it, expect } from "vitest";
import { findQuoteMismatches, quotePieces } from "../../src/chat/quotes";

const BODIES: Record<string, string> = {
  "wa:grant": "Your email for the grantmaking project:\n\nUsername: me@grants.example.com\nPassword: 1234Ab56",
  "wa:iog": "For email, we will have you use:\n\nRobin Doe\n\nUsername: me@other.example.com\n\nPassword: 5678Cd90",
};
const bodyOf = (id: string) => BODIES[id] ?? null;

/** Quotes checked against what they cite (2026-09-15: an invented password quote). */
describe("findQuoteMismatches", () => {
  it("catches a quote that joins one message's address to another's password", () => {
    const answer = 'Found it in your WhatsApp chat with **Jordan Vega**:\n\n> "me@grants.example.com / Password: 5678Cd90" [msg:wa:iog]';
    expect(findQuoteMismatches(answer, bodyOf)).toEqual([{ quote: "me@grants.example.com / Password: 5678Cd90", messageId: "wa:iog" }]);
  });

  it("accepts a quote copied from the cited message, lines joined with a slash or words elided", () => {
    expect(findQuoteMismatches('> "me@grants.example.com / Password: 1234Ab56" [msg:wa:grant]', bodyOf)).toEqual([]);
    expect(findQuoteMismatches('He wrote "Your email for the grantmaking … Password: 1234Ab56" [msg:wa:grant].', bodyOf)).toEqual([]);
    expect(findQuoteMismatches("> Username: ME@grants.example.com\n[msg:wa:grant]", bodyOf)).toEqual([]);
  });

  it("leaves alone quotes with no citation, short quotes, and plain sentences", () => {
    expect(findQuoteMismatches('He said "something invented here" but cited nothing.', bodyOf)).toEqual([]);
    expect(findQuoteMismatches('It says "ok" [msg:wa:grant]', bodyOf)).toEqual([]);
    expect(findQuoteMismatches("The password is in Jordan's message [msg:wa:grant].", bodyOf)).toEqual([]);
  });

  it("counts a citation to a message that does not exist as a mismatch", () => {
    expect(findQuoteMismatches('> "Username: me@grants.example.com" [msg:wa:nope]', bodyOf)).toHaveLength(1);
  });
});

describe("quotePieces", () => {
  it("splits where lines were joined or words left out, and drops scraps", () => {
    expect(quotePieces("me@grants.example.com / Password: 1234Ab56")).toEqual(["me@grants.example.com", "password: 1234ab56"]);
    expect(quotePieces("Your email … Password: x")).toEqual(["your email", "password: x"]);
  });
});
