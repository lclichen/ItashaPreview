import { state, currentView, markDirty, loadImg, makeLayer, duplicateLayer, findLayer, VIEW_ORDER, VIEW_LABEL, ORTHO_FRAME_1BASED, FRAMES, IMG_W, IMG_H, angleLabel } from './state';
import { autoMaskFromEdges, autoMaskFromAlpha, invertMaskCanvas, clearMaskCanvas, refineMaskExcludeDarkParts, chromaKeyCutout } from './maskedit';
import { getRemoveBgKey, setRemoveBgKey, removeBgBlob, removeBgLocal, queryCredits, layerImageToBlob, blobToImage, canvasToImage } from './removebg';
import { clearAll, exportProject, importProject } from './store';
import { commitAddLayer, commitRemoveLayer, commitMoveLayer, commitLayerProps, commitTransform, commitQuad, commitViewsSnapshot, runMaskMutation, undo, redo, canUndo, canRedo, snapshotView, copyCanvas, clearHistory } from './history';
import type { Transform, Quad } from './types';
import { invalidateEdgeOverlay, toImageSpace, drawStack, drawLayerOnly } from './render';
import { quadFromTransform } from './quad';
import { CAR_ID } from './carlayer';
import type { Layer, LayerKind, ViewKey } from './types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const fileInput = $('fileInput') as HTMLInputElement;
let pendingKind: LayerKind = 'art';

function toast(msg: string, isError = false): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  window.clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => el.classList.remove('show'), 2200);
}

const OPPOSITE_VIEW: Record<ViewKey, ViewKey> = { front: 'rear', rear: 'front', left: 'right', right: 'left' };

function kindLabel(kind: LayerKind): string {
  return kind === 'background' ? '背景' : kind === 'art' ? '立绘' : kind === 'car' ? '车体' : '拉花';
}

function ensureMask(viewKey: ViewKey, force = false): void {
  const view = state.views[viewKey];
  const frameImg = state.frames[ORTHO_FRAME_1BASED[viewKey] - 1];
  if (!frameImg) return;
  if (view.mask && !force) return;
  const base = autoMaskFromEdges(frameImg);
  const created = refineMaskExcludeDarkParts(frameImg, base, state.wheelSensitivity);
  if (!view.mask) {
    view.mask = document.createElement('canvas');
    view.mask.width = 1200;
    view.mask.height = 800;
  }
  const mctx = view.mask.getContext('2d')!;
  mctx.clearRect(0, 0, 1200, 800);
  mctx.drawImage(created, 0, 0);
  view.maskTouched = true;
  invalidateEdgeOverlay();
  markDirty();
}

function uploadLayer(kind: LayerKind): void {
  pendingKind = kind;
  fileInput.value = '';
  fileInput.click();
}

async function onFileChosen(): Promise<void> {
  const file = fileInput.files?.[0];
  if (!file) return;
  const src = URL.createObjectURL(file);
  try {
    const img = await loadImg(src);
    const layer = makeLayer(pendingKind, img, file.name.replace(/\.[^.]+$/, ''));
    const layers = currentView().layers;
    const carIdx = layers.findIndex((l) => l.kind === 'car');
    const idx = pendingKind === 'background' && carIdx >= 0 ? carIdx : layers.length;
    layers.splice(idx, 0, layer);
    commitAddLayer(state.currentView, layer, idx);
    state.selectedLayerId = layer.id;
    renderLayerList();
    refreshProps();
    markDirty();
    toast(`已添加${kindLabel(pendingKind)}「${layer.name}」`);
  } catch (err) {
    toast('图片加载失败', true);
  }
}

function deleteLayerById(id: string): void {
  const view = currentView();
  const idx = view.layers.findIndex((l) => l.id === id);
  if (idx < 0) return;
  const layer = view.layers[idx];
  const wasSelected = state.selectedLayerId === id;
  commitRemoveLayer(state.currentView, layer, idx, wasSelected);
  view.layers.splice(idx, 1);
  if (state.selectedLayerId === id) state.selectedLayerId = null;
  renderLayerList();
  refreshProps();
  markDirty();
}

function moveLayer(id: string, dir: -1 | 1): void {
  const view = currentView();
  const idx = view.layers.findIndex((l) => l.id === id);
  if (idx < 0) return;
  const j = idx + dir;
  if (j < 0 || j >= view.layers.length) return;
  const layer = view.layers[idx];
  if (layer.kind === 'car') return;
  view.layers.splice(idx, 1);
  view.layers.splice(j, 0, layer);
  commitMoveLayer(state.currentView, layer, idx, j);
  renderLayerList();
  markDirty();
}

let dragLayerId: string | null = null;
let dropTargetId: string | null = null;
let dropAbove = true;
let clipboardLayer: Layer | null = null;

function clearDropMarkers(): void {
  const ul = $('layerList') as HTMLUListElement;
  ul.querySelectorAll('.drop-top, .drop-bottom').forEach((el) => el.classList.remove('drop-top', 'drop-bottom'));
}

function performLayerDrop(): void {
  const view = currentView();
  const layer = dragLayerId ? view.layers.find((l) => l.id === dragLayerId) : null;
  const target = dropTargetId ? view.layers.find((l) => l.id === dropTargetId) : null;
  clearDropMarkers();
  if (!layer || !target || layer === target || layer.kind === 'car') return;
  const from = view.layers.indexOf(layer);
  let to = view.layers.indexOf(target) + (dropAbove ? 1 : 0);
  view.layers.splice(from, 1);
  if (from < to) to -= 1;
  if (to === from) {
    view.layers.splice(from, 0, layer);
    return;
  }
  view.layers.splice(to, 0, layer);
  commitMoveLayer(state.currentView, layer, from, to);
  renderLayerList();
  markDirty();
}

