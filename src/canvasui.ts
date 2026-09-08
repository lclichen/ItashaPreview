import { state, currentView, markDirty, ORTHO_FRAME_1BASED } from './state';
import { mainCanvas, toImageSpace, getViewTransform, cornerPoints } from './render';
import { stampLine, wandMask, uint8ToMaskCanvas } from './maskedit';
import { commitTransform, commitMaskRegion, copyCanvas, maskBBoxOfRegion } from './history';
import type { Layer } from './types';

type HandleKind = 'rotate' | 'nw' | 'ne' | 'se' | 'sw';

interface DragState {
  kind: 'move' | 'handle';
  handle?: HandleKind;
  layer: Layer;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origScale: number;
  origRotation: number;
  origDist: number;
  origAngle: number;
}

let drag: DragState | null = null;
let painting = false;
let paintAdd = true;
let lastPt: { x: number; y: number } | null = null;
let strokeBefore: HTMLCanvasElement | null = null;
let strokeBBox: { x: number; y: number; w: number; h: number } | null = null;

const alphaCache = new WeakMap<HTMLImageElement, { data: Uint8ClampedArray; w: number; h: number }>();

function layerAlpha(img: HTMLImageElement): { data: Uint8ClampedArray; w: number; h: number } {
  let hit = alphaCache.get(img);
  if (hit) return hit;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const cctx = c.getContext('2d', { willReadFrequently: true })!;
  cctx.drawImage(img, 0, 0);
  hit = { data: cctx.getImageData(0, 0, w, h).data, w, h };
  alphaCache.set(img, hit);
  return hit;
}

function hitLayer(layer: Layer, ix: number, iy: number): boolean {
  const t = layer.transform;
  const dx = ix - t.x;
  const dy = iy - t.y;
  const rad = (-t.rotation * Math.PI) / 180;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  const iw = layer.img.naturalWidth || layer.img.width;
  const ih = layer.img.naturalHeight || layer.img.height;
  const hx = lx / t.scale + iw / 2;
  const hy = ly / t.scale + ih / 2;
  if (hx < 0 || hy < 0 || hx >= iw || hy >= ih) return false;
  const a = layerAlpha(layer.img);
  return a.data[(Math.floor(hy) * a.w + Math.floor(hx)) * 4 + 3] > 12;
}

function pickLayer(ix: number, iy: number): Layer | null {
  const layers = currentView().layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.kind === 'background' || !l.visible) continue;
    if (hitLayer(l, ix, iy)) return l;
  }
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.kind !== 'background' || !l.visible) continue;
    if (hitLayer(l, ix, iy)) return l;
  }
  return null;
}

function layerCorners(layer: Layer): { pts: [number, number][]; iw: number; ih: number } {
  const t = layer.transform;
  const iw = (layer.img.naturalWidth || layer.img.width) * t.scale;
  const ih = (layer.img.naturalHeight || layer.img.height) * t.scale;
  const pts = cornerPoints(iw, ih).map(([px, py]) => {
    const rad = (t.rotation * Math.PI) / 180;
    return [t.x + px * Math.cos(rad) - py * Math.sin(rad), t.y + px * Math.sin(rad) + py * Math.cos(rad)] as [number, number];
  });
  return { pts, iw, ih };
}

function hitHandle(layer: Layer, ix: number, iy: number): HandleKind | null {
  const t = layer.transform;
  const { pts, ih } = layerCorners(layer);
  const vt = getViewTransform();
  const r = 14 / vt.scale;
  const kinds: HandleKind[] = ['nw', 'ne', 'se', 'sw'];
  for (let k = 0; k < 4; k++) {
    if (Math.hypot(pts[k][0] - ix, pts[k][1] - iy) <= r) return kinds[k];
  }
  const rad = (t.rotation * Math.PI) / 180;
  const hx = t.x + (ih / 2 + 30) * Math.sin(rad);
  const hy = t.y - (ih / 2 + 30) * Math.cos(rad);
  if (Math.hypot(hx - ix, hy - iy) <= r) return 'rotate';
  return null;
}

