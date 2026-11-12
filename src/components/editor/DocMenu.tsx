import { useState } from "react";
import { Archive, FileDown, FileText, History, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { exportDoc } from "@/lib/export-actions";
import { useUi } from "@/store/ui";
import { useT } from "@/i18n";
import { DocActionButton } from "./DocAction";

/** Per-document actions that are too rare for a permanent button. */
export function DocMenu({ docId }: { docId: string }) {
  const t = useT();
  const openHistory = useUi((s) => s.openHistory);
  const historyEnabled = useUi((s) => s.features.history);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      {/* the tooltip has to be controlled: it would otherwise stay visible
          underneath the open menu, since the pointer never leaves the button */}
      <Tooltip open={tipOpen && !menuOpen} onOpenChange={setTipOpen}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <DocActionButton aria-label={t("More actions")} aria-haspopup="menu">
              <MoreHorizontal className="size-4" strokeWidth={1.7} />
            </DocActionButton>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("More actions")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent className="min-w-48">
        <DropdownMenuItem onSelect={() => void exportDoc(docId, "md")}>
          <FileDown />
          {t("Export as Markdown")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportDoc(docId, "html")}>
          <FileText />
          {t("Export as HTML")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportDoc(docId, "json")}>
          <Archive />
          {t("Export as JSON")}
        </DropdownMenuItem>
        {historyEnabled && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openHistory(docId)}>
              <History />
              {t("Version history…")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
