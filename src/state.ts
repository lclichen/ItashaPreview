import type { Layer, ViewState, ViewKey } from './types';
import { queuePersistAll } from './store';

export const IMG_W = 1200;
export const IMG_H = 800;
export const FRAMES = 36;

export const ORTHO_FRAME_1BASED: Record<ViewKey, number> = {
  front: 5,
  right: 14,
  rear: 23,
  left: 32,
};

export const VIEW_ORDER: ViewKey[] = ['front', 'right', 'rear', 'left'];

export const VIEW_LABEL: Record<ViewKey, string> = {
  front: '正前',
  right: '右侧',
  rear: '正后',
  left: '左侧',
};

export function frameSrc(idx0: number): string {
  return `/car360/frame_${String(idx0 + 1).padStart(2, '0')}.webp`;
}

export function angleOfFrame(idx0: number): number {
  return ((idx0 - 4) * 10 + 360) % 360;
}

export function angleLabel(idx0: number): string {
  const a = angleOfFrame(idx0);
  const ortho: Record<number, string> = { 0: '正前', 90: '正右', 180: '正后', 270: '正左' };
  if (ortho[a]) return ortho[a];
  if (a < 90) return `右前 ${a}°`;
  if (a < 180) return `右后 ${180 - a}°`;
  if (a < 270) return `左后 ${a - 180}°`;
  return `左前 ${360 - a}°`;
}

let idSeq = 0;
export function uid(): string {
  idSeq += 1;
  return `L${Date.now().toString(36)}${idSeq}`;
}

function initView(): ViewState {
  return { layers: [], mask: null, maskTouched: false };
}

export const state = {
  mode: 'orbit' as 'orbit' | 'edit' | 'mask',
  currentView: 'front' as ViewKey,
  orbitFrame: 4,
  frames: new Array<(HTMLImageElement | null)>(FRAMES).fill(null),
  framesLoaded: false,
  views: {
    front: initView(),
    right: initView(),
    rear: initView(),
    left: initView(),
  } as Record<ViewKey, ViewState>,
  selectedLayerId: null as string | null,
  maskTool: 'brush' as 'brush' | 'eraser' | 'wand',
  wandMode: 'add' as 'add' | 'subtract',
  brushSize: 32,
  wandTolerance: 32,
  wheelSensitivity: 55,
  quickTol: 42,
  showEdgeOverlay: false,
  playing: false,
  dirty: true,
  brushCursor: null as { x: number; y: number } | null,
};

export function currentView(): ViewState {
  return state.views[state.currentView];
}

let restored = false;
export function setRestored(): void {
  restored = true;
}
export function isRestored(): boolean {
  return restored;
}

export function markDirty(): void {
  state.dirty = true;
  if (restored) queuePersistAll(() => state.views);
}

const imgCache = new Map<string, HTMLImageElement>();

export function loadImg(src: string): Promise<HTMLImageElement> {
  const hit = imgCache.get(src);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imgCache.set(src, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`图片加载失败: ${src}`));
    img.src = src;
  });
}

export function defaultTransform(kind: Layer['kind'], img: HTMLImageElement): Layer['transform'] {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (kind === 'background') {
    return { x: IMG_W / 2, y: IMG_H / 2, scale: Math.max(IMG_W / iw, IMG_H / ih), rotation: 0 };
  }
  if (kind === 'art') {
    return { x: IMG_W / 2, y: IMG_H / 2, scale: (IMG_H * 0.62) / ih, rotation: 0 };
  }
  return { x: IMG_W / 2, y: IMG_H / 2, scale: (IMG_W * 0.45) / Math.max(iw, 1), rotation: 0 };
}

export function makeLayer(
  kind: Layer['kind'],
  img: HTMLImageElement,
  name: string,
): Layer {
  return {
    id: uid(),
    name,
    kind,
    img,
    originalImg: null,
    visible: true,
    opacity: 1,
    clipToMask: kind !== 'background',
    flipX: false,
    transform: defaultTransform(kind, img),
  };
}

export function findLayer(id: string): Layer | null {
  for (const vk of VIEW_ORDER) {
    const l = state.views[vk].layers.find((x) => x.id === id);
    if (l) return l;
  }
  return null;
}
