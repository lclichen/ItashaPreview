import { state, currentView, markDirty, loadImg, makeLayer, findLayer, VIEW_ORDER, VIEW_LABEL, ORTHO_FRAME_1BASED, FRAMES, angleLabel } from './state';
import { autoMaskFromEdges, autoMaskFromAlpha, invertMaskCanvas, clearMaskCanvas, refineMaskExcludeDarkParts, chromaKeyCutout } from './maskedit';
import { getRemoveBgKey, setRemoveBgKey, removeBgBlob, removeBgLocal, queryCredits, layerImageToBlob, blobToImage, canvasToImage } from './removebg';
import { clearAll } from './store';
import { commitAddLayer, commitRemoveLayer, commitReorderLayer, commitLayerProps, commitTransform, commitViewsSnapshot, runMaskMutation, undo, redo, canUndo, canRedo, snapshotView } from './history';
import type { Transform } from './types';
import { invalidateEdgeOverlay, toImageSpace } from './render';
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

function kindLabel(kind: LayerKind): string {
  return kind === 'background' ? '背景' : kind === 'art' ? '立绘' : '拉花';
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
    currentView().layers.push(layer);
    commitAddLayer(state.currentView, layer, currentView().layers.length - 1);
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
  const sameGroup = view.layers.filter((l) => (l.kind === 'background') === (view.layers[idx].kind === 'background'));
  const groupIdx = sameGroup.indexOf(view.layers[idx]);
  const swapWith = sameGroup[groupIdx + dir];
  if (!swapWith) return;
  const j = view.layers.indexOf(swapWith);
  [view.layers[idx], view.layers[j]] = [view.layers[j], view.layers[idx]];
  commitReorderLayer(state.currentView, idx, j);
  renderLayerList();
  markDirty();
}

function renderLayerList(): void {
  const view = currentView();
  const topUl = $('layerListTop') as HTMLUListElement;
  const bgUl = $('layerListBg') as HTMLUListElement;
  topUl.innerHTML = '';
  bgUl.innerHTML = '';
  const topLayers = view.layers.filter((l) => l.kind !== 'background');
  const bgLayers = view.layers.filter((l) => l.kind === 'background');
  const fill = (ul: HTMLUListElement, layers: Layer[]) => {
    if (layers.length === 0) {
      const li = document.createElement('li');
      li.className = 'layer-empty';
      li.textContent = '（空）';
      ul.appendChild(li);
      return;
    }
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      const li = document.createElement('li');
      li.className = 'layer-item' + (l.id === state.selectedLayerId ? ' selected' : '');
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const timg = document.createElement('img');
      timg.src = l.img.src;
      thumb.appendChild(timg);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = l.name;
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = kindLabel(l.kind);
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
      li.append(thumb, name, kind, eye);
      li.onclick = () => {
        state.selectedLayerId = l.id;
        renderLayerList();
        refreshProps();
        markDirty();
      };
      ul.appendChild(li);
    }
  };
  fill(topUl, topLayers);
  fill(bgUl, bgLayers);
}

function refreshProps(): void {
  const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
  const body = $('layerPropBody');
  const empty = $('noLayerSelected');
  if (!layer) {
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
  $('btnLayerRestore').style.display = layer.originalImg ? '' : 'none';
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
      toast('正在生成初始遮罩（Sobel 边缘检测）…');
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

function exportPng(): void {
  const out = document.createElement('canvas');
  out.width = 1200;
  out.height = 800;
  const ctx = out.getContext('2d')!;
  const view = currentView();
  const frameIdx = state.mode === 'orbit' ? state.orbitFrame : ORTHO_FRAME_1BASED[state.currentView] - 1;
  const frame = state.frames[frameIdx];
  if (!frame) return;
  for (const l of view.layers) {
    if (l.kind === 'background' && l.visible) drawExportLayer(ctx, l, null);
  }
  ctx.drawImage(frame, 0, 0, 1200, 800);
  const clipLayers = view.layers.filter((l) => l.kind !== 'background' && l.visible && l.clipToMask && view.mask);
  const freeLayers = view.layers.filter((l) => l.kind !== 'background' && l.visible && !l.clipToMask);
  if (clipLayers.length > 0 && view.mask) {
    const comp = document.createElement('canvas');
    comp.width = 1200;
    comp.height = 800;
    const cctx = comp.getContext('2d')!;
    for (const l of clipLayers) drawExportLayer(cctx, l, null);
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(view.mask, 0, 0);
    cctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(comp, 0, 0);
  }
  for (const l of freeLayers) drawExportLayer(ctx, l, null);
  out.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `itasha_${state.mode === 'orbit' ? `orbit_${frameIdx + 1}` : state.currentView}.png`;
    a.click();
    toast('已导出 PNG');
  });
}

function drawExportLayer(ctx: CanvasRenderingContext2D, layer: Layer, _mask: null): void {
  const img = layer.img;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const t = layer.transform;
  ctx.save();
  ctx.globalAlpha = layer.opacity;
  ctx.translate(t.x, t.y);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(t.scale * (layer.flipX ? -1 : 1), t.scale);
  ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
  ctx.restore();
}

function renderViewFrame(viewKey: ViewKey, frameIdx0: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = 1200;
  out.height = 800;
  const ctx = out.getContext('2d')!;
  const view = state.views[viewKey];
  const frame = state.frames[frameIdx0];
  if (!frame || !view) return out;
  for (const l of view.layers) {
    if (l.kind === 'background' && l.visible) drawExportLayer(ctx, l, null);
  }
  ctx.drawImage(frame, 0, 0, 1200, 800);
  const clipLayers = view.layers.filter((l) => l.kind !== 'background' && l.visible && l.clipToMask && view.mask);
  const freeLayers = view.layers.filter((l) => l.kind !== 'background' && l.visible && !l.clipToMask);
  if (clipLayers.length > 0 && view.mask) {
    const comp = document.createElement('canvas');
    comp.width = 1200;
    comp.height = 800;
    const cctx = comp.getContext('2d')!;
    for (const l of clipLayers) drawExportLayer(cctx, l, null);
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(view.mask, 0, 0);
    cctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(comp, 0, 0);
  }
  for (const l of freeLayers) drawExportLayer(ctx, l, null);
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
  $('btnLayerUp').addEventListener('click', () => {
    if (state.selectedLayerId) moveLayer(state.selectedLayerId, 1);
  });
  $('btnLayerDown').addEventListener('click', () => {
    if (state.selectedLayerId) moveLayer(state.selectedLayerId, -1);
  });
  $('btnLayerDel').addEventListener('click', () => {
    if (state.selectedLayerId) deleteLayerById(state.selectedLayerId);
  });
  $('btnLayerFlip').addEventListener('click', () => {
    const layer = state.selectedLayerId ? findLayer(state.selectedLayerId) : null;
    if (!layer) return;
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedLayerId && state.mode === 'edit') {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      deleteLayerById(state.selectedLayerId);
    }
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
