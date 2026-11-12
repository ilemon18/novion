import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/lib/tauri";
import { canHostChildren, parentForNewNode, parentForNewNodeFrom } from "./tree-targets";

function node(id: string, over: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    kind: "doc",
    name: id,
    parentId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function folder(id: string, over: Partial<TreeNode> = {}): TreeNode {
  return node(id, { kind: "folder", ...over });
}

function index(...list: TreeNode[]): Record<string, TreeNode> {
  return Object.fromEntries(list.map((n) => [n.id, n]));
}

describe("parentForNewNode", () => {
  it("creates at the root when nothing is selected", () => {
    expect(parentForNewNode(index(), null)).toBeNull();
    expect(parentForNewNode(index(), "missing")).toBeNull();
  });

  it("uses a selected folder", () => {
    const nodes = index(folder("f_a"));
    expect(parentForNewNode(nodes, "f_a")).toBe("f_a");
  });

  it("puts a new document next to the selected document", () => {
    const nodes = index(folder("f_a"), node("d_a", { parentId: "f_a" }));
    expect(parentForNewNode(nodes, "d_a")).toBe("f_a");
  });

  it("returns the root for a document that lives at the top level", () => {
    const nodes = index(node("d_a"));
    expect(parentForNewNode(nodes, "d_a")).toBeNull();
  });

  it("refuses the system groups and everything inside them", () => {
    const nodes = index(
      folder("f_trash", { builtin: "trash" }),
      node("d_trashed", { parentId: "f_trash", trashedAt: 1 }),
      node("d_archived", { completedAt: 1 }),
      folder("f_archived", { completedAt: 1 }),
      node("d_in_archived", { parentId: "f_archived" }),
    );
    expect(parentForNewNode(nodes, "f_trash")).toBeNull();
    expect(parentForNewNode(nodes, "d_trashed")).toBeNull();
    expect(parentForNewNode(nodes, "d_archived")).toBeNull();
    expect(parentForNewNode(nodes, "f_archived")).toBeNull();
    expect(parentForNewNode(nodes, "d_in_archived")).toBeNull();
  });
});

describe("parentForNewNodeFrom", () => {
  it("targets the row itself, not the selection", () => {
    const nodes = index(
      folder("f_a"),
      folder("f_b", { parentId: "f_a" }),
      node("d_a", { parentId: "f_a" }),
    );
    expect(parentForNewNodeFrom(nodes, nodes.f_b)).toBe("f_b");
    expect(parentForNewNodeFrom(nodes, nodes.d_a)).toBe("f_a");
    expect(parentForNewNodeFrom(nodes, null)).toBeNull();
  });
});

describe("canHostChildren", () => {
  it("accepts plain folders only", () => {
    const nodes = index(folder("f_a"), node("d_a"), folder("f_b", { parentId: "d_a" }));
    expect(canHostChildren(nodes, "f_a")).toBe(true);
    expect(canHostChildren(nodes, "d_a")).toBe(false);
    expect(canHostChildren(nodes, "nope")).toBe(false);
    expect(canHostChildren(nodes, null)).toBe(false);
  });
});