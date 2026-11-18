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

describe("White palette migration", () => {
  it("uses White for a new profile and records the migration version", async () => {
    const storage = memoryStorage();
    const { useUi } = await loadUi(storage);

    expect(useUi.getState().palette).toBe("white");
    expect(storage.getItem("novion:palette")).toBe("white");
    expect(storage.getItem("novion:palette-version")).toBe("1");
  });

  it("keeps a persisted palette when the migration version already exists", async () => {
    const storage = memoryStorage({
      "novion:palette": "paper",
      "novion:palette-version": "1",
    });
    const { useUi } = await loadUi(storage);

    expect(useUi.getState().palette).toBe("paper");
    expect(storage.getItem("novion:palette")).toBe("paper");
  });

  it("migrates an old Paper preference to White exactly once", async () => {
    const storage = memoryStorage({ "novion:palette": "paper" });
    const { useUi } = await loadUi(storage);

    expect(useUi.getState().palette).toBe("white");
    expect(storage.getItem("novion:palette")).toBe("white");
    expect(storage.getItem("novion:palette-version")).toBe("1");
  });

  it("respects Paper after the user chooses it post-migration", async () => {
    const storage = memoryStorage({ "novion:palette": "paper" });
    const first = await loadUi(storage);

    expect(first.useUi.getState().palette).toBe("white");
    first.useUi.getState().setPalette("paper");
    expect(first.readPalettePreference(storage)).toBe("paper");

    vi.resetModules();
    const second = await import("./ui");
    expect(second.useUi.getState().palette).toBe("paper");
    expect(storage.getItem("novion:palette-version")).toBe("1");
  });

  it("applies White in light and dark mode without Paper leaking through", async () => {
    const storage = memoryStorage();
    const { applyTheme } = await loadUi(storage);

    applyTheme("light", "white");
    expect(root.dataset.palette).toBe("white");
    expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", false);
    expect(root.style.colorScheme).toBe("light");

    applyTheme("dark", "white");
    expect(root.dataset.palette).toBe("white");
    expect(root.classList.toggle).toHaveBeenLastCalledWith("dark", true);
    expect(root.style.colorScheme).toBe("dark");
  });
});
