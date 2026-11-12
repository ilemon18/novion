import {
  HardDrive,
  Info,
  NotebookPen,
  Settings2,
  SlidersHorizontal,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { useUi } from "@/store/ui";
import { GeneralSection } from "./GeneralSection";
import { EditorSection } from "./EditorSection";
import { AppearanceSection } from "./AppearanceSection";
import { StorageSection } from "./StorageSection";
import { NotionSection } from "./NotionSection";
import { AboutSection } from "./AboutSection";

export type SettingsSectionId =
  | "general"
  | "editor"
  | "appearance"
  | "storage"
  | "notion"
  | "about";

interface SectionDef {
  id: SettingsSectionId;
  /** English source text, translated when rendered */
  label: string;
  icon: LucideIcon;
  component: () => JSX.Element;
}

/**
 * Registry of settings pages. Adding a feature = adding one entry here plus a
 * section component; the dialog shell never needs to know about it.
 */
export const SETTINGS_SECTIONS: SectionDef[] = [
  {
    id: "general",
    label: "General",
    icon: Settings2,
    component: GeneralSection,
  },
  {
    id: "editor",
    label: "Editor",
    icon: SlidersHorizontal,
    component: EditorSection,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Sun,
    component: AppearanceSection,
  },
  {
    id: "storage",
    label: "Storage",
    icon: HardDrive,
    component: StorageSection,
  },
  {
    id: "notion",
    label: "Notion",
    icon: NotebookPen,
    component: NotionSection,
  },
  {
    id: "about",
    label: "About",
    icon: Info,
    component: AboutSection,
  },
];

export function SettingsDialog() {
  const t = useT();
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const sectionId = useUi((s) => s.settingsSection);
  const setSection = useUi((s) => s.setSettingsSection);

  const active =
    SETTINGS_SECTIONS.find((s) => s.id === sectionId) ?? SETTINGS_SECTIONS[0];
  const ActiveSection = active.component;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="h-[min(560px,84vh)] w-[min(760px,calc(100vw-40px))] overflow-hidden p-0">
        <DialogTitle className="sr-only">{t("Settings")}</DialogTitle>
        <div className="flex h-full min-h-0">
          <nav
            className="flex w-[152px] shrink-0 flex-col border-r border-border/70 p-2"
            style={{ background: "var(--sidebar)" }}
          >
            <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              {t("Settings")}
            </div>
            {SETTINGS_SECTIONS.map((section) => {
              const isActive = section.id === active.id;
              return (
                <button
                  key={section.id}
                  onClick={() => setSection(section.id)}
                  className={cn(
                    "relative flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
                    isActive
                      ? "bg-brand-soft text-foreground"
                      : "text-foreground/75 hover:bg-accent/60",
                  )}
                  aria-current={isActive}
                >
                  {isActive && (
                    <span className="absolute inset-y-[7px] left-0 w-[2px] rounded-full bg-brand" />
                  )}
                  <section.icon
                    className={cn("size-3.5", isActive ? "text-brand" : "text-muted-foreground")}
                    strokeWidth={1.8}
                  />
                  <span className="truncate">{t(section.label)}</span>
                </button>
              );
            })}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-5 py-2.5">
              <div className="min-w-0 text-[13.5px] font-medium leading-tight">
                {t(active.label)}
              </div>
              <DialogClose asChild>
                <Button size="iconSm" variant="ghost" aria-label={t("Close settings")}>
                  <X className="size-3.5" />
                </Button>
              </DialogClose>
            </div>

            <div className="scroller scroll-pane min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <ActiveSection />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}