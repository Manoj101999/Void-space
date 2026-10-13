'use client';

/**
 * Bookmarks.
 *
 * A marketplace grid has a heart on every card, and an operator scanning a large library needs the
 * same affordance: "come back to this one". There is no server field for it and there should not
 * be — a saved item is a note-to-self about the interface, not a fact about the asset, and putting
 * it in the database would mean every tenant's review queue could be reordered by someone's
 * bookmark.
 *
 * So it lives in `localStorage` and the UI says so, rather than implying a synced collection.
 *
 * The store is module-level with `useSyncExternalStore` rather than `useState` + `useEffect`. The
 * effect version renders an empty heart on the first paint and fills it after hydration, which is a
 * visible flicker on every card; `useSyncExternalStore` reads the server snapshot while hydrating
 * and re-reads the real one immediately after, so nothing flashes.
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'void-space:bookmarks';

let ids: ReadonlySet<string> = new Set();
let loaded = false;
const listeners = new Set<() => void>();

/** A stable empty set, so the server snapshot is referentially equal across renders. */
const EMPTY: ReadonlySet<string> = new Set();

function readFromStorage(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    // Private mode, a disabled storage API, or a value someone edited by hand. An unreadable
    // bookmark file is an empty one, not an error worth surfacing.
    return [];
  }
}

function emit() {
  for (const listener of listeners) listener();
}

function ensureLoaded() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  ids = new Set(readFromStorage());
}

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Nothing to do and nothing worth saying: the toggle still works for this page view.
  }
}

export function toggleBookmark(assetId: string): void {
  ensureLoaded();
  const next = new Set(ids);
  if (next.has(assetId)) next.delete(assetId);
  else next.add(assetId);
  ids = next;
  persist();
  emit();
}

function subscribe(listener: () => void): () => void {
  ensureLoaded();
  listeners.add(listener);

  // Another tab toggling a bookmark is a real change to this tab's state.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    ids = new Set(readFromStorage());
    emit();
  };

  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useBookmarks(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribe,
    () => ids,
    () => EMPTY,
  );
}
