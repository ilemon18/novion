import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

const kinds = (lines: ReturnType<typeof diffLines>) => lines.map((line) => line.kind);
const texts = (lines: ReturnType<typeof diffLines>) => lines.map((line) => line.text);

describe("diffLines", () => {
  it("reports identical input as unchanged", () => {
    const out = diffLines(["a", "b"], ["a", "b"]);
    expect(kinds(out)).toEqual(["same", "same"]);
  });

  it("marks a replaced line as one removal and one addition", () => {
    const out = diffLines(["a", "b", "c"], ["a", "B", "c"]);
    expect(kinds(out)).toEqual(["same", "del", "add", "same"]);
    expect(texts(out)).toEqual(["a", "b", "B", "c"]);
  });

  it("keeps an insertion in place", () => {
    const out = diffLines(["a", "c"], ["a", "b", "c"]);
    expect(kinds(out)).toEqual(["same", "add", "same"]);
    expect(texts(out)).toEqual(["a", "b", "c"]);
  });

  it("handles an empty side", () => {
    expect(kinds(diffLines([], ["x"]))).toEqual(["add"]);
    expect(kinds(diffLines(["x"], []))).toEqual(["del"]);
  });

  it("preserves the common prefix and suffix without duplicating them", () => {
    const before = ["1", "2", "old", "4", "5"];
    const after = ["1", "2", "new", "4", "5"];
    const out = diffLines(before, after);
    expect(out.filter((line) => line.kind === "same")).toHaveLength(4);
    expect(out.filter((line) => line.kind === "del").map((l) => l.text)).toEqual(["old"]);
    expect(out.filter((line) => line.kind === "add").map((l) => l.text)).toEqual(["new"]);
  });
});