function onPointerDown(e: PointerEvent): void {
  const p = toImageSpace(e.clientX, e.clientY);
  if (state.mode === 'mask') {
    const view = currentView();
    mainCanvas.setPointerCapture(e.pointerId);
    painting = true;
    paintAdd = !e.altKey;
    if (state.maskTool !== 'wand' && view.mask) {
      strokeBefore = copyCanvas(view.mask);
      const r = state.brushSize / 2;
      strokeBBox = { x: p.x - r, y: p.y - r, w: state.brushSize, h: state.brushSize };
    }
    applyMaskTool(p.x, p.y, p.x, p.y);
    return;
  }
  if (state.mode === 'edit') {
    const view = currentView();
    const sel = view.layers.find((l) => l.id === state.selectedLayerId);
    if (sel) {
      const h = hitHandle(sel, p.x, p.y);
      if (h) {
        mainCanvas.setPointerCapture(e.pointerId);
        const dist = Math.hypot(p.x - sel.transform.x, p.y - sel.transform.y);
        drag = {
          kind: 'handle',
          handle: h,
          layer: sel,
          startX: p.x,
          startY: p.y,
          origX: sel.transform.x,
          origY: sel.transform.y,
          origScale: sel.transform.scale,
          origRotation: sel.transform.rotation,
          origDist: Math.max(dist, 1),
          origAngle: Math.atan2(p.y - sel.transform.y, p.x - sel.transform.x),
        };
        return;
      }
    }
    const layer = pickLayer(p.x, p.y);
    if (layer) {
      mainCanvas.setPointerCapture(e.pointerId);
      state.selectedLayerId = layer.id;
      drag = {
        kind: 'move',
        layer,
        startX: p.x,
        startY: p.y,
        origX: layer.transform.x,
        origY: layer.transform.y,
        origScale: layer.transform.scale,
        origRotation: layer.transform.rotation,
        origDist: 0,
        origAngle: 0,
      };
      document.dispatchEvent(new CustomEvent('layer-selected'));
    } else {
      state.selectedLayerId = null;
      document.dispatchEvent(new CustomEvent('layer-selected'));
    }
    markDirty();
  }
}

function applyMaskTool(ix: number, iy: number, lx: number, ly: number): void {
  const view = currentView();
  if (!view.mask) return;
  const mctx = view.mask.getContext('2d')!;
  if (state.maskTool === 'wand') {
    const frameImg = state.frames[ORTHO_FRAME_1BASED[state.currentView] - 1];
    if (!frameImg) return;
    const before = copyCanvas(view.mask);
    const res = wandMask(frameImg, ix, iy, state.wandTolerance);
    if (res) {
      const wantAdd = state.wandMode === 'add' ? paintAdd : !paintAdd;
      mctx.save();
      mctx.globalCompositeOperation = wantAdd ? 'source-over' : 'destination-out';
      const tmp = uint8ToMaskCanvas(res.mask, res.w, res.h);
      mctx.drawImage(tmp, 0, 0);
      mctx.restore();
      const bb = maskBBoxOfRegion(res.mask, res.w, res.h);
      if (bb) commitMaskRegion(state.currentView, before, bb);
      markDirty();
    }
    painting = false;
    return;
  }
  const radius = state.brushSize / 2;
  if (strokeBBox) {
    const x0 = Math.min(lx, ix) - radius;
    const y0 = Math.min(ly, iy) - radius;
    const x1 = Math.max(lx, ix) + radius;
    const y1 = Math.max(ly, iy) + radius;
    strokeBBox.x = Math.min(strokeBBox.x, x0);
    strokeBBox.y = Math.min(strokeBBox.y, y0);
    strokeBBox.w = Math.max(strokeBBox.w, x1 - strokeBBox.x);
    strokeBBox.h = Math.max(strokeBBox.h, y1 - strokeBBox.y);
  }
  const add = paintAdd && state.maskTool === 'brush';
  stampLine(mctx, lx, ly, ix, iy, radius, add);
  markDirty();
}

