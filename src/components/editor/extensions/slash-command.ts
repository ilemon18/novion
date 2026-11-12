import { Extension } from "@tiptap/react";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { filterSlashItems, type SlashItem } from "../slash-items";
import { useSlash } from "../slash-store";

type Props = {
  editor: unknown;
  range: unknown;
  query: string;
  items: SlashItem[];
  command: (item: SlashItem) => void;
  clientRect?: (() => DOMRect | null) | null;
};

function anchorOf(props: Props) {
  const rect = props.clientRect?.();
  if (!rect) return { left: 240, top: 120, bottom: 140 };
  return { left: rect.left, top: rect.top, bottom: rect.bottom };
}

export const SlashCommand = Extension.create({
  name: "slashCommand",

  addOptions() {
    return { hidden: [] as string[] };
  },

  addProseMirrorPlugins() {
    const hidden = this.options.hidden;
    const suggestion: Omit<SuggestionOptions<SlashItem>, "editor"> = {
      // ProseMirror refuses two plugins that share a key, and every `Suggestion`
      // defaults to `suggestion` — the `/` menu and the `[[` picker must not
      // collide or the whole editor fails to build.
      pluginKey: new PluginKey("novionSlashCommand"),
      char: "/",
      startOfLine: false,
      allowSpaces: false,
      items: ({ query }) => filterSlashItems(query, hidden),
      command: ({ editor, range, props }) => {
        (props as SlashItem).run({
          editor: editor as never,
          range: range as never,
        });
      },
      render: () => ({
        onStart: (props) => {
          const p = props as unknown as Props;
          useSlash.getState().show(p.items, anchorOf(p), (item) => p.command(item));
        },
        onUpdate: (props) => {
          const p = props as unknown as Props;
          useSlash.getState().show(p.items, anchorOf(p), (item) => p.command(item));
        },
        onKeyDown: ({ event }) => {
          const store = useSlash.getState();
          if (!store.open) return false;
          const count = store.items.length;
          if (event.key === "ArrowDown") {
            if (count) store.setIndex((store.index + 1) % count);
            return true;
          }
          if (event.key === "ArrowUp") {
            if (count) store.setIndex((store.index - 1 + count) % count);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            if (count) store.pick();
            return true;
          }
          if (event.key === "Escape") {
            store.hide();
            return true;
          }
          return false;
        },
        onExit: () => {
          useSlash.getState().hide();
        },
      }),
    };

    return [Suggestion({ editor: this.editor, ...suggestion })];
  },
});