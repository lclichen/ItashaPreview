import type { Layer, ViewTransform } from './types';
import { IMG_W, IMG_H, state, currentView, frameSrc, angleLabel, ORTHO_FRAME_1BASED, VIEW_ORDER, markDirty } from './state';
import { edgeOverlayCanvas } from './maskedit';

const mainCanvas = document.getElementById('mainCanvas') as HTMLCanvasElement;
const ctx = mainCanvas.getContext('2d')!;
const compCanvas = document.createElement('canvas');
compCanvas.width = IMG_W;
compCanvas.height = IMG_H;
const compCtx = compCanvas.getContext('2d')!;

let vt: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 };
let edgeOverlay: HTMLCanvasElement | null = null;
let edgeOverlayFor: string | null = null;

const hudAngle = document.getElementById('hudAngle')!;
const hudHint = document.getElementById('hudHint')!;
const orbitLabel = document.getElementById('orbitLabel')!;

function resizeCanvas(): void {
  const wrap = mainCanvas.parentElement!;
  const rect = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const bar = document.getElementById('orbitBar');
  const barH = bar ? bar.offsetHeight : 0;
  const w = Math.max(100, rect.width);
  const h = Math.max(100, rect.height - barH);
  if (mainCanvas.width !== Math.round(w * dpr) || mainCanvas.height !== Math.round(h * dpr)) {
    mainCanvas.width = Math.round(w * dpr);
    mainCanvas.height = Math.round(h * dpr);
    mainCanvas.style.width = `${w}px`;
    mainCanvas.style.height = `${h}px`;
    state.dirty = true;
  }
}

function computeFit(): void {
  const dpr = window.devicePixelRatio || 1;
  const cw = mainCanvas.width / dpr;
  const ch = mainCanvas.height / dpr;
  const scale = Math.min(cw / IMG_W, ch / IMG_H) * 0.94;
  vt = {
    scale,
    offsetX: (cw - IMG_W * scale) / 2,
    offsetY: (ch - IMG_H * scale) / 2,
  };
}

export function getViewTransform(): ViewTransform {
  return vt;
}

export function toImageSpace(clientX: number, clientY: number): { x: number; y: number } {
  const rect = mainCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  return {
    x: (cx - vt.offsetX) / vt.scale,
    y: (cy - vt.offsetY) / vt.scale,
  };
}

function drawLayerLocal(c: CanvasRenderingContext2D, layer: Layer): void {
  const img = layer.img;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const t = layer.transform;
  c.save();
  c.globalAlpha = layer.opacity;
  c.translate(t.x, t.y);
  c.rotate((t.rotation * Math.PI) / 180);
  c.scale(t.scale * (layer.flipX ? -1 : 1), t.scale);
  c.drawImage(img, -iw / 2, -ih / 2, iw, ih);
  c.restore();
}

function splitLayers(): { bg: Layer[]; top: Layer[] } {
  const layers = currentView().layers;
  const bg: Layer[] = [];
  const top: Layer[] = [];
  for (const l of layers) {
    if (l.kind === 'background') bg.push(l);
    else top.push(l);
  }
  return { bg, top };
}

function drawBgLayers(c: CanvasRenderingContext2D): void {
  const { bg } = splitLayers();
  for (const l of bg) {
    if (l.visible) drawLayerLocal(c, l);
  }
}

function drawTopLayers(c: CanvasRenderingContext2D, view: ReturnType<typeof currentView>): void {
  const { top } = splitLayers();
  const vis = top.filter((l) => l.visible);
  if (vis.length === 0) return;
  compCtx.clearRect(0, 0, IMG_W, IMG_H);
  for (const l of vis) drawLayerLocal(compCtx, l);
  const clipped = vis.filter((l) => l.clipToMask);
  if (clipped.length > 0 && view.mask) {
    compCtx.save();
    compCtx.globalCompositeOperation = 'destination-in';
    compCtx.drawImage(view.mask, 0, 0);
    compCtx.restore();
  }
  c.drawImage(compCanvas, 0, 0);
}

function drawCarFrame(c: CanvasRenderingContext2D, idx0: number, dim = false): void {
  const img = state.frames[idx0] ?? state.frames[ORTHO_FRAME_1BASED[state.currentView] - 1];
  if (!img) return;
  if (dim) {
    c.save();
    c.filter = 'brightness(0.45)';
    c.drawImage(img, 0, 0, IMG_W, IMG_H);
    c.restore();
  } else {
    c.drawImage(img, 0, 0, IMG_W, IMG_H);
  }
}

function drawMaskOverlay(c: CanvasRenderingContext2D): void {
  const view = currentView();
  if (!view.mask) return;
  c.save();
  c.globalAlpha = 0.42;
  c.drawImage(view.mask, 0, 0);
  c.restore();
  c.save();
  c.globalAlpha = 0.9;
  c.globalCompositeOperation = 'lighter';
  c.drawImage(view.mask, 0, 0);
  c.restore();
}

function ensureEdgeOverlay(): void {
  const img = state.frames[ORTHO_FRAME_1BASED[state.currentView] - 1];
  if (!img) return;
  if (edgeOverlay && edgeOverlayFor === state.currentView) return;
  edgeOverlay = edgeOverlayCanvas(img);
  edgeOverlayFor = state.currentView;
}