function onPointerMove(e: PointerEvent): void {
  const p = toImageSpace(e.clientX, e.clientY);
  state.brushCursor = p;
  if (state.mode === 'mask') {
    if (painting) {
      const from = lastPt ?? p;
      applyMaskTool(p.x, p.y, from.x, from.y);
    }
    lastPt = p;
    markDirty();
    return;
  }
  if (drag) {
    const t = drag.layer.transform;
    if (drag.kind === 'move') {
      t.x = drag.origX + (p.x - drag.startX);
      t.y = drag.origY + (p.y - drag.startY);
    } else if (drag.handle === 'rotate') {
      const cur = Math.atan2(p.y - t.y, p.x - t.x);
      let deg = drag.origRotation + ((cur - drag.origAngle) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      t.rotation = ((deg + 180) % 360 + 360) % 360 - 180;
    } else {
      const dist = Math.max(Math.hypot(p.x - t.x, p.y - t.y), 1);
      const ratio = dist / drag.origDist;
      t.scale = Math.min(8, Math.max(0.02, drag.origScale * ratio));
    }
    document.dispatchEvent(new CustomEvent('layer-transformed'));
    markDirty();
  } else if (state.mode === 'edit') {
    const sel = currentView().layers.find((l) => l.id === state.selectedLayerId);
    if (sel && hitHandle(sel, p.x, p.y)) {
      mainCanvas.style.cursor = 'grab';
    } else {
      mainCanvas.style.cursor = 'crosshair';
    }
  }
}

function onPointerUp(): void {
  if (drag) {
    const t = drag.layer.transform;
    const before = { x: drag.origX, y: drag.origY, scale: drag.origScale, rotation: drag.origRotation };
    if (before.x !== t.x || before.y !== t.y || before.scale !== t.scale || before.rotation !== t.rotation) {
      commitTransform(state.currentView, drag.layer.id, before, { ...t });
    }
  }
  if (strokeBefore && strokeBBox) {
    commitMaskRegion(state.currentView, strokeBefore, strokeBBox);
  }
  drag = null;
  painting = false;
  lastPt = null;
  strokeBefore = null;
  strokeBBox = null;
}

function onWheel(e: WheelEvent): void {
  if (state.mode === 'orbit') {
    const dir = e.deltaY > 0 ? 1 : -1;
    state.orbitFrame = (state.orbitFrame + dir + 36) % 36;
    document.dispatchEvent(new CustomEvent('orbit-changed'));
    markDirty();
    e.preventDefault();
    return;
  }
  if (state.mode === 'edit') {
    const sel = currentView().layers.find((l) => l.id === state.selectedLayerId);
    if (sel) {
      const factor = e.deltaY > 0 ? 0.95 : 1.05;
      sel.transform.scale = Math.min(8, Math.max(0.02, sel.transform.scale * factor));
      document.dispatchEvent(new CustomEvent('layer-transformed'));
      markDirty();
      e.preventDefault();
    }
  }
}

export function initCanvasUI(): void {
  mainCanvas.addEventListener('pointerdown', onPointerDown);
  mainCanvas.addEventListener('pointermove', onPointerMove);
  mainCanvas.addEventListener('pointerup', onPointerUp);
  mainCanvas.addEventListener('pointercancel', onPointerUp);
  mainCanvas.addEventListener('pointerleave', () => {
    state.brushCursor = null;
    markDirty();
  });
  mainCanvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.mode === 'edit' && state.selectedLayerId) {
        document.dispatchEvent(new CustomEvent('layer-delete-request'));
      }
    }
  });
}
