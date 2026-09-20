import { describe, it, expect } from "vitest";
import { marked, toggleMark } from "../lib/marks";

const at = (text: string, word: string) => [text.indexOf(word), text.indexOf(word) + word.length] as const;

describe("the bold and underline buttons", () => {
  it("wraps what is selected", () => {
    const t = "send the signed copy";
    expect(toggleMark(t, ...at(t, "signed"), "bold").text).toBe("send the **signed** copy");
    expect(toggleMark(t, ...at(t, "signed"), "underline").text).toBe("send the __signed__ copy");
  });

  it("takes the wrapping off when it is pressed again", () => {
    const t = "send the **signed** copy";
    expect(toggleMark(t, ...at(t, "**signed**"), "bold").text).toBe("send the signed copy");
  });

  /** Selecting the word, not the marks around it, is what a person actually does. */
  it("takes it off when the marks sit just outside the selection", () => {
    const t = "send the **signed** copy";
    expect(toggleMark(t, ...at(t, "signed"), "bold").text).toBe("send the signed copy");
  });

  it("leaves the selection on the same words afterwards", () => {
    const t = "send the signed copy";
    const r = toggleMark(t, ...at(t, "signed"), "bold");
    expect(r.text.slice(r.start, r.end)).toBe("**signed**");
    const back = toggleMark(r.text, r.start, r.end, "bold");
    expect(back.text.slice(back.start, back.end)).toBe("signed");
  });

  it("does nothing when nothing is selected", () => {
    expect(toggleMark("plain words", 4, 4, "bold")).toEqual({ text: "plain words", start: 4, end: 4 });
  });

  /** A mark around a space renders as a mark around nothing. */
  it("tightens onto the words, leaving a dragged space outside", () => {
    const t = "send the signed copy";
    expect(toggleMark(t, 8, 15, "bold").text).toBe("send the **signed** copy");
  });

  it("does nothing when the selection is only space", () => {
    expect(toggleMark("a   b", 1, 4, "bold").text).toBe("a   b");
  });

  it("holds both marks on different words at once", () => {
    let t = "send the signed copy by Friday";
    t = toggleMark(t, ...at(t, "signed"), "bold").text;
    t = toggleMark(t, ...at(t, "Friday"), "underline").text;
    expect(t).toBe("send the **signed** copy by __Friday__");
  });

  it("says whether the selection already carries the mark", () => {
    const t = "send the **signed** copy";
    expect(marked(t, ...at(t, "signed"), "bold")).toBe(true);
    expect(marked(t, ...at(t, "signed"), "underline")).toBe(false);
    expect(marked(t, ...at(t, "copy"), "bold")).toBe(false);
    expect(marked(t, 4, 4, "bold")).toBe(false);
  });
});