function drawEdgeOverlay(c: CanvasRenderingContext2D): void {
  ensureEdgeOverlay();
  if (!edgeOverlay) return;
  c.save();
  c.globalAlpha = 0.85;
  c.drawImage(edgeOverlay, 0, 0);
  c.restore();
}

function drawSelection(c: CanvasRenderingContext2D): void {
  const view = currentView();
  const layer = view.layers.find((l) => l.id === state.selectedLayerId);
  if (!layer) return;
  const t = layer.transform;
  const iw = (layer.img.naturalWidth || layer.img.width) * t.scale;
  const ih = (layer.img.naturalHeight || layer.img.height) * t.scale;
  c.save();
  c.translate(t.x, t.y);
  c.rotate((t.rotation * Math.PI) / 180);
  c.strokeStyle = '#7c8cff';
  c.lineWidth = 2 / vt.scale;
  c.setLineDash([6 / vt.scale, 4 / vt.scale]);
  c.strokeRect(-iw / 2, -ih / 2, iw, ih);
  c.setLineDash([]);
  const hs = 9 / vt.scale;
  c.fillStyle = '#fff';
  c.strokeStyle = '#7c8cff';
  for (const [hx, hy] of cornerPoints(iw, ih)) {
    c.beginPath();
    c.arc(hx, hy, hs / 2, 0, Math.PI * 2);
    c.fill();
    c.stroke();
  }
  const [rx, ry] = rotateHandlePoint(ih);
  c.strokeStyle = '#9a6cff';
  c.beginPath();
  c.moveTo(0, -ih / 2);
  c.lineTo(rx, ry);
  c.stroke();
  c.fillStyle = '#9a6cff';
  c.beginPath();
  c.arc(rx, ry, hs / 2 + 2 / vt.scale, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

export function cornerPoints(iw: number, ih: number): [number, number][] {
  return [
    [-iw / 2, -ih / 2],
    [iw / 2, -ih / 2],
    [iw / 2, ih / 2],
    [-iw / 2, ih / 2],
  ];
}

export function rotateHandlePoint(ih: number): [number, number] {
  return [0, -ih / 2 - 30 / 1];
}

function renderOrbit(c: CanvasRenderingContext2D): void {
  drawBgLayers(c);
  drawCarFrame(c, state.orbitFrame);
}

function renderEdit(c: CanvasRenderingContext2D): void {
  const view = currentView();
  drawBgLayers(c);
  drawCarFrame(c, ORTHO_FRAME_1BASED[state.currentView] - 1);
  drawTopLayers(c, view);
  drawSelection(c);
}

function renderMask(c: CanvasRenderingContext2D): void {
  drawCarFrame(c, ORTHO_FRAME_1BASED[state.currentView] - 1, true);
  drawMaskOverlay(c);
  if (state.showEdgeOverlay) drawEdgeOverlay(c);
  if (state.brushCursor && state.maskTool !== 'wand') {
    c.save();
    c.beginPath();
    c.arc(state.brushCursor.x, state.brushCursor.y, state.brushSize / 2, 0, Math.PI * 2);
    c.strokeStyle = state.maskTool === 'eraser' ? '#ff6b6b' : '#4cd6a5';
    c.lineWidth = 1.5 / vt.scale;
    c.stroke();
    c.restore();
  }
}

export function render(): void {
  resizeCanvas();
  if (!state.dirty) return;
  computeFit();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
  ctx.save();
  ctx.translate(vt.offsetX, vt.offsetY);
  ctx.scale(vt.scale, vt.scale);
  ctx.imageSmoothingQuality = 'high';
  if (state.mode === 'orbit') renderOrbit(ctx);
  else if (state.mode === 'edit') renderEdit(ctx);
  else renderMask(ctx);
  ctx.restore();
  state.dirty = false;
  updateHud();
}

function updateHud(): void {
  const viewNames = { front: '正前', right: '正右', rear: '正后', left: '左侧' } as const;
  if (state.mode === 'orbit') {
    hudAngle.textContent = `360 预览 · ${angleLabel(state.orbitFrame)}`;
    hudHint.textContent = '底部滑条切换角度，四个正交视角可点击顶部标签进入编辑';
    orbitLabel.textContent = `帧 ${String(state.orbitFrame + 1).padStart(2, '0')} · ${angleLabel(state.orbitFrame)}`;
  } else {
    hudAngle.textContent = `编辑中 · ${viewNames[state.currentView]}`;
    hudHint.textContent =
      state.mode === 'mask' ? '遮罩编辑模式：画笔 / 橡皮 / 魔棒' : '拖动移动图层，角柄缩放，顶部紫柄旋转';
    orbitLabel.textContent = `${viewNames[state.currentView]} 视图`;
  }
}

export function invalidateEdgeOverlay(): void {
  edgeOverlay = null;
  edgeOverlayFor = null;
  markDirty();
}

let rafId = 0;
export function startLoop(): void {
  const tick = (): void => {
    render();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

export function stopLoop(): void {
  cancelAnimationFrame(rafId);
}

export { mainCanvas, ctx as mainCtx };
