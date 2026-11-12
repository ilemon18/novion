import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import {
  ArrowUpRight,
  ChevronRight,
  Link2,
  ListTree,
  Pin,
  PinOff,
  RotateCcw,
} from "lucide-react";
import { api, errorMessage, type Backlink } from "@/lib/tauri";
import { saveQueue } from "@/lib/save-scheduler";
import { setActiveEditor } from "@/lib/editor-registry";
import { ancestorFolders, isTrashed, useWorkspace } from "@/store/workspace";
import { useUi } from "@/store/ui";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatShortcut, isWindows } from "@/lib/platform";
import { absolutizeContent, relativizeContent, serializeContent } from "./doc-content";
import { DocActionButton } from "./DocAction";
import { DocEditor, type OutlineItem } from "./DocEditor";
import { DocMenu } from "./DocMenu";
import { DocOutline } from "./DocOutline";
import { DocTitle } from "./DocTitle";
import { FindBar } from "./FindBar";
import { SaveIndicator } from "./SaveIndicator";
import { UpdateButton } from "./UpdateButton";
import { VersionHistoryDialog } from "./VersionHistoryDialog";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };
/** how often the open document is checked for changes made outside the app */
const STAMP_POLL_MS = 6000;

function isConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "doc_conflict"
  );
}

type Banner =
  | { kind: "conflict" }
  | { kind: "external" }
  | null;

