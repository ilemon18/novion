import type { Editor } from "@tiptap/react";
import { api, assetUrl, fileToBase64 } from "@/lib/tauri";

/**
 * Asset pipeline: bytes travel to Rust as base64, land in
 * ~/Documents/Novion/assets/<id>.<ext>, and the document keeps only the
 * relative path (`assets/x.png`) so the workspace stays portable.
 * At render time the relative path is expanded into an asset:// URL.
 */
export async function uploadImage(file: File | Blob, nameHint: string) {
  const base64 = await fileToBase64(file);
  const asset = await api.saveAsset(nameHint || "image.png", base64);
  return { rel: asset.rel, url: await assetUrl(asset.rel) };
}

export async function insertImageFiles(editor: Editor, files: File[], pos?: number) {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;

  for (const file of images) {
    const name = file.name || "image.png";
    try {
      const { url } = await uploadImage(file, name);
      // no description is written: the image is identified by its file only
      const node = { type: "image", attrs: { src: url, width: 100, caption: "" } };
      if (pos != null) {
        editor.chain().focus().insertContentAt(pos, node).run();
      } else {
        editor.chain().focus().setImage({ src: url }).run();
      }
    } catch (err) {
      console.error("[novion] image upload failed", name, err);
      throw err;
    }
  }
}

export function pickImage(editor: Editor) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (files.length) void insertImageFiles(editor, files);
  };
  input.click();
}