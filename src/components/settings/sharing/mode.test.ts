import { describe, expect, it } from "vitest";
import { sharingModeState } from "./mode";

describe("sharingModeState", () => {
  it("allows both roles when idle", () => {
    expect(sharingModeState(false, false)).toEqual({
      hostBlocked: false,
      clientBlocked: false,
      conflict: false,
    });
  });

  it("blocks connecting while sharing", () => {
    expect(sharingModeState(true, false)).toEqual({
      hostBlocked: false,
      clientBlocked: true,
      conflict: false,
    });
  });

  it("blocks sharing while connected", () => {
    expect(sharingModeState(false, true)).toEqual({
      hostBlocked: true,
      clientBlocked: false,
      conflict: false,
    });
  });

  it("flags a legacy dual-active state", () => {
    expect(sharingModeState(true, true)).toEqual({
      hostBlocked: false,
      clientBlocked: false,
      conflict: true,
    });
  });
});
