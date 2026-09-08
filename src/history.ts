import type { Layer, Transform, ViewKey } from './types';
import { state, ORTHO_FRAME_1BASED } from './state';

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Command {
  label: string;
  kind?: string;
  view?: ViewKey;
  undo(): void;
  redo(): void;
}

const LIMIT = 40;
let stack: Command[] = [];
let index = -1;

function emitState(): void {
  document.dispatchEvent(new CustomEvent('history-state', { detail: { canUndo: canUndo(), canRedo: canRedo() } }));
}

export function pushCommand(cmd: Command): void {
  stack.splice(index + 1);
  stack.push(cmd);
  if (stack.length > LIMIT) stack.shift();
  index = stack.length - 1;
  emitState();
}

export function canUndo(): boolean {
  return index >= 0;
}

export function canRedo(): boolean {
  return index < stack.length - 1;
}

export function undo(): void {
  if (!canUndo()) return;
  const cmd = stack[index--];
  cmd.undo();
  afterApply(cmd);
}

export function redo(): void {
  if (!canRedo()) return;
  const cmd = stack[++index];
  cmd.redo();
  afterApply(cmd);
}

export function clearHistory(): void {
  stack = [];
  index = -1;
  emitState();
}

function afterApply(cmd: Command): void {
  const view = (cmd as { view?: ViewKey }).view;
  if (view && view !== state.currentView) {
    state.currentView = view;
    state.orbitFrame = ORTHO_FRAME_1BASED[view] - 1;
    (document.getElementById('orbitSlider') as HTMLInputElement).value = String(state.orbitFrame);
    document.querySelectorAll('.view-tab').forEach((el) => {
      const tab = el as HTMLButtonElement;
      tab.classList.toggle('active', tab.dataset.view === view);
    });
  }
  document.dispatchEvent(new CustomEvent('history-applied', { detail: view }));
}

export function newMaskCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 800;
  return c;
}

function cloneLayer(l: Layer): Layer {
  return { ...l, transform: { ...l.transform } };
}

export function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

function findLayerIn(view: ViewKey, id: string): Layer | null {
  return state.views[view].layers.find((l) => l.id === id) ?? null;
}

export function commitAddLayer(view: ViewKey, layer: Layer, idx: number): void {
  pushCommand({
    label: '添加图层',
    view,
    undo: () => {
      const ls = state.views[view].layers;
      const i = ls.indexOf(layer);
      if (i >= 0) ls.splice(i, 1);
      if (state.selectedLayerId === layer.id) state.selectedLayerId = null;
    },
    redo: () => {
      const ls = state.views[view].layers;
      ls.splice(Math.min(Math.max(idx, 0), ls.length), 0, layer);
    },
  });
}

export function commitRemoveLayer(view: ViewKey, layer: Layer, idx: number, wasSelected: boolean): void {
  pushCommand({
    label: '删除图层',
    view,
    undo: () => {
      const ls = state.views[view].layers;
      ls.splice(Math.min(Math.max(idx, 0), ls.length), 0, layer);
      if (wasSelected) state.selectedLayerId = layer.id;
    },
    redo: () => {
      const ls = state.views[view].layers;
      const i = ls.indexOf(layer);
      if (i >= 0) ls.splice(i, 1);
      if (state.selectedLayerId === layer.id) state.selectedLayerId = null;
    },
  });
}

export function commitReorderLayer(view: ViewKey, i: number, j: number): void {
  const swap = () => {
    const ls = state.views[view].layers;
    const tmp = ls[i];
    ls[i] = ls[j];
    ls[j] = tmp;
  };
  pushCommand({
    label: '调整图层顺序',
    view,
    undo: swap,
    redo: swap,
  });
}

export function commitLayerProps(
  view: ViewKey,
  id: string,
  before: Partial<Layer>,
  after: Partial<Layer>,
  label = '修改图层',
): void {
  pushCommand({
    label,
    view,
    undo: () => {
      const l = findLayerIn(view, id);
      if (l) Object.assign(l, before);
    },
    redo: () => {
      const l = findLayerIn(view, id);
      if (l) Object.assign(l, after);
    },
  });
}