function selectedEditableLayer(): Layer | null {
  const l = state.selectedLayerId ? currentView().layers.find((x) => x.id === state.selectedLayerId) : null;
  if (!l || l.kind === 'car') return null;
  return l;
}

function insertLayerCopy(src: Layer, offset: number): void {
  const view = currentView();
  const srcIdx = view.layers.indexOf(src);
  const idx = srcIdx >= 0 ? srcIdx + 1 : view.layers.length;
  const layer = duplicateLayer(src);
  layer.transform.x += offset;
  layer.transform.y += offset;
  view.layers.splice(idx, 0, layer);
  commitAddLayer(state.currentView, layer, idx);
  state.selectedLayerId = layer.id;
  renderLayerList();
  refreshProps();
  markDirty();
}

function duplicateSelectedLayer(): void {
  const l = selectedEditableLayer();
  if (!l) return;
  insertLayerCopy(l, 24);
  toast(`已复制图层「${l.name}」`);
}

function pasteLayer(): void {
  if (!clipboardLayer) return;
  insertLayerCopy(clipboardLayer, 24);
  toast('已粘贴图层');
}

function nudgeSelectedLayer(dx: number, dy: number): void {
  const l = selectedEditableLayer();
  if (!l || l.locked) return;
  if (l.quad) {
    const before = l.quad.map((p) => ({ ...p })) as Quad;
    l.quad = l.quad.map((p) => ({ x: p.x + dx, y: p.y + dy })) as Quad;
    commitQuad(state.currentView, l.id, before, l.quad.map((p) => ({ ...p })) as Quad);
    document.dispatchEvent(new CustomEvent('layer-transformed'));
    markDirty();
    return;
  }
  const before = { ...l.transform };
  l.transform.x += dx;
  l.transform.y += dy;
  commitTransform(state.currentView, l.id, before, { ...l.transform });
  document.dispatchEvent(new CustomEvent('layer-transformed'));
  markDirty();
}

function renderLayerList(): void {
  const view = currentView();
  const ul = $('layerList') as HTMLUListElement;
  ul.innerHTML = '';
  const carFrame = state.frames[ORTHO_FRAME_1BASED[state.currentView] - 1];
  for (let i = view.layers.length - 1; i >= 0; i--) {
    const l = view.layers[i];
    const li = document.createElement('li');
    const isCar = l.kind === 'car';
    li.className = 'layer-item' + (isCar ? ' car' : '') + (l.locked ? ' locked' : '') + (l.id === state.selectedLayerId ? ' selected' : '');
    li.dataset.layerId = l.id;
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const timg = document.createElement('img');
    timg.src = isCar ? (carFrame ? carFrame.src : '') : l.img.src;
    timg.draggable = false;
    thumb.appendChild(timg);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = l.name;
    name.title = isCar ? '' : '双击重命名';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = isCar ? '车体' : kindLabel(l.kind);
    li.append(thumb, name, kind);
    if (isCar) {
      ul.appendChild(li);
      continue;
    }
    li.draggable = true;
    name.ondblclick = (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'rename-input';
      input.value = l.name;
      let done = false;
      const finish = (save: boolean) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (save && v && v !== l.name) {
          const before = l.name;
          l.name = v;
          commitLayerProps(state.currentView, l.id, { name: before }, { name: v }, '重命名图层');
          markDirty();
        }
        renderLayerList();
      };
      input.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') finish(true);
        else if (ev.key === 'Escape') finish(false);
      };
      input.onblur = () => finish(true);
      input.onclick = (ev) => ev.stopPropagation();
      input.ondblclick = (ev) => ev.stopPropagation();
      name.replaceWith(input);
      input.focus();
      input.select();
    };
    const lock = document.createElement('button');
    lock.className = 'lock' + (l.locked ? ' on' : '');
    lock.textContent = l.locked ? '锁' : '解';
    lock.title = l.locked ? '解锁图层' : '锁定图层（禁止移动与编辑）';
    lock.onclick = (e) => {
      e.stopPropagation();
      const before = l.locked;
      l.locked = !l.locked;
      commitLayerProps(state.currentView, l.id, { locked: before }, { locked: l.locked }, '锁定图层');
      renderLayerList();
      refreshProps();
      markDirty();
    };
    const eye = document.createElement('button');
    eye.className = 'eye' + (l.visible ? '' : ' off');
    eye.textContent = l.visible ? '◉' : '○';
    eye.title = '显示 / 隐藏';
    eye.onclick = (e) => {
      e.stopPropagation();
      const before = l.visible;
      l.visible = !l.visible;
      commitLayerProps(state.currentView, l.id, { visible: before }, { visible: l.visible }, '切换显示');
      renderLayerList();
      markDirty();
    };
    const up = document.createElement('button');
    up.className = 'updown';
    up.textContent = '↑';
    up.title = '上移一层（更靠前）';
    up.onclick = (e) => {
      e.stopPropagation();
      moveLayer(l.id, 1);
    };
    const down = document.createElement('button');
    down.className = 'updown';
    down.textContent = '↓';
    down.title = '下移一层（更靠后）';
    down.onclick = (e) => {
      e.stopPropagation();
      moveLayer(l.id, -1);
    };
    li.append(up, down, lock, eye);
    li.onclick = () => {
      state.selectedLayerId = l.id;
      updateSelectionStyles();
      refreshProps();
      markDirty();
    };
    ul.appendChild(li);
  }
}

