import { describe, it, expect } from "vitest";
import { CORE_VERSION } from "../src/index";

describe("core package", () => {
  it("loads", () => {
    expect(CORE_VERSION).toBe("0.0.1");
  });
});