export function commitTransform(
  view: ViewKey,
  id: string,
  before: Transform,
  after: Transform,
): void {
  const now = Date.now();
  const key = `${view}:${id}`;
  const mergeable = now - lastTransformAt < 800 && lastTransformKey === key && index >= 0;
  lastTransformAt = now;
  lastTransformKey = key;
  if (mergeable) {
    const top = stack[index] as (Command & { kind?: string; after?: Partial<Layer> }) | undefined;
    if (top && top.kind === 'transform' && top.after) {
      top.after = { transform: { ...after } };
      return;
    }
  }
  pushCommand({
    label: '变换图层',
    kind: 'transform',
    view,
    undo: () => {
      const l = findLayerIn(view, id);
      if (l) l.transform = { ...before };
    },
    redo: () => {
      const l = findLayerIn(view, id);
      if (l) l.transform = { ...after };
    },
  });
}

let lastTransformAt = 0;
let lastTransformKey = '';

export function maskImageData(c: HTMLCanvasElement | null): ImageData | null {
  if (!c) return null;
  return c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
}

function restoreMask(view: ViewKey, bbox: BBox, data: ImageData | null): void {
  const v = state.views[view];
  if (!data) {
    v.mask = null;
    v.maskTouched = false;
    return;
  }
  if (!v.mask) {
    v.mask = newMaskCanvas();
    v.maskTouched = true;
  }
  v.mask.getContext('2d')!.putImageData(data, bbox.x, bbox.y);
}

export function commitMaskChange(view: ViewKey, label: string, bbox: BBox, before: ImageData | null, after: ImageData | null): void {
  pushCommand({
    label,
    view,
    undo: () => restoreMask(view, bbox, before),
    redo: () => restoreMask(view, bbox, after),
  });
}

export function runMaskMutation(view: ViewKey, label: string, mutate: () => void): void {
  const v = state.views[view];
  const before = maskImageData(v.mask);
  mutate();
  commitMaskChange(view, label, { x: 0, y: 0, w: 1200, h: 800 }, before, maskImageData(v.mask));
}

export function commitMaskRegion(view: ViewKey, beforeCanvas: HTMLCanvasElement, rawBBox: BBox): void {
  const mask = state.views[view].mask;
  if (!mask) return;
  const x = Math.max(0, Math.floor(rawBBox.x));
  const y = Math.max(0, Math.floor(rawBBox.y));
  const w = Math.min(mask.width - x, Math.ceil(rawBBox.w + (rawBBox.x - x)));
  const h = Math.min(mask.height - y, Math.ceil(rawBBox.h + (rawBBox.y - y)));
  if (w <= 0 || h <= 0) return;
  const before = beforeCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, w, h);
  const after = mask.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, w, h);
  commitMaskChange(view, '遮罩绘制', { x, y, w, h }, before, after);
}

export interface ViewSnapshot {
  layers: Layer[];
  mask: HTMLCanvasElement | null;
}

export function snapshotView(view: ViewKey): ViewSnapshot {
  const v = state.views[view];
  return { layers: v.layers.map(cloneLayer), mask: v.mask ? copyCanvas(v.mask) : null };
}

function restoreViewSnapshot(view: ViewKey, snap: ViewSnapshot): void {
  const v = state.views[view];
  v.layers = snap.layers.map(cloneLayer);
  v.mask = snap.mask ? copyCanvas(snap.mask) : null;
  v.maskTouched = !!snap.mask;
}

export function commitViewsSnapshot(label: string, views: ViewKey[], before: Record<string, ViewSnapshot>): void {
  const after: Record<string, ViewSnapshot> = {};
  for (const vk of views) after[vk] = snapshotView(vk);
  pushCommand({
    label,
    view: views[0],
    undo: () => {
      for (const vk of views) restoreViewSnapshot(vk, before[vk]);
    },
    redo: () => {
      for (const vk of views) restoreViewSnapshot(vk, after[vk]);
    },
  });
}

export function maskBBoxOfRegion(m: Uint8Array, w: number, h: number): BBox | null {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (m[y * w + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