function updateSelectionStyles(): void {
  const ul = $('layerList') as HTMLUListElement;
  ul.querySelectorAll('.layer-item').forEach((el) => {
    el.classList.toggle('selected', (el as HTMLElement).dataset.layerId === state.selectedLayerId);
  });
}

function refreshProps(): void {
  const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
  const body = $('layerPropBody');
  const empty = $('noLayerSelected');
  if (!layer || layer.kind === 'car') {
    body.style.display = 'none';
    empty.style.display = '';
    return;
  }
  body.style.display = '';
  empty.style.display = 'none';
  ($('propOpacity') as HTMLInputElement).value = String(Math.round(layer.opacity * 100));
  $('propOpacityVal').textContent = String(Math.round(layer.opacity * 100));
  ($('propScale') as HTMLInputElement).value = String(Math.round(layer.transform.scale * 100));
  $('propScaleVal').textContent = String(Math.round(layer.transform.scale * 100));
  ($('propRotation') as HTMLInputElement).value = String(Math.round(layer.transform.rotation));
  $('propRotationVal').textContent = String(Math.round(layer.transform.rotation));
  ($('propClip') as HTMLInputElement).checked = layer.clipToMask;
  ($('propBlend') as HTMLSelectElement).value = layer.blend || 'source-over';
  const locked = !!layer.locked;
  for (const id of ['propOpacity', 'propScale', 'propRotation', 'propClip', 'propBlend', 'btnLayerFlip', 'btnLayerQuad', 'btnLayerUp', 'btnLayerDown', 'btnLayerDel']) {
    ($(id) as HTMLInputElement).disabled = locked;
  }
  const quadMode = !!layer.quad;
  $('btnLayerQuad').textContent = quadMode ? '退出透视' : '四角透视';
  $('btnLayerQuad').title = quadMode ? '恢复为矩形（保持当前位置）' : '拖动四角，让平面图贴合有角度的车面';
  if (quadMode) {
    ($('propScale') as HTMLInputElement).disabled = true;
    ($('propRotation') as HTMLInputElement).disabled = true;
    ($('propScale') as HTMLInputElement).title = '四角透视模式下不可用';
    ($('propRotation') as HTMLInputElement).title = '四角透视模式下不可用';
  } else {
    ($('propScale') as HTMLInputElement).title = '';
    ($('propRotation') as HTMLInputElement).title = '';
  }
  $('btnLayerRestore').style.display = layer.originalImg && !locked ? '' : 'none';
  $('btnLayerDup').style.display = '';
  $('btnLayerDel').title = locked ? '图层已锁定，请先解锁' : '删除图层';
}

function onLayerTransformed(): void {
  const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
  if (layer) {
    ($('propScale') as HTMLInputElement).value = String(Math.round(layer.transform.scale * 100));
    $('propScaleVal').textContent = String(Math.round(layer.transform.scale * 100));
    ($('propRotation') as HTMLInputElement).value = String(Math.round(layer.transform.rotation));
    $('propRotationVal').textContent = String(Math.round(layer.transform.rotation));
  }
}

function setMode(mode: 'orbit' | 'edit' | 'mask'): void {
  if (mode !== 'orbit') {
    const vk = state.currentView;
    const view = state.views[vk];
    if (!view.mask) {
      toast('正在生成初始遮罩…');
      ensureMask(vk);
      toast(`已为「${VIEW_LABEL[vk]}」生成遮罩，可用画笔 / 魔棒修正`);
    }
  }
  state.mode = mode;
  $('maskTools').style.display = mode === 'mask' ? '' : 'none';
  const btnMask = $('btnMaskMode');
  btnMask.textContent = mode === 'mask' ? '完成遮罩' : '遮罩编辑';
  btnMask.classList.toggle('active', mode === 'mask');
  $('btnEdgeOverlay').classList.toggle('active', state.showEdgeOverlay && mode === 'mask');
  document.querySelectorAll('.view-tab').forEach((el) => {
    const tab = el as HTMLButtonElement;
    const v = tab.dataset.view;
    tab.classList.toggle('active', v === (mode === 'orbit' ? 'orbit' : state.currentView));
  });
  markDirty();
}

function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function exportScale(): number {
  const v = Number(($('exportScale') as HTMLSelectElement).value);
  return v === 2 || v === 3 ? v : 1;
}

function exportPng(): void {
  const scale = exportScale();
  const skipCar = ($('exportNoCar') as HTMLInputElement).checked;
  const transparent = ($('exportTransparent') as HTMLInputElement).checked;
  const out = document.createElement('canvas');
  out.width = IMG_W * scale;
  out.height = IMG_H * scale;
  const ctx = out.getContext('2d')!;
  if (!transparent) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.scale(scale, scale);
  const view = currentView();
  const frameIdx = state.mode === 'orbit' ? state.orbitFrame : ORTHO_FRAME_1BASED[state.currentView] - 1;
  const frame = state.frames[frameIdx];
  if (!frame) return;
  drawStack(ctx, view, frameIdx, false, skipCar);
  const tag = state.mode === 'orbit' ? `orbit_${frameIdx + 1}` : state.currentView;
  out.toBlob((blob) => {
    if (!blob) return;
    downloadBlob(blob, `itasha_${tag}_${scale}x.png`);
    toast(`已导出 PNG（${out.width}×${out.height}）`);
  }, 'image/png');
}

