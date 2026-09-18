import { describe, it, expect } from "vitest";
import { parseAddressList } from "../../src/text/addresses";

describe("parseAddressList", () => {
  it("handles names, bare addresses, and empty input", () => {
    expect(parseAddressList("Bob Smith <bob@example.com>, carol@example.com")).toEqual([
      { address: "bob@example.com", name: "Bob Smith" },
      { address: "carol@example.com", name: null },
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList('"Last, First" <lf@example.com>')).toEqual([{ address: "lf@example.com", name: "Last, First" }]);
  });

  it("lowercases addresses and keeps display-name case", () => {
    expect(parseAddressList("Bob <BOB@Example.COM>")).toEqual([{ address: "bob@example.com", name: "Bob" }]);
  });
});
