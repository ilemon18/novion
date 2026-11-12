import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "@/store/ui";

/** Drag handle between sidebar and content; only commits to the store on release. */
export function SidebarResizer({
  width,
  onPreview,
  onCommit,
}: {
  width: number;
  onPreview: (w: number) => void;
  onCommit: (w: number) => void;
}) {
  const state = useRef({ startX: 0, startW: 0, raf: 0, latest: width, active: false });

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      state.current = { startX: e.clientX, startW: width, raf: 0, latest: width, active: true };
      document.body.style.cursor = "col-resize";
    },
    [width],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const s = state.current;
      if (!s.active) return;
      s.latest = Math.min(420, Math.max(180, s.startW + e.clientX - s.startX));
      if (s.raf) return;
      s.raf = requestAnimationFrame(() => {
        s.raf = 0;
        onPreview(s.latest);
      });
    };
    const up = () => {
      const s = state.current;
      if (!s.active) return;
      s.active = false;
      document.body.style.cursor = "";
      onCommit(s.latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [onCommit, onPreview]);

  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={() => onCommit(248)}
      className="group absolute -right-[3px] top-0 z-20 h-full w-[6px] cursor-col-resize"
      data-no-window-drag
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-ring/50" />
    </div>
  );
}

/** Sidebar width with a transient preview while dragging. */
export function useSidebarWidth() {
  const stored = useUi((s) => s.sidebarWidth);
  const setWidth = useUi((s) => s.setSidebarWidth);
  const [preview, setPreview] = useState<number | null>(null);
  return {
    width: preview ?? stored,
    preview: setPreview,
    commit: (w: number) => {
      setWidth(w);
      setPreview(null);
    },
  };
}
