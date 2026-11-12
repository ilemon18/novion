import Image from "@tiptap/extension-image";
import { t } from "@/i18n";

/**
 * Image block with a width and a caption.
 *
 * Both live on the node as attributes, so they survive save / reload / export
 * without any side table. The node view adds the controls; the document model
 * stays a plain `image` node, which is also what Markdown and Notion export
 * already understand.
 *
 * There are two variants of the same schema: `ResizableImage` adds the resize
 * handles and the caption editor, `PlainImage` renders only the `<img>`. The
 * settings switch chooses one at editor construction; both parse and save the
 * same attributes, so turning the controls off never strips data.
 */
export const PlainImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      /** rendered width in percent of the text column */
      width: {
        default: 100,
        parseHTML: (element: HTMLElement) => {
          const value = Number(element.getAttribute("data-width"));
          return Number.isFinite(value) && value > 0 ? value : 100;
        },
        renderHTML: (attributes: Record<string, unknown>) => {
          const width = Number(attributes.width);
          if (!Number.isFinite(width) || width >= 100) return {};
          return { "data-width": String(width), style: `width:${width}%` };
        },
      },
      caption: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-caption") ?? "",
        renderHTML: (attributes: Record<string, unknown>) => {
          const caption = String(attributes.caption ?? "");
          return caption ? { "data-caption": caption } : {};
        },
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", HTMLAttributes];
  },
});

