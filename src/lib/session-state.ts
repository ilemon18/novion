/**
 * Where the user left off, remembered per workspace root.
 *
 * The tree itself already remembers which folders were folded away (see
 * `folder-state.ts`); this is the rest of the scene — the document that was in
 * the editor, how far the sidebar tree was scrolled, and which system sections
 * (存档 / 回收站) were unfolded. Opening the app again therefore lands on the
 * same page instead of on "whatever document happens to be first".
 *
 * Same rules as the folder memory: it lives in localStorage next to the other
 * view preferences and never touches `workspace.json`. Anything unreadable is
 * treated as "nothing remembered", so a corrupt value can never keep the app
 * from starting.
 */
const KEY_PREFIX = "novion:session:";

/** The slice of `Storage` we need — tests pass a plain object. */
export type PreferenceStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface SessionMemory {
  /** document that was open in the editor, `null` = never opened one */
  docId: string | null;
  /** pixel offset of the sidebar tree, so the last row is where the user left it */
  treeScrollTop: number;
  /** the two collapsible system sections at the bottom of the sidebar */
  sections: { completed: boolean; trash: boolean };
}

export const EMPTY_SESSION: SessionMemory = {
  docId: null,
  treeScrollTop: 0,
  sections: { completed: false, trash: false },
};

const keyFor = (rootPath: string) => KEY_PREFIX + (rootPath || "default");

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Scroll offsets are pixels: negative, fractional and absurd values are dropped. */
function readScroll(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/**
 * The remembered scene for `rootPath`. Ids are *not* checked against the tree
 * here: the caller knows the live nodes and decides whether the document still
 * exists (and is still in the live tree), exactly like the collapsed-folder
 * memory prunes itself.
 */
export function readSession(store: PreferenceStore, rootPath: string): SessionMemory {
  let raw: string | null;
  try {
    raw = store.getItem(keyFor(rootPath));
  } catch {
    return EMPTY_SESSION;
  }
  if (!raw) return EMPTY_SESSION;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_SESSION;
  }
  if (!isObject(parsed)) return EMPTY_SESSION;

  const sections = isObject(parsed.sections) ? parsed.sections : {};
  return {
    docId: typeof parsed.docId === "string" && parsed.docId ? parsed.docId : null,
    treeScrollTop: readScroll(parsed.treeScrollTop),
    sections: {
      completed: sections.completed === true,
      trash: sections.trash === true,
    },
  };
}

/** True when nothing worth remembering is left (the key can go). */
function isEmpty(memory: SessionMemory): boolean {
  return (
    !memory.docId &&
    memory.treeScrollTop <= 0 &&
    !memory.sections.completed &&
    !memory.sections.trash
  );
}

/** Writes the whole scene; an empty one clears the key again. */
export function writeSession(
  store: PreferenceStore,
  rootPath: string,
  memory: SessionMemory,
): void {
  try {
    if (isEmpty(memory)) store.removeItem(keyFor(rootPath));
    else store.setItem(keyFor(rootPath), JSON.stringify(memory));
  } catch {
    // A full or unavailable localStorage must never break the sidebar.
  }
}
