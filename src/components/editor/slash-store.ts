import { create } from "zustand";
import type { SlashItem } from "./slash-items";

interface Anchor {
  left: number;
  top: number;
  bottom: number;
}

/** Latest suggestion payload, kept outside React so keystrokes stay cheap. */
let activeCommand: ((item: SlashItem) => void) | null = null;

export interface SlashState {
  open: boolean;
  items: SlashItem[];
  index: number;
  anchor: Anchor;
  /** header of the popup: "基础块" for `/`, "链接到文档" for `[[` */
  label: string;
  show: (
    items: SlashItem[],
    anchor: Anchor,
    command: (i: SlashItem) => void,
    label?: string,
  ) => void;
  hide: () => void;
  setIndex: (i: number) => void;
  pick: (i?: number) => void;
}

export const useSlash = create<SlashState>((set, get) => ({
  open: false,
  items: [],
  index: 0,
  anchor: { left: 0, top: 0, bottom: 0 },
  // empty = "basic blocks"; translated where the menu renders it
  label: "",

  show: (items, anchor, command, label) => {
    activeCommand = command;
    const prev = get();
    set({
      open: true,
      items,
      anchor,
      label: label ?? "",
      index: prev.open ? Math.min(prev.index, Math.max(0, items.length - 1)) : 0,
    });
  },

  hide: () => {
    activeCommand = null;
    set({ open: false, items: [], index: 0, label: "基础块" });
  },

  setIndex: (index) => set({ index }),

  pick: (i) => {
    const { items, index } = get();
    const item = items[i ?? index];
    if (!item || !activeCommand) return;
    const cmd = activeCommand;
    get().hide();
    cmd(item);
  },
}));