export default function DocView({ docId }: { docId: string }) {
  const t = useT();
  const rootPath = useWorkspace((s) => s.rootPath);
  const node = useWorkspace((s) => s.nodes[docId]);
  const nodeName = node?.name ?? "";
  /** `nodes` keeps its reference until the tree actually changes, so the crumb
   *  chain is only rebuilt for a rename / move instead of on every keystroke */
  const nodes = useWorkspace((s) => s.nodes);
  const crumbs = useMemo(() => ancestorFolders(nodes, docId), [nodes, docId]);
  const focusFolder = useWorkspace((s) => s.focusFolder);
  const rename = useWorkspace((s) => s.rename);
  const setError = useWorkspace((s) => s.setError);
  const restore = useWorkspace((s) => s.restore);
  const setPinned = useWorkspace((s) => s.setPinned);
  const pinned = !!node?.pinnedAt;
  const trashed = useWorkspace((s) => isTrashed(s.nodes, docId));
  const completed = useWorkspace((s) => !!s.nodes[docId]?.completedAt);
  const notify = useUi((s) => s.notify);
  const findOpen = useUi((s) => s.findOpen);
  const setFindOpen = useUi((s) => s.setFindOpen);
  const findSeed = useUi((s) => s.findSeed);
  const setFindSeed = useUi((s) => s.setFindSeed);
  const setSidebarOpen = useUi((s) => s.setSidebarOpen);

  /**
   * `loaded` is keyed by docId on purpose: the editor must only mount once the
   * payload belonging to *this* document has arrived. Mounting earlier makes
   * TipTap keep the previous document's content (its `useEditor` deps are []).
   */
  const [loaded, setLoaded] = useState<{ docId: string; content: unknown } | null>(null);
  const [title, setTitle] = useState(nodeName);
  /** bumped after a history restore so the whole editor is rebuilt */
  const [revision, setRevision] = useState(0);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [banner, setBanner] = useState<Banner>(null);
  const outlineOpen = useUi((s) => s.outlineOpen);
  const setOutlineOpen = useUi((s) => s.setOutlineOpen);
  const features = useUi((s) => s.features);
  const featuresRev = useUi((s) => s.featuresRev);
  const outlineVisible = features.outline && outlineOpen;
  const scrollRef = useRef<HTMLDivElement>(null);

  const titleRef = useRef(nodeName);
  const rootRef = useRef(rootPath);
  rootRef.current = rootPath;
  const titleInputRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<TiptapEditor | null>(null);
  const renameTimer = useRef<number | null>(null);
  /** last content the editor handed over, for "keep mine" after a conflict */
  const snapshotRef = useRef<unknown>(null);
  /** mtime of the file this client is looking at; `0` = never loaded */
  const stampRef = useRef(0);
  const docKey = `doc:${docId}`;

  /**
   * Feature toggles change the editor's extension options, and `useEditor`
   * cannot rebuild those in place. Flush the pending save first, then bump
   * `revision`: the load effect re-reads the body from disk, so the rebuilt
   * editor starts from what is on screen instead of the payload from mount.
   */
  const lastFeaturesRev = useRef(featuresRev);
  useEffect(() => {
    if (lastFeaturesRev.current === featuresRev) return;
    lastFeaturesRev.current = featuresRev;
    void saveQueue.flush(docKey).finally(() => {
      // TipTap must tear itself down while its DOM is still attached. Letting
      // React remove the container first makes ProseMirror call
      // `parentNode.removeChild()` on an already-detached node, which WebKit
      // reports as "The object can not be found here".
      editorRef.current?.destroy();
      // null first: the editor must not mount with the payload from mount time
      // while the fresh read is still in flight
      setLoaded(null);
      setRevision((value) => value + 1);
      // don't leave the outline panel holding a destroyed editor
      setActiveEditor(null);
      setEditor(null);
    });
  }, [featuresRev, docKey]);

  /**
   * Snapshot the payload so a late flush can never write into another document.
   * The editor hands over an immutable ProseMirror node; it is only turned into
   * JSON here, inside the debounced run, instead of on every keystroke.
   */
  const schedule = useCallback(
    (snapshot: unknown) => {
      snapshotRef.current = snapshot;
      const titleSnapshot = titleRef.current;
      const base = stampRef.current;
      saveQueue.schedule(docKey, async () => {
        try {
          const saved = await api.saveDoc(
            docId,
            titleSnapshot.trim() || "Untitled",
            relativizeContent(serializeContent(snapshot), rootRef.current),
            base,
          );
          // keep the stamp in sync so our own write is never read as an
          // external change by the poll below
          stampRef.current = saved.mtimeMs;
          setBanner(null);
        } catch (err) {
          if (isConflict(err)) setBanner({ kind: "conflict" });
          throw err;
        }
      });
    },
    [docId, docKey],
  );

  /**
   * The rename also rewrites the document file (its title is mirrored there),
   * so the local stamp has to be refreshed: otherwise the external-change poll
   * would report the app's own write as somebody else's edit.
   */
  const refreshStamp = useCallback(async () => {
    try {
      const stamp = await api.docStamp(docId);
      if (stamp.exists) stampRef.current = stamp.mtimeMs;
    } catch {
      /* the next save or poll will resync */
    }
  }, [docId]);

  const flushRename = useCallback(() => {
    if (renameTimer.current !== null) {
      clearTimeout(renameTimer.current);
      renameTimer.current = null;
      void rename(docId, titleRef.current).then(refreshStamp);
    }
  }, [docId, refreshStamp, rename]);

  // load the document on demand, then hand the editor its own payload
  useEffect(() => {
    if (!rootPath) return;
    let alive = true;
    (async () => {
      try {
        const doc = await api.readDoc(docId);
        const stamp = await api.docStamp(docId);
        if (!alive) return;
        stampRef.current = stamp.mtimeMs;
        setBanner(null);
        const wsNode = useWorkspace.getState().nodes[docId];
        const name = wsNode?.name ?? doc.title ?? "";
        titleRef.current = name;
        setTitle(name);
        setLoaded({ docId, content: absolutizeContent(doc.content ?? EMPTY_DOC, rootPath) });
        // No auto-focus here: a freshly created note is named in the sidebar
        // (see `requestRename` in the workspace store). Grabbing the title on
        // mount used to fight that inline field — it only won when the click
        // had landed on the document body, which read as "sometimes it works".
      } catch (err) {
        if (!alive) return;
        setError(errorMessage(err));
        setLoaded({ docId, content: EMPTY_DOC });
      }
    })();
    return () => {
      alive = false;
      // persist the outgoing document before it loses the editor
      void saveQueue.flush(docKey).finally(() => saveQueue.cancel(docKey));
    };
  }, [docId, docKey, rootPath, revision, setError]);

  useEffect(() => () => flushRename(), [flushRename]);

  // sidebar renames should reach an open document
  useEffect(() => {
    if (document.activeElement === titleInputRef.current) return;
    if (nodeName !== titleRef.current) {
      titleRef.current = nodeName;
      setTitle(nodeName);
    }
  }, [nodeName]);

  useEffect(() => {
    const onBlur = () => void saveQueue.flush(docKey);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [docKey]);

  /**
   * Watches the file for changes made outside this editor — another Mac through
   * iCloud, a restore, a hand edit. Only a change while nothing is pending is
   * announced; with unsaved edits the save path reports the conflict instead.
   */
  useEffect(() => {
    if (loaded?.docId !== docId) return;
    let alive = true;
    const tick = async () => {
      try {
        const stamp = await api.docStamp(docId);
        if (!alive || !stamp.exists) return;
        if (stamp.mtimeMs === stampRef.current) {
          setBanner((current) => (current?.kind === "external" ? null : current));
          return;
        }
        const status = saveQueue.status(docKey);
        if (status === "idle" || status === "saved") {
          setBanner((current) => (current?.kind === "conflict" ? current : { kind: "external" }));
        }
      } catch {
        /* a transient stat failure is not worth a banner */
      }
    };
    const timer = window.setInterval(() => void tick(), STAMP_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [docId, docKey, loaded?.docId]);

  // a global search hit asks this document to open the find bar on its term
  useEffect(() => {
    if (!findSeed) return;
    setFindOpen(true);
  }, [findSeed, setFindOpen]);

  // commands in the palette act on whatever editor is open
  useEffect(() => () => setActiveEditor(null), []);

  // backlinks are computed from the other documents, so they only change when
  // this document is (re)opened or the workspace around it changes
  useEffect(() => {
    if (loaded?.docId !== docId) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void api
        .backlinks(docId)
        .then((list) => {
          if (alive) setBacklinks(list);
        })
        .catch(() => {
          if (alive) setBacklinks([]);
        });
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [docId, loaded?.docId, revision]);

  const onTitleChange = (value: string) => {
    setTitle(value);
    titleRef.current = value;
    if (renameTimer.current !== null) clearTimeout(renameTimer.current);
    renameTimer.current = window.setTimeout(() => {
      renameTimer.current = null;
      void rename(docId, value).then(refreshStamp);
    }, 450);
  };

  /** Reloads the body from disk, discarding the editor's in-memory copy. */
  const reloadFromDisk = useCallback(() => {
    saveQueue.cancel(docKey);
    setBanner(null);
    setOutline([]);
    setActiveEditor(null);
    setEditor(null);
    setLoaded(null);
    setRevision((value) => value + 1);
  }, [docKey]);

  const keepMine = useCallback(async () => {
    const snapshot = snapshotRef.current;
    setBanner(null);
    saveQueue.cancel(docKey);
    if (!snapshot) {
      reloadFromDisk();
      return;
    }
    try {
      const saved = await api.saveDoc(
        docId,
        titleRef.current.trim() || "Untitled",
        relativizeContent(serializeContent(snapshot), rootRef.current),
        undefined,
        true,
      );
      stampRef.current = saved.mtimeMs;
      notify(t("Overwrote the file on disk with the local version"), { tone: "success" });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [docId, docKey, notify, reloadFromDisk, setError]);

  const keepBoth = useCallback(async () => {
    const snapshot = snapshotRef.current;
    setBanner(null);
    saveQueue.cancel(docKey);
    if (!snapshot) {
      reloadFromDisk();
      return;
    }
    try {
      const suffix = `（${t("(local copy)")}）`;
      const name = (titleRef.current.trim() || "Untitled").slice(0, 150);
      const res = await api.duplicateDoc(
        docId,
        `${name}${suffix}`,
        relativizeContent(serializeContent(snapshot), rootRef.current),
      );
      useWorkspace.getState().apply(res.workspace);
      notify(
        t("Local edits saved as “{name}”", { name: `${name}${t("(local copy)")}` }),
        { tone: "success" },
      );
      reloadFromDisk();
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [docId, docKey, notify, reloadFromDisk, setError]);

  if (!node) return null;

  const isLoaded = loaded?.docId === docId;

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {findOpen && (
          <FindBar
            key={findSeed ?? "manual"}
            editor={editor}
            initialQuery={findSeed ?? ""}
            onClose={() => {
              setFindOpen(false);
              setFindSeed(null);
            }}
          />
        )}
        <div ref={scrollRef} className="doc-scroll scroller scroll-pane flex-1">
          <div className={cn("mx-auto w-full max-w-[860px] px-8 pb-[18vh]", isWindows ? "pt-6" : "pt-[42px]")}>
            {(trashed || completed) && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-[12.5px] text-muted-foreground">
                <span className="min-w-0 flex-1 leading-relaxed">
                  {trashed
                    ? t("This document is in the trash. Restoring returns it to its original location.")
                    : t("This document is archived.")}
                </span>
                <Button size="sm" variant="outline" onClick={() => void restore(docId)}>
                  <RotateCcw className="size-3.5" />
                  {t("Restore")}
                </Button>
              </div>
            )}

            {banner && (
              <div
                className={cn(
                  "mb-4 rounded-lg border px-3 py-2.5",
                  banner.kind === "conflict"
                    ? "border-warning/40 bg-warning/10"
                    : "border-border bg-muted/50",
                )}
              >
                <div className="text-[12.5px] font-medium">
                  {banner.kind === "conflict"
                    ? t("The file on disk was changed on another device")
                    : t("The file on disk has been updated")}
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                  {banner.kind === "conflict"
                    ? t("Autosave is paused. Choose which version to keep.")
                    : t("Reloading discards unsaved edits.")}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {banner.kind === "conflict" ? (
                    <>
                      <Button size="sm" variant="default" onClick={() => void keepMine()}>
                        {t("Keep my version")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void keepBoth()}>
                        {t("Keep both")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={reloadFromDisk}>
                        {t("Use the version on disk")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="default" onClick={reloadFromDisk}>
                        {t("Reload")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setBanner(null)}
                      >
                        {t("Later")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="mb-2.5 flex items-center gap-1 text-[11.5px] text-muted-foreground">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                <span className="shrink-0 opacity-80">Novion</span>
                {crumbs.map((crumb) => (
                  <span key={crumb.id} className="flex min-w-0 items-center gap-1">
                    <ChevronRight className="size-3 shrink-0 opacity-50" />
                    {crumb.builtin ? (
                      // system folders live in their own sidebar section, so
                      // they are part of the path but not a jump target
                      <span className="truncate opacity-80">
                        {crumb.name || t("Untitled")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          // the jump is pointless with the rail collapsed
                          setSidebarOpen(true);
                          focusFolder(crumb.id);
                        }}
                        title={t("Reveal “{name}” in the sidebar", {
                          name: crumb.name || t("Untitled"),
                        })}
                        className="-mx-1 min-w-0 truncate rounded px-1 py-0.5 opacity-80 outline-none transition-colors hover:bg-sidebar-hover hover:text-foreground hover:opacity-100 focus-visible:bg-sidebar-hover"
                      >
                        {crumb.name || t("Untitled")}
                      </button>
                    )}
                  </span>
                ))}
                {pinned && (
                  <>
                    <ChevronRight className="size-3 shrink-0 opacity-50" />
                    <Pin className="size-3 shrink-0 rotate-45 text-brand" strokeWidth={2} />
                  </>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {!trashed && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DocActionButton
                        onClick={() => void setPinned(docId, !pinned)}
                        aria-label={pinned ? t("Unpin") : t("Pin")}
                      >
                        {pinned ? (
                          <PinOff className="size-4" strokeWidth={1.7} />
                        ) : (
                          <Pin className="size-4" strokeWidth={1.7} />
                        )}
                      </DocActionButton>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {pinned ? t("Unpin") : t("Pin")}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DocActionButton
                      onClick={() => setFindOpen(!findOpen)}
                      active={findOpen}
                      aria-label={t("Find in this document")}
                      aria-pressed={findOpen}
                    >
                      <span className="text-[12.5px] font-medium leading-none">{formatShortcut("⌘F")}</span>
                    </DocActionButton>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{t("Find in this document")}</TooltipContent>
                </Tooltip>
                {features.outline && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DocActionButton
                        onClick={() => setOutlineOpen(!outlineOpen)}
                        active={outlineOpen}
                        aria-label={outlineOpen ? t("Hide outline") : t("Show outline")}
                        aria-pressed={outlineOpen}
                      >
                        <ListTree className="size-4" strokeWidth={1.7} />
                      </DocActionButton>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {outlineOpen ? t("Hide outline") : t("Show outline")}
                    </TooltipContent>
                  </Tooltip>
                )}
                <DocMenu docId={docId} />
              </div>
            </div>
            <DocTitle
              value={isLoaded ? title : ""}
              onChange={onTitleChange}
              onCommit={flushRename}
              inputRef={titleInputRef}
              onBlur={flushRename}
              onEnter={() => {
                editorRef.current?.chain().focus("end").run();
              }}
            />

            <div className="mt-3">
              {isLoaded && loaded ? (
                <DocEditor
                  key={`${docId}:${revision}`}
                  initialContent={loaded.content}
                  features={features}
                  onChange={(json) => schedule(json)}
                  onEditorReady={(ed) => {
                    editorRef.current = ed;
                    setActiveEditor(ed);
                    setEditor(ed);
                  }}
                  onError={(msg) => setError(msg)}
                  onOutline={setOutline}
                  outlineEnabled={outlineVisible}
                />
              ) : (
                <div className="space-y-2.5 pt-2">
                  <div className="h-4 w-[62%] animate-pulse rounded bg-muted" />
                  <div className="h-4 w-[48%] animate-pulse rounded bg-muted" />
                  <div className="h-4 w-[55%] animate-pulse rounded bg-muted" />
                </div>
              )}
            </div>

            {backlinks.length > 0 && (
              <section className="mt-10 border-t border-border/70 pt-3">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                  <Link2 className="size-3" strokeWidth={2} />
                  {t("Backlinks")}
                  <span className="tabular-nums opacity-70">{backlinks.length}</span>
                </div>
                <ul className="mt-1.5 space-y-0.5">
                  {backlinks.map((link) => (
                    <li key={link.id}>
                      <button
                        type="button"
                        onClick={() => useWorkspace.getState().reveal(link.id)}
                        className="group flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/60"
                      >
                        <ArrowUpRight className="mt-[3px] size-3 shrink-0 text-muted-foreground/70" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">
                            {link.title || t("Untitled")}
                          </span>
                          {link.context && (
                            <span className="mt-0.5 line-clamp-1 block text-[11.5px] text-muted-foreground">
                              {link.context}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </div>

        {!findOpen && (
          <div className="pointer-events-none absolute right-5 top-[13px] z-10 flex items-center gap-3">
            <UpdateButton />
            <SaveIndicator saveKey={docKey} />
          </div>
        )}
      </div>

      {outlineVisible && (
        <DocOutline
          items={outline}
          editor={editor}
          scrollRef={scrollRef}
          onClose={() => setOutlineOpen(false)}
        />
      )}

      {features.history && (
        <VersionHistoryDialog
          docId={docId}
          onRestored={() => {
            // same teardown order as a feature toggle: destroy while attached
            editorRef.current?.destroy();
            // clearing `loaded` before bumping the revision keeps the remounted
            // editor from being handed the pre-restore body
            saveQueue.cancel(docKey);
            setOutline([]);
            setActiveEditor(null);
            setEditor(null);
            setLoaded(null);
            setBanner(null);
            setRevision((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
