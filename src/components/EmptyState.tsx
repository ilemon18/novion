import { FilePlus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";

export function EmptyState({
  hasDocs,
  onCreate,
}: {
  hasDocs: boolean;
  onCreate: () => void;
}) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl border border-brand/25 bg-brand-soft shadow-sm">
        <FilePlus className="size-5 text-brand" strokeWidth={1.6} />
      </div>
      <div className="mt-4 text-[14.5px] font-medium tracking-[-0.01em]">
        {hasDocs ? t("Pick a note to get started") : t("No notes yet")}
      </div>
      <Button variant="accent" size="sm" className="mt-5" onClick={onCreate}>
        <Plus className="size-3.5" />
        {t("New document")}
      </Button>
    </div>
  );
}