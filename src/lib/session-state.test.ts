import { describe, expect, it } from "vitest";
import {
  EMPTY_SESSION,
  readSession,
  writeSession,
  type PreferenceStore,
  type SessionMemory,
} from "./session-state";

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

const memory = (over: Partial<SessionMemory> = {}): SessionMemory => ({
  docId: "d_1",
  treeScrollTop: 120,
  sections: { completed: false, trash: true },
  ...over,
});

describe("session memory", () => {
  it("round-trips the whole scene", () => {
    const store = fakeStore();
    writeSession(store, "/docs/Novion", memory());
    expect(readSession(store, "/docs/Novion")).toEqual(memory());
  });

  it("keeps one scene per workspace root", () => {
    const store = fakeStore();
    writeSession(store, "/one", memory());
    expect(readSession(store, "/two")).toEqual(EMPTY_SESSION);
  });

  it("clears the key when nothing is worth remembering", () => {
    const store = fakeStore();
    writeSession(store, "/one", memory());
    writeSession(store, "/one", EMPTY_SESSION);
    expect(store.data.size).toBe(0);
  });

  it("drops absurd scroll offsets instead of restoring them", () => {
    const store = fakeStore({
      "novion:session:/one": JSON.stringify({ treeScrollTop: -400 }),
    });
    expect(readSession(store, "/one").treeScrollTop).toBe(0);
    store.setItem("novion:session:/one", JSON.stringify({ treeScrollTop: 12.6 }));
    expect(readSession(store, "/one").treeScrollTop).toBe(13);
  });

  it("treats a corrupt or foreign value as 'nothing remembered'", () => {
    for (const raw of [
      "{not json",
      "null",
      "[]",
      '"d_1"',
      JSON.stringify({ docId: 42, treeScrollTop: "900", sections: "trash" }),
    ]) {
      const store = fakeStore({ "novion:session:/one": raw });
      expect(readSession(store, "/one")).toEqual(EMPTY_SESSION);
    }
  });

  it("survives a store that refuses to write", () => {
    const store: PreferenceStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeSession(store, "/one", memory())).not.toThrow();
    expect(() => writeSession(store, "/one", EMPTY_SESSION)).not.toThrow();
  });
});
