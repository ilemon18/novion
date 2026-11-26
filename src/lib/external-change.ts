import type { SaveStatus } from "@/lib/save-scheduler";

export type ExternalChangeAction = "reload" | "banner" | "defer";

interface ExternalChangeInput {
  /** sharing this workspace, or connected to a host */
  shared: boolean;
  saveStatus: SaveStatus;
  /** the title field owns unsaved text while it has focus */
  titleEditing: boolean;
  /** a rename timer is pending, or its write is still in flight */
  renamePending: boolean;
}

/**
 * Decide what an mtime change on the open document means.
 *
 * In shared mode a clean document can be replaced in place: another computer
 * saved it and the user has nothing to lose. With local edits we leave the
 * editor alone so the normal save/conflict path decides what happens. Outside
 * shared mode the old, explicit reload banner is still the right behaviour.
 */
export function decideExternalChange({
  shared,
  saveStatus,
  titleEditing,
  renamePending,
}: ExternalChangeInput): ExternalChangeAction {
  // Both guards cover edits that live outside the body save queue.
  if (titleEditing || renamePending) return "defer";
  if (saveStatus !== "idle" && saveStatus !== "saved") return "defer";
  return shared ? "reload" : "banner";
}
