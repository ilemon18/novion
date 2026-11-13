import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  ChevronDown,
  TableCellsMerge,
  TableCellsSplit,
  Trash2,
} from "lucide-react";
import { useT } from "@/i18n";
import { Panel, PanelItem, type PanelControlProps } from "./parts";

/**
 * The table menu, drawn only while the caret is inside a table.
 *
 * Every entry asks `editor.can()` first: a control that is impossible right
 * now (merge with a single cell, a row delete on the header) is disabled
 * instead of failing silently when clicked.
 */
export function TableActions({ editor, open, onToggle, onClose }: PanelControlProps) {
  const t = useT();
  const run = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div className="relative">
      <button
        type="button"
        title={t("Table actions")}
        aria-label={t("Table actions")}
        onClick={onToggle}
        className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <TableCellsMerge className="size-3.5" />
        {t("Table")}
        <ChevronDown className="size-3 opacity-60" />
      </button>
      {open && (
        <Panel align="end" width={176}>
          <PanelItem
            disabled={!editor.can().addRowBefore()}
            onClick={() => run(() => editor.chain().focus().addRowBefore().run())}
          >
            <ArrowUpToLine className="size-3.5" />
            {t("Insert row above")}
          </PanelItem>
          <PanelItem
            disabled={!editor.can().addRowAfter()}
            onClick={() => run(() => editor.chain().focus().addRowAfter().run())}
          >
            <ArrowDownToLine className="size-3.5" />
            {t("Insert row below")}
          </PanelItem>
          <PanelItem
            disabled={!editor.can().addColumnBefore()}
            onClick={() => run(() => editor.chain().focus().addColumnBefore().run())}
          >
            <ArrowLeftToLine className="size-3.5" />
            {t("Insert column left")}
          </PanelItem>
          <PanelItem
            disabled={!editor.can().addColumnAfter()}
            onClick={() => run(() => editor.chain().focus().addColumnAfter().run())}
          >
            <ArrowRightToLine className="size-3.5" />
            {t("Insert column right")}
          </PanelItem>
          <div className="my-1 h-px bg-border" />
          <PanelItem
            disabled={!editor.can().mergeCells()}
            onClick={() => run(() => editor.chain().focus().mergeCells().run())}
          >
            <TableCellsMerge className="size-3.5" />
            {t("Merge cells")}
          </PanelItem>
          <PanelItem
            disabled={!editor.can().splitCell()}
            onClick={() => run(() => editor.chain().focus().splitCell().run())}
          >
            <TableCellsSplit className="size-3.5" />
            {t("Split cell")}
          </PanelItem>
          <PanelItem onClick={() => run(() => editor.chain().focus().toggleHeaderRow().run())}>
            {t("Toggle header row")}
          </PanelItem>
          <div className="my-1 h-px bg-border" />
          <PanelItem onClick={() => run(() => editor.chain().focus().deleteRow().run())}>
            <Trash2 className="size-3.5" />
            {t("Delete row")}
          </PanelItem>
          <PanelItem onClick={() => run(() => editor.chain().focus().deleteColumn().run())}>
            <Trash2 className="size-3.5" />
            {t("Delete column")}
          </PanelItem>
          <PanelItem destructive onClick={() => run(() => editor.chain().focus().deleteTable().run())}>
            <Trash2 className="size-3.5" />
            {t("Delete table")}
          </PanelItem>
        </Panel>
      )}
    </div>
  );
}
