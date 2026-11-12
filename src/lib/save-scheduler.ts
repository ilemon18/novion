/**
 * Keyed, debounced, single-flight autosave queue.
 *
 * - Debounces rapid edits (600ms) but never postpones a save beyond 2s.
 * - Serialises writes per key so the same document is never written concurrently.
 * - Retries failed writes with backoff and keeps the dirty payload alive.
 * - Runs entirely outside React; the editor only pushes a closure.
 */
export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

type Run = () => Promise<void>;

interface Entry {
  run: Run | null;
  debounce: ReturnType<typeof setTimeout> | null;
  maxWait: ReturnType<typeof setTimeout> | null;
  retry: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
  pending: boolean;
  failures: number;
  status: SaveStatus;
}

const DEBOUNCE_MS = 600;
const MAX_WAIT_MS = 2000;
const RETRY_BASE_MS = 1200;
const MAX_RETRIES = 3;

const entries = new Map<string, Entry>();
const listeners = new Set<(key: string, status: SaveStatus) => void>();

function entry(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = {
      run: null,
      debounce: null,
      maxWait: null,
      retry: null,
      inflight: false,
      pending: false,
      failures: 0,
      status: "idle",
    };
    entries.set(key, e);
  }
  return e;
}

function emit(key: string, status: SaveStatus) {
  const e = entry(key);
  if (e.status === status) return;
  e.status = status;
  listeners.forEach((fn) => fn(key, status));
}

function clearTimers(e: Entry) {
  if (e.debounce) clearTimeout(e.debounce);
  if (e.maxWait) clearTimeout(e.maxWait);
  e.debounce = null;
  e.maxWait = null;
}

async function drain(key: string) {
  const e = entry(key);
  clearTimers(e);
  if (e.inflight || !e.pending || !e.run) return;

  const run = e.run;
  e.pending = false;
  e.inflight = true;
  emit(key, "saving");
  try {
    await run();
    e.failures = 0;
    if (e.pending) {
      // edits landed while writing — flush again without waiting
      await drain(key);
    } else {
      emit(key, "saved");
    }
  } catch (err) {
    console.error("[novion] save failed", key, err);
    e.failures += 1;
    e.pending = true;
    if (e.failures > MAX_RETRIES) {
      emit(key, "error");
    } else {
      emit(key, "dirty");
      e.retry = setTimeout(() => void drain(key), RETRY_BASE_MS * e.failures);
    }
  } finally {
    e.inflight = false;
  }
}

export const saveQueue = {
  schedule(key: string, run: Run) {
    const e = entry(key);
    e.run = run;
    e.pending = true;
    e.failures = 0;
    if (e.retry) {
      clearTimeout(e.retry);
      e.retry = null;
    }
    if (e.debounce) clearTimeout(e.debounce);
    e.debounce = setTimeout(() => void drain(key), DEBOUNCE_MS);
    if (!e.maxWait) e.maxWait = setTimeout(() => void drain(key), MAX_WAIT_MS);
    if (!e.inflight) emit(key, "dirty");
  },

  /** Force an immediate write (document switch, ⌘S, window blur). */
  async flush(key: string) {
    const e = entries.get(key);
    if (!e) return;
    if (e.retry) {
      clearTimeout(e.retry);
      e.retry = null;
    }
    await drain(key);
  },

  /** Flush every pending document (used before switching the storage root). */
  async flushAll() {
    await Promise.all([...entries.keys()].map((key) => saveQueue.flush(key)));
  },

  /** Drop pending work for a key (document closed / deleted). */
  cancel(key: string) {
    const e = entries.get(key);
    if (!e) return;
    clearTimers(e);
    if (e.retry) clearTimeout(e.retry);
    e.pending = false;
    e.run = null;
    entries.delete(key);
  },

  status(key: string): SaveStatus {
    return entries.get(key)?.status ?? "idle";
  },

  subscribe(fn: (key: string, status: SaveStatus) => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};