/** Same node, plus the interactive width/caption controls. */
export const ResizableImage = PlainImage.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;

      const dom = document.createElement("div");
      dom.className = "image-node";
      dom.dataset.width = String(Number(current.attrs.width) || 100);

      const frame = document.createElement("div");
      frame.className = "image-frame";

      const img = document.createElement("img");
      img.draggable = false;
      img.loading = "lazy";
      img.decoding = "async";

      const handle = document.createElement("span");
      handle.className = "image-resize";
      handle.setAttribute("aria-hidden", "true");

      const tools = document.createElement("div");
      tools.className = "image-tools";
      tools.contentEditable = "false";

      const commit = (patch: Record<string, unknown>) => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null) return;
        const attrs = { ...current.attrs, ...patch };
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, attrs),
        );
      };

      const sizeButtons: HTMLButtonElement[] = [];
      for (const size of [25, 50, 75, 100]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${size}%`;
        button.title = t("Width {size}%", { size });
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => commit({ width: size }));
        sizeButtons.push(button);
        tools.appendChild(button);
      }

      const spacer = document.createElement("span");
      spacer.className = "image-tools-gap";
      tools.appendChild(spacer);

      const captionButton = document.createElement("button");
      captionButton.type = "button";
      captionButton.textContent = t("Caption");
      captionButton.title = t("Show a caption below the image");

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.textContent = t("Delete");
      removeButton.className = "is-danger";
      removeButton.title = t("Delete image");

      for (const button of [captionButton, removeButton]) {
        button.addEventListener("mousedown", (event) => event.preventDefault());
        tools.append(button);
      }

      const editorRow = document.createElement("div");
      editorRow.className = "image-edit-row";
      editorRow.contentEditable = "false";

      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      editorRow.appendChild(input);

      let editing = false;

      const closeEditor = () => {
        editing = false;
        editorRow.dataset.open = "false";
        dom.dataset.selected = "false";
      };

      const openEditor = () => {
        editing = true;
        dom.dataset.selected = "true";
        editorRow.dataset.open = "true";
        input.placeholder = t("Caption shown below the image");
        input.value = String(current.attrs.caption ?? "");
        window.requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
      };

      const commitEditor = () => {
        if (!editing) return;
        const value = input.value.trim();
        commit({ caption: value });
        closeEditor();
      };

      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commitEditor();
        } else if (event.key === "Escape") {
          event.preventDefault();
          closeEditor();
        }
        event.stopPropagation();
      });
      input.addEventListener("blur", () => {
        if (editing) commitEditor();
      });
      input.addEventListener("mousedown", (event) => event.stopPropagation());

      captionButton.addEventListener("click", () =>
        editing ? closeEditor() : openEditor(),
      );
      removeButton.addEventListener("click", () => {
        const pos = typeof getPos === "function" ? getPos() : null;
        if (pos == null) return;
        editor.view.dispatch(
          editor.view.state.tr.delete(pos, pos + current.nodeSize),
        );
      });

      const caption = document.createElement("div");
      caption.className = "image-caption";

      // the toolbar lives inside the frame so it always sits on the image's
      // own top-right corner, not on the far edge of the text column
      frame.append(img, handle, tools);
      dom.append(frame, caption, editorRow);

      /**
       * Pointer resize from the bottom-right corner.
       *
       * Pointer events arrive faster than frames (120 Hz on ProMotion), and
       * each write changes the layout of everything below the image. Updates
       * are therefore coalesced into one write per animation frame, and only
       * when the rounded percentage actually changed.
       */
      let pointerId = -1;
      let startX = 0;
      let startWidth = 100;
      let boxWidth = 1;
      let pendingX = 0;
      let applied = 100;
      let raf = 0;

      const paint = () => {
        raf = 0;
        const delta = ((pendingX - startX) / boxWidth) * 100;
        const next = Math.round(Math.min(100, Math.max(20, startWidth + delta)));
        if (next === applied) return;
        applied = next;
        dom.style.setProperty("--image-width", `${next}%`);
      };

      const onMove = (event: PointerEvent) => {
        pendingX = event.clientX;
        if (raf) return;
        raf = requestAnimationFrame(paint);
      };

      const stopDrag = () => {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", stopDrag);
        handle.removeEventListener("pointercancel", stopDrag);
        try {
          handle.releasePointerCapture?.(pointerId);
        } catch {
          /* the pointer may already be gone */
        }
        dom.classList.remove("is-resizing");
        document.body.classList.remove("is-resizing-image");
        // a click that never moved must not add an undo step
        if (applied !== startWidth) commit({ width: applied });
      };

      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        pointerId = event.pointerId;
        startX = event.clientX;
        pendingX = event.clientX;
        startWidth = Number(dom.dataset.width) || 100;
        applied = startWidth;
        boxWidth = frame.getBoundingClientRect().width / (startWidth / 100) || 1;
        handle.setPointerCapture?.(event.pointerId);
        // the toolbar is anchored to the moving edge, so it is hidden for the
        // duration instead of chasing the pointer
        dom.classList.add("is-resizing");
        document.body.classList.add("is-resizing-image");
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", stopDrag);
        handle.addEventListener("pointercancel", stopDrag);
      });

      const sync = () => {
        const src = String(current.attrs.src ?? "");
        if (img.getAttribute("src") !== src) img.src = src;
        const alt = String(current.attrs.alt ?? "");
        img.alt = alt;
        if (img.getAttribute("title") !== alt) img.title = alt;
        const width = Number(current.attrs.width) || 100;
        dom.dataset.width = String(width);
        dom.style.setProperty("--image-width", `${width}%`);
        const text = String(current.attrs.caption ?? "");
        caption.textContent = text;
        caption.dataset.open = text ? "true" : "false";
        for (const button of sizeButtons) {
          button.dataset.active = Number(button.textContent?.replace("%", "")) === width
            ? "true"
            : "false";
        }
      };
      sync();

      return {
        dom,
        update: (updated) => {
          if (updated.type !== current.type) return false;
          current = updated;
          sync();
          return true;
        },
        destroy: () => {
          // a document switch in the middle of a drag must not leave the
          // global resize cursor / selection lock behind
          document.body.classList.remove("is-resizing-image");
        },
        selectNode: () => {
          dom.dataset.selected = "true";
        },
        deselectNode: () => {
          if (!editing) dom.dataset.selected = "false";
        },
        stopEvent: (event) => {
          const target = event.target as globalThis.Node | null;
          if (!target) return false;
          // the toolbar is now inside the frame; clicks there are ours
          return tools.contains(target) || editorRow.contains(target);
        },
        ignoreMutation: () => true,
      };
    };
  },
});