function exportLayers(): void {
  const scale = exportScale();
  const view = currentView();
  const list = view.layers.filter((l) => l.kind !== 'car' && l.visible);
  if (list.length === 0) {
    toast('当前视角没有可导出的图层', true);
    return;
  }
  list.forEach((layer, i) => {
    setTimeout(() => {
      const out = document.createElement('canvas');
      out.width = IMG_W * scale;
      out.height = IMG_H * scale;
      const ctx = out.getContext('2d')!;
      ctx.scale(scale, scale);
      drawLayerOnly(ctx, layer, view.mask);
      out.toBlob((blob) => {
        if (!blob) return;
        const safe = layer.name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
        downloadBlob(blob, `itasha_${state.currentView}_${String(i + 1).padStart(2, '0')}_${safe}_${scale}x.png`);
      }, 'image/png');
    }, i * 400);
  });
  toast(`正在导出 ${list.length} 个图层（逐个下载）`);
}

function renderViewFrame(viewKey: ViewKey, frameIdx0: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = 1200;
  out.height = 800;
  const ctx = out.getContext('2d')!;
  const view = state.views[viewKey];
  const frame = state.frames[frameIdx0];
  if (!frame || !view) return out;
  drawStack(ctx, view, frameIdx0);
  return out;
}

function alphaBBox(c: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
  const { width: w, height: h } = c;
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 16) {
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

function exportMultiView(): void {
  const PAD = 60;
  const GAP = 36;
  const CONTENT_W = 1440;
  const bg = '#f4f4f6';
  const big = renderViewFrame('left', ORTHO_FRAME_1BASED.left - 1);
  const bigR = renderViewFrame('right', ORTHO_FRAME_1BASED.right - 1);
  const front = renderViewFrame('front', ORTHO_FRAME_1BASED.front - 1);
  const rear = renderViewFrame('rear', ORTHO_FRAME_1BASED.rear - 1);
  const bbL = alphaBBox(big);
  const bbR = alphaBBox(bigR);
  const bbF = alphaBBox(front);
  const bbRe = alphaBBox(rear);
  if (!bbL || !bbR || !bbF || !bbRe) {
    toast('请等待车图加载完成后再导出', true);
    return;
  }
  const fitH = (bb: { w: number; h: number }, targetW: number) => Math.max(1, Math.round((bb.h / bb.w) * targetW));
  const hL = fitH(bbL, CONTENT_W);
  const hR = fitH(bbR, CONTENT_W);
  const cellW = Math.floor((CONTENT_W - GAP) / 2);
  const hF = fitH(bbF, cellW);
  const hRe = fitH(bbRe, cellW);
  const hRow4 = Math.max(hF, hRe);
  const H = PAD + hL + GAP + hR + GAP + hRow4 + PAD;
  const out = document.createElement('canvas');
  out.width = CONTENT_W + PAD * 2;
  out.height = H;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(big, bbL.x, bbL.y, bbL.w, bbL.h, PAD, PAD, CONTENT_W, hL);
  ctx.drawImage(bigR, bbR.x, bbR.y, bbR.w, bbR.h, PAD, PAD + hL + GAP, CONTENT_W, hR);
  const y4 = PAD + hL + GAP + hR + GAP;
  ctx.drawImage(front, bbF.x, bbF.y, bbF.w, bbF.h, PAD, y4, cellW, hF);
  ctx.drawImage(rear, bbRe.x, bbRe.y, bbRe.w, bbRe.h, PAD + cellW + GAP, y4, cellW, hRe);
  out.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'itasha_multiview.png';
    a.click();
    toast('已导出多视图海报');
  });
}

export function refreshLayersUI(): void {
  renderLayerList();
  refreshProps();
}

