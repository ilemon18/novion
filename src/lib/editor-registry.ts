import type { Editor } from "@tiptap/react";

/**
 * The editor instance of the open document.
 *
 * Commands in the palette are plain functions over stores, so they cannot take
 * the editor as a prop the way a component can. One document is open at a
 * time, which makes a single slot the honest shape here.
 */
let active: Editor | null = null;

export function setActiveEditor(editor: Editor | null): void {
  active = editor;
}

export function getActiveEditor(): Editor | null {
  return active;
}