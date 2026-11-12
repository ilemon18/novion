import { describe, expect, it } from "vitest";
import { docLines, docText } from "./doc-text";

const doc = (content: unknown[]) => ({ type: "doc", content });

describe("docLines", () => {
  it("turns each paragraph into a line", () => {
    const lines = docLines(
      doc([
        { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
        { type: "paragraph", content: [{ type: "text", text: "第二段" }] },
      ]),
    );
    expect(lines).toEqual(["第一段", "第二段"]);
  });

  it("keeps list items on their own line with a marker", () => {
    const lines = docLines(
      doc([
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "一" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "二" }] }],
            },
          ],
        },
      ]),
    );
    expect(lines).toEqual(["  - 一", "  - 二"]);
  });

  it("splits a code block by its own newlines", () => {
    const lines = docLines(
      doc([
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const a = 1;\nconst b = 2;" }],
        },
      ]),
    );
    expect(lines).toEqual(["const a = 1;", "const b = 2;"]);
  });

  it("describes an image by its alt text", () => {
    const lines = docLines(
      doc([{ type: "image", attrs: { src: "assets/a.png", alt: "架构图" } }]),
    );
    expect(lines).toEqual(["[图片] 架构图"]);
  });

  it("returns an empty list for a missing document", () => {
    expect(docLines(null)).toEqual([]);
    expect(docText({ type: "doc" })).toBe("");
  });
});