import { describe, expect, it } from "vitest";
import { decideExternalChange } from "./external-change";

const base = {
  shared: true,
  saveStatus: "saved" as const,
  titleEditing: false,
  renamePending: false,
};

describe("external document changes", () => {
  it("reloads a clean document in shared mode", () => {
    expect(decideExternalChange(base)).toBe("reload");
    expect(decideExternalChange({ ...base, saveStatus: "idle" })).toBe("reload");
  });

  it("keeps the banner for clean local documents", () => {
    expect(decideExternalChange({ ...base, shared: false })).toBe("banner");
  });

  it("defers while the body has unsaved writes", () => {
    for (const saveStatus of ["dirty", "saving", "error"] as const) {
      expect(decideExternalChange({ ...base, saveStatus })).toBe("defer");
      expect(decideExternalChange({ ...base, shared: false, saveStatus })).toBe("defer");
    }
  });

  it("defers while the title is being edited", () => {
    expect(decideExternalChange({ ...base, titleEditing: true })).toBe("defer");
  });

  it("defers while a rename is pending or in flight", () => {
    expect(decideExternalChange({ ...base, renamePending: true })).toBe("defer");
  });
});
