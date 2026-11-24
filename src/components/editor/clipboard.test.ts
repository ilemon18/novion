import { Fragment, Schema, type Node as PMNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { fragmentToText } from "./clipboard";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    heading: { group: "block", content: "inline*" },
    text: { group: "inline" },
    hardBreak: { group: "inline", inline: true },
    codeBlock: { group: "block", content: "text*", code: true },
    bulletList: { group: "block", content: "listItem+" },
    orderedList: {
      group: "block",
      content: "listItem+",
      attrs: { start: { default: 1 } },
    },
    listItem: { content: "paragraph block*" },
    taskList: { group: "block", content: "taskItem+" },
    taskItem: {
      content: "paragraph block*",
      attrs: { checked: { default: false } },
    },
    image: { group: "block", attrs: { alt: { default: "" } } },
  },
});

const paragraph = (text = "") =>
  schema.node("paragraph", null, text ? schema.text(text) : undefined);
const item = (text: string, children: PMNode[] = []) =>
  schema.node("listItem", null, [paragraph(text), ...children]);
const bullets = (...items: PMNode[]) => schema.node("bulletList", null, items);

describe("fragmentToText", () => {
  const cases: [string, PMNode[], string][] = [
    [
      "joins consecutive paragraphs with a single newline",
      [paragraph("第一行"), paragraph("第二行"), paragraph("第三行")],
      "第一行\n第二行\n第三行",
    ],
    [
      "preserves an explicit empty paragraph",
      [paragraph("第一行"), paragraph(), paragraph("第二行")],
      "第一行\n\n第二行",
    ],
    [
      "preserves multiple empty paragraphs and empty selection boundaries",
      [
        paragraph(),
        paragraph("第一行"),
        paragraph(),
        paragraph(),
        paragraph("第二行"),
        paragraph(),
      ],
      "\n第一行\n\n\n第二行\n",
    ],
    [
      "preserves inline hard breaks",
      [
        schema.node("paragraph", null, [
          schema.text("第一行"),
          schema.node("hardBreak"),
          schema.node("hardBreak"),
          schema.text("第二行"),
        ]),
        paragraph("第三行"),
      ],
      "第一行\n\n第二行\n第三行",
    ],
    [
      "preserves blank lines inside code blocks",
      [
        paragraph("代码"),
        schema.node("codeBlock", null, schema.text("first()\n\nsecond()")),
        paragraph("结束"),
      ],
      "代码\nfirst()\n\nsecond()\n结束",
    ],
    [
      "uses a single newline between headings, paragraphs and lists",
      [
        schema.node("heading", null, schema.text("标题")),
        paragraph("正文"),
        bullets(item("一"), item("二")),
        paragraph("结束"),
      ],
      "标题\n正文\n- 一\n- 二\n结束",
    ],
    [
      "preserves ordered list numbering and its starting number",
      [schema.node("orderedList", { start: 3 }, [item("一"), item("二")])],
      "3. 一\n4. 二",
    ],
    [
      "preserves task list check states",
      [
        schema.node("taskList", null, [
          schema.node("taskItem", { checked: false }, [paragraph("待办")]),
          schema.node("taskItem", { checked: true }, [paragraph("完成")]),
        ]),
      ],
      "- [ ] 待办\n- [x] 完成",
    ],
    [
      "preserves nested list indentation",
      [bullets(item("父项", [bullets(item("子项"))]), item("下一项"))],
      "- 父项\n  - 子项\n- 下一项",
    ],
    [
      "does not add a blank line for images without alternative text",
      [paragraph("第一行"), schema.node("image"), paragraph("第二行")],
      "第一行\n第二行",
    ],
    [
      "retains image alternative text on its own line",
      [
        paragraph("第一行"),
        schema.node("image", { alt: "图片描述" }),
        paragraph("第二行"),
      ],
      "第一行\n图片描述\n第二行",
    ],
  ];

  it.each(cases)("%s", (_name, nodes, expected) => {
    expect(fragmentToText(Fragment.fromArray(nodes))).toBe(expected);
  });

  it("serializes partial selections across paragraphs without an extra blank line", () => {
    const doc = schema.node("doc", null, [paragraph("abc"), paragraph("def")]);
    const slice = doc.slice(2, 8);

    expect(slice.openStart).toBe(1);
    expect(slice.openEnd).toBe(1);
    expect(fragmentToText(slice.content)).toBe("bc\nde");
  });

  it("serializes an empty fragment as empty text", () => {
    expect(fragmentToText(Fragment.empty)).toBe("");
  });
});
