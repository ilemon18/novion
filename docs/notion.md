# Notion mirror

Novion pushes the active workspace to a page in Notion. The mirror is
**one-way**: Novion is authoritative and edits made only in Notion are ignored
(or overwritten by a force push).

## What is mirrored

- Every folder becomes a Notion page nested under its local parent.
- Every note becomes a child page whose body is converted from Novion blocks.
- Notes in **已归档** are placed in a matching folder page.
- Notes in **回收站** are removed from Notion (moved to the Notion trash).
- If a note or folder is deleted permanently in Novion, its mapped Notion page
  is moved to the Notion trash and the mapping is forgotten.

Pages that are created directly in Notion and are not tracked by Novion are
left alone.

## Sync target recovery

The page chosen in **Settings → Notion → Sync target** is the root of the
mirror. Before a push starts, Novion makes sure the target and its accessible
ancestors are usable:

1. If the target (or an ancestor) is active, the push continues normally.
2. If it is in the Notion trash, Novion tries to restore it and the trashed
   ancestors.
3. If restoring is impossible — for example the integration only has Insert
   permission, the page was permanently deleted, or a database/block ancestor is
   trashed — Novion creates a replacement page and pushes the whole workspace
   to it:
   - first under the original parent page (remembered when the target was
     chosen),
   - then under the nearest writable parent of the current target,
   - finally as a top-level page in the Notion workspace.

When the target is re-created, the old page mapping is cleared and the run is a
full push. The completion notice records the new page and its link. The old
tree stays in the Notion trash; do not restore it after a rebuild or the
workspace will have two copies.

If all fallbacks fail, the push reports that the target could not be restored
or re-created. Restore the page and its parents in Notion, give the integration
**Update content** and **Insert content** permissions, or choose another target.

## Force push

**Force push** renames, moves, and rewrites every mapped page from Novion. Use
it when the Notion copy was edited or rearranged by hand and must be reset to
the local workspace. It is slower than a normal push because every page body is
cleared and written again, and Notion limits requests to roughly three per
second.

A normal push is incremental: unchanged notes are verified without rewriting
their bodies.

## Notion API limits

- Notion has no permanent-delete endpoint. "Delete" in Novion means "move the
  page to the Notion trash".
- Restoring a page requires the integration to be able to update content.
  Creating a replacement page requires Insert content permission.
- Creating a top-level replacement page requires an internal Notion
  integration with Insert content permission.
- Very large workspaces or images may need several runs because of rate
  limiting.
