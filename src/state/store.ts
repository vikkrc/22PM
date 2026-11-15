// The project store: one Show document with undo/redo, plus editor UI state.
// The Show is treated as immutable; every edit clones it, so undo is a stack of documents.
import { useSyncExternalStore } from 'react';
import { makeShow, normalizeShow, type Show, type Song } from '../core/model';
import type { SnapMode } from '../core/tempo';

export type Tab = 'train' | 'edit' | 'animate' | 'show';
export type Selection =
  | { type: 'none' }
  | { type: 'clip'; id: string }
  | { type: 'splat'; id: string }
  | { type: 'song' }
  | { type: 'track'; id: string };

export interface KeyRef { param: string; keyId: string }

export interface UIState {
  tab: Tab;
  songId: string;
  selection: Selection;
  selectedKeys: KeyRef[];
  snap: SnapMode;
  viewMode: 'camera' | 'explore';
  debugView: number;
  showGizmos: boolean;
  showHud: boolean;
  previewScale: number;
  /** Timeline zoom in pixels per beat, and scroll in beats. */
  pxPerBeat: number;
  scrollBeat: number;
  dialog: null | 'render' | 'shortcuts';
  /** Params whose keyframe lane is pinned open in the timeline. */
  loop: boolean;
}

export interface Job { id: string; label: string; progress: number; status: 'running' | 'done' | 'error'; error?: string }

export interface State {
  show: Show;
  ui: UIState;
  jobs: Job[];
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Bumps when runtime assets (splats, audio, analysis) finish loading. */
  assetGen: number;
  toast: string | null;
}

const initialShow = makeShow();
let state: State = {
  show: initialShow,
  ui: {
    tab: 'animate', songId: initialShow.songs[0].id, selection: { type: 'none' }, selectedKeys: [], snap: '1',
    viewMode: 'camera', debugView: 0, showGizmos: true, showHud: true, previewScale: 1, pxPerBeat: 24, scrollBeat: -1, dialog: null, loop: false,
  },
  jobs: [], dirty: false, canUndo: false, canRedo: false, assetGen: 0, toast: null,
};

const listeners = new Set<() => void>();
let past: Show[] = [];
let future: Show[] = [];
let lastMerge: string | null = null;
let lastMergeAt = 0;
const HISTORY = 200;

function emit() { for (const l of listeners) l(); }
function set(next: Partial<State>) {
  state = { ...state, ...next, canUndo: past.length > 0, canRedo: future.length > 0 };
  emit();
}

export const getState = () => state;
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

export const currentSong = (s: State = state): Song => s.show.songs.find((x) => x.id === s.ui.songId) ?? s.show.songs[0];
export const useSong = () => useStore((s) => currentSong(s));

/**
 * Edit the show. `fn` mutates a private clone. Consecutive edits with the same `merge` key
 * (a drag, a scrubbed number) collapse into one undo step.
 */
export function update(fn: (show: Show, song: Song) => void, merge?: string) {
  const next = structuredClone(state.show);
  const song = next.songs.find((x) => x.id === state.ui.songId) ?? next.songs[0];
  fn(next, song);
  const now = performance.now();
  // A run ends at commit() (pointer up, key up). The time limit only guards against a missed commit.
  const coalesce = merge && merge === lastMerge && now - lastMergeAt < 30000;
  if (!coalesce) {
    past.push(state.show);
    if (past.length > HISTORY) past.shift();
  }
  future = [];
  lastMerge = merge ?? null;
  lastMergeAt = now;
  set({ show: next, dirty: true });
}

/** End a merge run, so the next edit with the same key starts a new undo step. */
export function commit() { lastMerge = null; }

export function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(state.show);
  lastMerge = null;
  set({ show: prev, dirty: true, ui: fixUi(prev, state.ui) });
}
export function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(state.show);
  lastMerge = null;
  set({ show: next, dirty: true, ui: fixUi(next, state.ui) });
}

function fixUi(show: Show, ui: UIState): UIState {
  return show.songs.some((s) => s.id === ui.songId) ? ui : { ...ui, songId: show.songs[0].id, selection: { type: 'none' }, selectedKeys: [] };
}

export function setUi(patch: Partial<UIState>) { set({ ui: { ...state.ui, ...patch } }); }
export function select(selection: Selection) { set({ ui: { ...state.ui, selection, selectedKeys: [] } }); }

export function loadShow(show: Show) {
  past = []; future = []; lastMerge = null;
  normalizeShow(show);
  set({ show, dirty: false, ui: { ...state.ui, songId: show.songs[0].id, selection: { type: 'none' }, selectedKeys: [] } });
}
export const markSaved = () => set({ dirty: false });
export const bumpAssets = () => set({ assetGen: state.assetGen + 1 });
export function toast(msg: string | null) {
  set({ toast: msg });
  if (msg) setTimeout(() => { if (state.toast === msg) set({ toast: null }); }, 4000);
}

let jobCounter = 0;
export function startJob(label: string): { progress: (p: number) => void; done: () => void; fail: (e: unknown) => void } {
  const id = `job${++jobCounter}`;
  set({ jobs: [...state.jobs, { id, label, progress: 0, status: 'running' }] });
  const patch = (p: Partial<Job>) => set({ jobs: state.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) });
  return {
    progress: (p) => patch({ progress: p }),
    done: () => { patch({ progress: 1, status: 'done' }); setTimeout(() => set({ jobs: state.jobs.filter((j) => j.id !== id) }), 2500); },
    fail: (e) => { patch({ status: 'error', error: String((e as Error)?.message ?? e) }); toast(`${label} failed: ${String((e as Error)?.message ?? e)}`); },
  };
}
export const dismissJob = (id: string) => set({ jobs: state.jobs.filter((j) => j.id !== id) });
