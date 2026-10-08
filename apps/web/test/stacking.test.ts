import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * What covers what (whole-branch review, 2026-10-07). The floating Ask
 * launcher sat above every scrim, so with a dialog open it still painted and
 * still took clicks — and pressing it opened the panel *underneath* the scrim,
 * which reads as the button vanishing and nothing happening. The sidebar row
 * it replaced was safely covered; the button that replaced it has to be too.
 */
const css = readFileSync(path.join(__dirname, "../app/globals.css"), "utf8");

function zIndexOf(selector: string): number {
  const rule = new RegExp(`^\\${selector}\\s*\\{([^}]*)\\}`, "m").exec(css) ?? new RegExp(`^\\${selector}\\s*\\{([\\s\\S]*?)\\}`, "m").exec(css);
  if (!rule) throw new Error(`no rule for ${selector}`);
  const z = /z-index:\s*(\d+)/.exec(rule[1]!);
  if (!z) throw new Error(`no z-index on ${selector}`);
  return Number(z[1]);
}

describe("what covers the Ask launcher", () => {
  it("is covered by a dialog's scrim, so it cannot be pressed underneath one", () => {
    expect(zIndexOf(".ask-launch")).toBeLessThan(zIndexOf(".dialog-scrim"));
  });

  it("is covered by a sheet's veil", () => {
    expect(zIndexOf(".ask-launch")).toBeLessThan(zIndexOf(".sheet-veil"));
  });

  /** A message about what just happened must never sit behind the button. */
  it("does not cover the toasts", () => {
    expect(zIndexOf(".ask-launch")).toBeLessThan(zIndexOf(".toasts"));
  });
});
