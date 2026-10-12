import { describe, it, expect } from "vitest";
import type { PriorVerdict } from "@messaging-agent/core";

/**
 * The undo for "Move all to Worth Knowing" carries whole `sorts` rows from the
 * server to the browser and back again (2026-10-12). A server action hands
 * them over as JSON, so anything in a row that does not survive that trip
 * would come back altered and the undo would write the altered thing.
 *
 * The move itself proved the outward leg in the browser — the toast could not
 * have appeared otherwise. This pins the leg that only runs when Undo is
 * pressed.
 */
describe("what the undo carries", () => {
  const row: PriorVerdict = {
    messageId: "a1:m1",
    row: {
      messageId: "a1:m1",
      wants: "reply",
      scheduling: false,
      category: "Needs reply",
      finance: "none",
      reason: "she asked about Friday",
      model: "sorter-v2",
      labeledAt: 7,
      sortedAt: 1_760_000_000_000,
      createdAt: 1_760_000_000_000,
    },
  };

  it("survives the trip to the browser and back unchanged", () => {
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
  });

  it("keeps a never-judged message as null rather than turning it into a row", () => {
    const unjudged: PriorVerdict = { messageId: "a1:m2", row: null };
    const back = JSON.parse(JSON.stringify(unjudged)) as PriorVerdict;
    expect(back.row).toBeNull();
  });

  it("keeps false a boolean, so scheduling does not come back as 0", () => {
    const back = JSON.parse(JSON.stringify(row)) as PriorVerdict;
    expect(back.row?.scheduling).toBe(false);
  });
});
