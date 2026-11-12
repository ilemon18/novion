import { useEffect, useState } from "react";
import { saveQueue, type SaveStatus } from "@/lib/save-scheduler";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";

const LABEL: Record<SaveStatus, string> = {
  idle: "",
  dirty: "Editing…",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

export function SaveIndicator({ saveKey }: { saveKey: string }) {
  const t = useT();
  const [status, setStatus] = useState<SaveStatus>(() => saveQueue.status(saveKey));

  useEffect(() => {
    setStatus(saveQueue.status(saveKey));
    const unsubscribe = saveQueue.subscribe((key, s) => {
      if (key === saveKey) setStatus(s);
    });
    return () => {
      unsubscribe();
    };
  }, [saveKey]);

  const label = LABEL[status];
  if (!label) return null;
  return (
    <div
      className={cn(
        "pointer-events-none flex select-none items-center gap-1.5 text-[11.5px] tabular-nums transition-opacity duration-200",
        status === "error" ? "text-destructive opacity-100" : "text-muted-foreground",
        status === "saved" ? "opacity-70" : "opacity-90",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "error" && "bg-destructive",
          status === "saving" && "animate-pulse bg-brand",
          status === "dirty" && "bg-muted-foreground/40",
          status === "saved" && "bg-brand",
        )}
      />
      {t(label)}
    </div>
  );
}