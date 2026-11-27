import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, value),
  };
}

function browserRoot() {
  return {
    dataset: {} as Record<string, string>,
    classList: { toggle: vi.fn() },
    style: { colorScheme: "", setProperty: vi.fn() },
    lang: "",
  };
}

async function loadUi(storage: Storage) {
  vi.stubGlobal("localStorage", storage);
  vi.resetModules();
  return import("./ui");
}

let root: ReturnType<typeof browserRoot>;

beforeEach(() => {
  vi.resetModules();
  root = browserRoot();
  vi.stubGlobal("document", { documentElement: root });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Novion Paper theme", () => {
  it("defaults to system mode and removes legacy palette keys", async () => {
    const storage = memoryStorage({
      "novion:palette": "paper",
      "novion:palette-version": "1",
    });
    const { useUi } = await loadUi(storage);

    expect(useUi.getState().theme).toBe("system");
    expect("palette" in useUi.getState()).toBe(false);
    expect(storage.getItem("novion:palette")).toBeNull();
    expect(storage.getItem("novion:palette-version")).toBeNull();
  });

  it("persists the chosen display mode across reloads", async () => {
    const storage = memoryStorage();
    const first = await loadUi(storage);

    first.useUi.getState().setTheme("dark");
    expect(storage.getItem("novion:theme")).toBe("dark");

    vi.resetModules();
    const second = await import("./ui");
    expect(second.useUi.getState().theme).toBe("dark");
  });

  it("applies light and dark mode without writing a palette", async () => {
    const storage = memoryStorage();
    const { applyTheme } = await loadUi(storage);

    applyTheme("light");
    expect(root.dataset.palette).toBeUndefined();
    expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", false);
    expect(root.style.colorScheme).toBe("light");

    applyTheme("dark");
    expect(root.dataset.palette).toBeUndefined();
    expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", true);
    expect(root.style.colorScheme).toBe("dark");
  });

  it("clears a data-palette attribute left by an older build", async () => {
    const storage = memoryStorage();
    const { applyTheme } = await loadUi(storage);

    root.dataset.palette = "catppuccin";
    applyTheme("light");

    expect(root.dataset.palette).toBeUndefined();
  });
});
