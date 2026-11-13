import { describe, expect, it } from "vitest";
import type { TreeNode } from "@/lib/tauri";
import {
  readCollapsedFolders,
  saveCollapsedFolders,
  type PreferenceStore,
} from "./folder-state";

function node(id: string, over: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    kind: "folder",
    name: id,
    parentId: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** Minimal localStorage stand-in: one bucket per key, like the real one. */
function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const store: PreferenceStore & { data: Map<string, string> } = {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
  return store;
}

const index = (...nodes: TreeNode[]): Record<string, TreeNode> =>
  Object.fromEntries(nodes.map((n) => [n.id, n]));

describe("collapsed folder memory", () => {
  it("round-trips the closed subset of the tree", () => {
    const store = fakeStore();
    const nodes = index(node("f_a"), node("f_b"), node("f_c"));
    saveCollapsedFolders(store, "/docs/Novion", nodes, { f_a: true, f_b: false, f_c: false });
    expect([...readCollapsedFolders(store, "/docs/Novion", nodes)].sort()).toEqual(["f_b", "f_c"]);
  });

  it("keeps one entry per workspace root", () => {
    const store = fakeStore();
    const nodes = index(node("f_a"));
    saveCollapsedFolders(store, "/one", nodes, { f_a: false });
    expect(readCollapsedFolders(store, "/two", nodes).size).toBe(0);
  });

  it("clears the key when everything is open again", () => {
    const store = fakeStore();
    const nodes = index(node("f_a"));
    saveCollapsedFolders(store, "/one", nodes, { f_a: false });
    saveCollapsedFolders(store, "/one", nodes, { f_a: true });
    expect(store.data.size).toBe(0);
  });

  it("drops ids of folders that are gone", () => {
    const store = fakeStore();
    const nodes = index(node("f_a"));
    saveCollapsedFolders(store, "/one", nodes, { f_a: false, f_deleted: false });
    expect([...readCollapsedFolders(store, "/one", nodes)]).toEqual(["f_a"]);
  });

  it("never remembers the system groups", () => {
    const store = fakeStore();
    const nodes = index(node("f_a"), node("f_trash", { builtin: "trash", kind: "folder" }));
    saveCollapsedFolders(store, "/one", nodes, { f_a: true, f_trash: false });
    expect(readCollapsedFolders(store, "/one", nodes).size).toBe(0);
  });

  it("treats a corrupt or foreign value as 'nothing closed'", () => {
    const nodes = index(node("f_a"));
    for (const raw of ["{not json", '{"f_a":false}', "null", "[]"]) {
      const store = fakeStore({ "novion:collapsed-folders:/one": raw });
      expect(readCollapsedFolders(store, "/one", nodes).size).toBe(0);
    }
  });

  it("survives a store that refuses to write", () => {
    const nodes = index(node("f_a"));
    const store: PreferenceStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => saveCollapsedFolders(store, "/one", nodes, { f_a: false })).not.toThrow();
  });
});