export function initUI(): void {
  const savedKey = getRemoveBgKey();
  if (savedKey) ($('removeBgKey') as HTMLInputElement).value = savedKey;
  fileInput.addEventListener('change', onFileChosen);

  document.querySelectorAll('.view-tab').forEach((el) => {
    el.addEventListener('click', () => {
      const v = (el as HTMLElement).dataset.view;
      if (v === 'orbit') {
        setMode('orbit');
      } else {
        state.currentView = v as ViewKey;
        state.orbitFrame = ORTHO_FRAME_1BASED[v as ViewKey] - 1;
        ($('orbitSlider') as HTMLInputElement).value = String(state.orbitFrame);
        ($('maskCopyTarget') as HTMLSelectElement).value = OPPOSITE_VIEW[v as ViewKey];
        setMode('edit');
        renderLayerList();
        refreshProps();
      }
    });
  });

  $('btnMaskMode').addEventListener('click', () => {
    setMode(state.mode === 'mask' ? 'edit' : 'mask');
  });
  $('btnEdgeOverlay').addEventListener('click', () => {
    state.showEdgeOverlay = !state.showEdgeOverlay;
    $('btnEdgeOverlay').classList.toggle('active', state.showEdgeOverlay);
    invalidateEdgeOverlay();
  });

  const toolBtns = document.querySelectorAll('#maskTools [data-tool]');
  const wandModeRow = $('wandModeRow');
  toolBtns.forEach((el) => {
    el.addEventListener('click', () => {
      toolBtns.forEach((t) => t.classList.remove('active'));
      el.classList.add('active');
      state.maskTool = (el as HTMLElement).dataset.tool as 'brush' | 'eraser' | 'wand';
      wandModeRow.style.display = state.maskTool === 'wand' ? '' : 'none';
      markDirty();
    });
  });
  const wmodeBtns = document.querySelectorAll('#wandModeRow [data-wmode]');
  wmodeBtns.forEach((el) => {
    el.addEventListener('click', () => {
      wmodeBtns.forEach((t) => t.classList.remove('active'));
      el.classList.add('active');
      state.wandMode = (el as HTMLElement).dataset.wmode as 'add' | 'subtract';
    });
  });

  const bindSlider = (id: string, valId: string, fn: (v: number) => void) => {
    $(id).addEventListener('input', () => {
      const v = Number(($(id) as HTMLInputElement).value);
      $(valId).textContent = String(v);
      fn(v);
      markDirty();
    });
  };
  bindSlider('brushSize', 'brushSizeVal', (v) => (state.brushSize = v));
  bindSlider('wandTolerance', 'wandToleranceVal', (v) => (state.wandTolerance = v));
  bindSlider('wheelSensitivity', 'wheelSensitivityVal', (v) => (state.wheelSensitivity = v));

  $('btnAutoEdge').addEventListener('click', () => {
    runMaskMutation(state.currentView, '重新生成遮罩', () => ensureMask(state.currentView, true));
    invalidateEdgeOverlay();
    toast('已重新生成遮罩（Sobel 边缘检测 + 剔除车轮 / 深色部件）');
  });
  $('btnAutoAlpha').addEventListener('click', () => {
    const view = currentView();
    const frameImg = state.frames[ORTHO_FRAME_1BASED[state.currentView] - 1];
    if (!frameImg) return;
    runMaskMutation(state.currentView, 'Alpha 生成遮罩', () => {
      if (!view.mask) {
        view.mask = document.createElement('canvas');
        view.mask.width = 1200;
        view.mask.height = 800;
      }
      const mctx = view.mask.getContext('2d')!;
      mctx.clearRect(0, 0, 1200, 800);
      mctx.drawImage(autoMaskFromAlpha(frameImg), 0, 0);
      view.maskTouched = true;
    });
    markDirty();
    toast('已用 Alpha 通道生成遮罩');
  });
  $('btnMaskClear').addEventListener('click', () => {
    const view = currentView();
    if (view.mask) {
      runMaskMutation(state.currentView, '清空遮罩', () => clearMaskCanvas(view.mask!));
      markDirty();
    }
  });
  $('btnMaskInvert').addEventListener('click', () => {
    const view = currentView();
    if (view.mask) {
      runMaskMutation(state.currentView, '反相遮罩', () => invertMaskCanvas(view.mask!));
      markDirty();
    }
  });
  const maskTargetSel = $('maskCopyTarget') as HTMLSelectElement;
  for (const vk of VIEW_ORDER) {
    const opt = document.createElement('option');
    opt.value = vk;
    opt.textContent = VIEW_LABEL[vk];
    maskTargetSel.appendChild(opt);
  }
  maskTargetSel.value = OPPOSITE_VIEW[state.currentView];
  $('btnMaskMirror').addEventListener('click', () => {
    const view = currentView();
    if (!view.mask) {
      toast('当前视角还没有遮罩', true);
      return;
    }
    runMaskMutation(state.currentView, '水平镜像遮罩', () => {
      const src = copyCanvas(view.mask!);
      const mctx = view.mask!.getContext('2d')!;
      mctx.clearRect(0, 0, IMG_W, IMG_H);
      mctx.save();
      mctx.translate(IMG_W, 0);
      mctx.scale(-1, 1);
      mctx.drawImage(src, 0, 0);
      mctx.restore();
      view.maskTouched = true;
    });
    markDirty();
    toast('遮罩已水平镜像');
  });
  $('btnMaskCopy').addEventListener('click', () => {
    const srcKey = state.currentView;
    const srcView = state.views[srcKey];
    if (!srcView.mask) {
      toast('当前视角还没有遮罩', true);
      return;
    }
    const target = maskTargetSel.value as ViewKey;
    if (target === srcKey) {
      toast('目标视角与当前视角相同', true);
      return;
    }
    const mirror = ($('maskCopyMirror') as HTMLInputElement).checked;
    const before = {
      [srcKey]: snapshotView(srcKey),
      [target]: snapshotView(target),
    } as Record<string, ReturnType<typeof snapshotView>>;
    const tmp = document.createElement('canvas');
    tmp.width = IMG_W;
    tmp.height = IMG_H;
    const tmpCtx = tmp.getContext('2d')!;
    if (mirror) {
      tmpCtx.translate(IMG_W, 0);
      tmpCtx.scale(-1, 1);
    }
    tmpCtx.drawImage(srcView.mask, 0, 0);
    const tv = state.views[target];
    if (!tv.mask) {
      tv.mask = document.createElement('canvas');
      tv.mask.width = IMG_W;
      tv.mask.height = IMG_H;
    }
    const tctx = tv.mask.getContext('2d')!;
    tctx.clearRect(0, 0, IMG_W, IMG_H);
    tctx.drawImage(tmp, 0, 0);
    tv.maskTouched = true;
    commitViewsSnapshot(`复制遮罩到${VIEW_LABEL[target]}`, [srcKey, target], before);
    markDirty();
    toast(`已把遮罩复制到${VIEW_LABEL[target]}${mirror ? '（水平镜像）' : ''}`);
  });
  $('btnMaskDone').addEventListener('click', () => setMode('edit'));

  $('btnAddBg').addEventListener('click', () => uploadLayer('background'));
  $('btnAddArt').addEventListener('click', () => uploadLayer('art'));
  $('btnAddLivery').addEventListener('click', () => uploadLayer('livery'));

  $('btnSyncLayers').addEventListener('click', () => {
    const src = currentView();
    const srcView = state.currentView;
    const before = {} as Record<string, ReturnType<typeof snapshotView>>;
    for (const vk of VIEW_ORDER) before[vk] = snapshotView(vk);
    for (const vk of VIEW_ORDER) {
      if (vk === srcView) continue;
      const view = state.views[vk];
      view.layers = src.layers.map((l) => ({ ...l, transform: { ...l.transform } }));
      if (!view.mask) {
        const frameImg = state.frames[ORTHO_FRAME_1BASED[vk] - 1];
        if (frameImg) {
          const base = autoMaskFromEdges(frameImg);
          const created = refineMaskExcludeDarkParts(frameImg, base, state.wheelSensitivity);
          view.mask = document.createElement('canvas');
          view.mask.width = 1200;
          view.mask.height = 800;
          view.mask.getContext('2d')!.drawImage(created, 0, 0);
          view.maskTouched = true;
        }
      }
    }
    commitViewsSnapshot('同步图层到全部视角', [...VIEW_ORDER], before);
    toast('已同步图层与遮罩到全部视角');
  });

  $('btnClearCache').addEventListener('click', async () => {
    try {
      await clearAll();
      toast('缓存已清空，即将刷新页面');
      setTimeout(() => location.reload(), 600);
    } catch {
      toast('清空缓存失败', true);
    }
  });

  $('btnSaveKey').addEventListener('click', () => {
    const val = ($('removeBgKey') as HTMLInputElement).value.trim();
    setRemoveBgKey(val);
    toast(val ? 'API Key 已保存到本地浏览器' : 'API Key 已清除');
  });
  $('btnQueryCredits').addEventListener('click', async () => {
    const key = getRemoveBgKey();
    if (!key) {
      toast('请先填写并保存 API Key', true);
      return;
    }
    const info = $('creditsInfo');
    info.textContent = '查询中…';
    const credits = await queryCredits(key);
    info.textContent = credits === null ? '查询失败，请检查 Key 是否正确' : `账户剩余可用额度：${credits} 次`;
  });

  $('btnLayerQuickCut').addEventListener('click', async () => {
    const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
    if (!layer) {
      toast('请先选中一个图层', true);
      return;
    }
    try {
      const cut = chromaKeyCutout(layer.img, state.quickTol);
      const newImg = await canvasToImage(cut);
      const before = { img: layer.img, name: layer.name, originalImg: layer.originalImg };
      if (!layer.originalImg) layer.originalImg = layer.img;
      layer.img = newImg;
      layer.name = `${layer.name} (已抠图)`;
      commitLayerProps(state.currentView, layer.id, before, { img: layer.img, name: layer.name, originalImg: layer.originalImg }, '抠图');
      renderLayerList();
      refreshProps();
      markDirty();
      toast('快速抠图完成，效果不佳可调整容差后重试');
    } catch (err) {
      toast(`快速抠图失败：${err instanceof Error ? err.message : '未知错误'}`, true);
    }
  });

  $('quickTol').addEventListener('input', (e) => {
    state.quickTol = Number((e.target as HTMLInputElement).value);
    $('quickTolVal').textContent = String(state.quickTol);
  });

  $('btnLayerRemoveBg').addEventListener('click', async () => {
    const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
    if (!layer) {
      toast('请先选中一个图层', true);
      return;
    }
    const key = getRemoveBgKey();
    if (!key) {
      toast('请先在「AI 抠图」区填写并保存 remove.bg API Key', true);
      return;
    }
    toast('正在调用 remove.bg 抠图…');
    try {
      const srcBlob = await layerImageToBlob(layer.img);
      const outBlob = await removeBgBlob(srcBlob, key);
      const newImg = await blobToImage(outBlob);
      const before = { img: layer.img, name: layer.name, originalImg: layer.originalImg };
      if (!layer.originalImg) layer.originalImg = layer.img;
      layer.img = newImg;
      layer.name = `${layer.name} (已抠图)`;
      commitLayerProps(state.currentView, layer.id, before, { img: layer.img, name: layer.name, originalImg: layer.originalImg }, '抠图');
      renderLayerList();
      refreshProps();
      markDirty();
      toast('抠图完成，图层已替换为透明底');
    } catch (err) {
      toast(`抠图失败：${err instanceof Error ? err.message : '未知错误'}`, true);
    }
  });

  $('btnLayerRemoveBgLocal').addEventListener('click', async () => {
    const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
    if (!layer) {
      toast('请先选中一个图层', true);
      return;
    }
    const btn = $('btnLayerRemoveBgLocal') as HTMLButtonElement;
    btn.disabled = true;
    toast('本地模型加载中，首次需下载约 180MB（高精度版）…');
    const onProg = (e: Event) => {
      const pct = (e as CustomEvent<number>).detail;
      toast(`模型下载中 ${pct}%`);
    };
    document.addEventListener('local-rmbg-progress', onProg);
    try {
      const srcBlob = await layerImageToBlob(layer.img);
      const outBlob = await removeBgLocal(srcBlob);
      const newImg = await blobToImage(outBlob);
      const before = { img: layer.img, name: layer.name, originalImg: layer.originalImg };
      if (!layer.originalImg) layer.originalImg = layer.img;
      layer.img = newImg;
      layer.name = `${layer.name} (已抠图)`;
      commitLayerProps(state.currentView, layer.id, before, { img: layer.img, name: layer.name, originalImg: layer.originalImg }, '抠图');
      renderLayerList();
      refreshProps();
      markDirty();
      toast('本地抠图完成');
    } catch (err) {
      toast(`本地抠图失败：${err instanceof Error ? err.message : '未知错误'}`, true);
    } finally {
      document.removeEventListener('local-rmbg-progress', onProg);
      btn.disabled = false;
    }
  });

  $('btnExport').addEventListener('click', exportPng);
  $('btnExportMulti').addEventListener('click', exportMultiView);
  $('btnExportLayers').addEventListener('click', exportLayers);

  const projectInput = $('projectInput') as HTMLInputElement;
  $('btnExportProject').addEventListener('click', async () => {
    try {
      const blob = await exportProject(state.views);
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      const name = `itasha-project-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
      downloadBlob(blob, name);
      toast('工程已导出（含四视角图层与遮罩）');
    } catch (e) {
      toast(`导出失败：${e instanceof Error ? e.message : '未知错误'}`, true);
    }
  });
  $('btnImportProject').addEventListener('click', () => {
    projectInput.value = '';
    projectInput.click();
  });
  projectInput.addEventListener('change', async () => {
    const file = projectInput.files?.[0];
    if (!file) return;
    try {
      const data = await importProject(file);
      for (const vk of VIEW_ORDER) {
        state.views[vk].layers = data[vk].layers;
        state.views[vk].mask = data[vk].mask;
        state.views[vk].maskTouched = !!data[vk].mask;
      }
      state.selectedLayerId = null;
      clearHistory();
      invalidateEdgeOverlay();
      markDirty();
      refreshLayersUI();
      refreshProps();
      toast('工程已导入');
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : '未知错误'}`, true);
    } finally {
      projectInput.value = '';
    }
  });

  const refreshHistoryButtons = () => {
    ($('btnUndo') as HTMLButtonElement).disabled = !canUndo();
    ($('btnRedo') as HTMLButtonElement).disabled = !canRedo();
  };
  refreshHistoryButtons();
  document.addEventListener('history-state', refreshHistoryButtons);
  document.addEventListener('history-applied', () => {
    renderLayerList();
    refreshProps();
    markDirty();
  });
  $('btnUndo').addEventListener('click', () => undo());
  $('btnRedo').addEventListener('click', () => redo());
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    if (e.key.toLowerCase() === 'z' && !e.shiftKey && !typing) {
      e.preventDefault();
      undo();
    } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
      if (!typing) {
        e.preventDefault();
        redo();
      }
    } else if (e.key.toLowerCase() === 'd' && !typing) {
      e.preventDefault();
      duplicateSelectedLayer();
    } else if (e.key.toLowerCase() === 'c' && !typing) {
      const l = selectedEditableLayer();
      if (l) {
        clipboardLayer = { ...l, transform: { ...l.transform } };
        toast(`已复制图层「${l.name}」`);
      }
    } else if (e.key.toLowerCase() === 'v' && !typing) {
      if (clipboardLayer) {
        e.preventDefault();
        pasteLayer();
      }
    }
  });

  $('btnPlay').addEventListener('click', () => {
    state.playing = !state.playing;
    $('btnPlay').textContent = state.playing ? '暂停' : '播放';
    $('btnPlay').classList.toggle('active', state.playing);
  });

  ($('orbitSlider') as HTMLInputElement).addEventListener('input', () => {
    state.orbitFrame = Number(($('orbitSlider') as HTMLInputElement).value);
    markDirty();
  });

  const propBind = (id: string, valId: string, snapKey: 'opacity' | 'transform', fn: (layer: Layer, v: number) => void) => {
    let snap: Partial<Layer> | null = null;
    const grab = () => {
      const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
      if (!layer) return;
      snap = snapKey === 'opacity' ? { opacity: layer.opacity } : { transform: { ...layer.transform } };
    };
    $(id).addEventListener('pointerdown', grab);
    $(id).addEventListener('focus', grab);
    $(id).addEventListener('input', () => {
      const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
      if (!layer) return;
      const v = Number(($(id) as HTMLInputElement).value);
      $(valId).textContent = String(v);
      fn(layer, v);
      markDirty();
    });
    $(id).addEventListener('change', () => {
      const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
      if (!layer || !snap) {
        snap = null;
        return;
      }
      if (snapKey === 'opacity') {
        const before = snap as { opacity: number };
        const after = { opacity: layer.opacity };
        snap = null;
        if (before.opacity !== after.opacity) commitLayerProps(state.currentView, layer.id, before, after, '调整图层属性');
      } else {
        const before = snap as { transform: Transform };
        const after = { transform: { ...layer.transform } };
        snap = null;
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          commitTransform(state.currentView, layer.id, before.transform, after.transform);
        }
      }
    });
  };
  propBind('propOpacity', 'propOpacityVal', 'opacity', (l, v) => (l.opacity = v / 100));
  propBind('propScale', 'propScaleVal', 'transform', (l, v) => (l.transform.scale = v / 100));
  propBind('propRotation', 'propRotationVal', 'transform', (l, v) => (l.transform.rotation = v));
  $('propClip').addEventListener('change', () => {
    const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
    if (!layer) return;
    const before = layer.clipToMask;
    layer.clipToMask = ($('propClip') as HTMLInputElement).checked;
    commitLayerProps(state.currentView, layer.id, { clipToMask: before }, { clipToMask: layer.clipToMask }, '切换裁剪');
    markDirty();
  });
  $('propBlend').addEventListener('change', () => {
    const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
    if (!layer) return;
    const before = layer.blend || 'source-over';
    layer.blend = ($('propBlend') as HTMLSelectElement).value;
    commitLayerProps(state.currentView, layer.id, { blend: before }, { blend: layer.blend }, '混合模式');
    markDirty();
  });
  $('btnLayerDup').addEventListener('click', () => duplicateSelectedLayer());
  $('btnLayerUp').addEventListener('click', () => {
    if (state.selectedLayerId) moveLayer(state.selectedLayerId, 1);
  });
  $('btnLayerDown').addEventListener('click', () => {
    if (state.selectedLayerId) moveLayer(state.selectedLayerId, -1);
  });
  $('btnLayerDel').addEventListener('click', () => {
    if (state.selectedLayerId) deleteLayerById(state.selectedLayerId);
  });
  $('btnLayerQuad').addEventListener('click', () => {
    const layer = selectedEditableLayer();
    if (!layer || layer.locked) return;
    if (layer.quad) {
      const before = layer.quad.map((p) => ({ ...p })) as Quad;
      layer.quad = null;
      commitQuad(state.currentView, layer.id, before, null);
      toast('已退出四角透视');
    } else {
      const q = quadFromTransform(layer);
      layer.quad = q;
      commitQuad(state.currentView, layer.id, null, q);
      toast('拖动四个角点调整透视变形');
    }
    renderLayerList();
    refreshProps();
    markDirty();
  });
  $('btnLayerFlip').addEventListener('click', () => {
    const layer = selectedEditableLayer();
    if (!layer || layer.locked) return;
    if (layer.quad) {
      const before = layer.quad.map((p) => ({ ...p })) as Quad;
      const [tl, tr, br, bl] = layer.quad;
      layer.quad = [tr, tl, bl, br];
      commitQuad(state.currentView, layer.id, before, layer.quad.map((p) => ({ ...p })) as Quad);
      markDirty();
      toast('已水平翻转');
      return;
    }
    const before = layer.flipX;
    layer.flipX = !layer.flipX;
    commitLayerProps(state.currentView, layer.id, { flipX: before }, { flipX: layer.flipX }, '水平翻转');
    markDirty();
    toast(layer.flipX ? '已水平翻转' : '已恢复原方向');
  });
  $('btnLayerRestore').addEventListener('click', () => {
    const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
    if (!layer || !layer.originalImg) return;
    const before = { img: layer.img, name: layer.name, originalImg: layer.originalImg };
    layer.img = layer.originalImg;
    layer.originalImg = null;
    layer.name = layer.name.replace(' (已抠图)', '');
    commitLayerProps(state.currentView, layer.id, before, { img: layer.img, name: layer.name, originalImg: null }, '还原抠图');
    renderLayerList();
    refreshProps();
    markDirty();
    toast('已还原为原图');
  });
  window.addEventListener('keydown', (e) => {
    if (state.mode !== 'edit') return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedLayerId) {
      deleteLayerById(state.selectedLayerId);
      return;
    }
    if (e.key.startsWith('Arrow') && state.selectedLayerId && !e.ctrlKey && !e.metaKey) {
      const l = selectedEditableLayer();
      if (!l || l.locked) return;
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      nudgeSelectedLayer(dx, dy);
      e.preventDefault();
    }
  });

  const layerListEl = $('layerList') as HTMLUListElement;
  layerListEl.addEventListener('dragstart', (e) => {
    const li = (e.target as HTMLElement).closest('.layer-item') as HTMLElement | null;
    if (!li || li.classList.contains('car') || !li.dataset.layerId) {
      e.preventDefault();
      return;
    }
    dragLayerId = li.dataset.layerId;
    li.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', dragLayerId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  layerListEl.addEventListener('dragover', (e) => {
    if (!dragLayerId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const li = (e.target as HTMLElement).closest('.layer-item') as HTMLElement | null;
    clearDropMarkers();
    if (!li || !li.dataset.layerId || li.dataset.layerId === dragLayerId) return;
    const r = li.getBoundingClientRect();
    dropAbove = e.clientY < r.top + r.height / 2;
    dropTargetId = li.dataset.layerId;
    li.classList.add(dropAbove ? 'drop-top' : 'drop-bottom');
  });
  layerListEl.addEventListener('drop', (e) => {
    e.preventDefault();
    performLayerDrop();
  });
  layerListEl.addEventListener('dragend', () => {
    dragLayerId = null;
    dropTargetId = null;
    clearDropMarkers();
    layerListEl.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  });

  document.addEventListener('layer-selected', () => {
    renderLayerList();
    refreshProps();
  });
  document.addEventListener('layer-transformed', onLayerTransformed);
  document.addEventListener('layer-delete-request', () => {
    if (state.selectedLayerId) deleteLayerById(state.selectedLayerId);
  });
  document.addEventListener('orbit-changed', () => {
    ($('orbitSlider') as HTMLInputElement).value = String(state.orbitFrame);
  });
}

let playTimer = 0;
export function startAutoPlay(): void {
  playTimer = window.setInterval(() => {
    if (state.playing && state.mode === 'orbit') {
      state.orbitFrame = (state.orbitFrame + 1) % FRAMES;
      ($('orbitSlider') as HTMLInputElement).value = String(state.orbitFrame);
      markDirty();
    }
  }, 90);
}

export { toast, ensureMask, toImageSpace, angleLabel };
