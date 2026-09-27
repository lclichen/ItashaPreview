import type { Layer, ViewKey } from './types';
import { makeCarLayer } from './carlayer';

const DB_NAME = 'itasha-studio';
const DB_VERSION = 1;
const VIEWS: ViewKey[] = ['front', 'right', 'rear', 'left', 'hood'];

type ViewData = { layers: Layer[]; mask: HTMLCanvasElement | null; baseImg: HTMLImageElement | null };

interface StoredLayer {
  id: string;
  name: string;
  kind: Layer['kind'];
  visible: boolean;
  locked: boolean;
  opacity: number;
  clipToMask: boolean;
  flipX: boolean;
  blend?: string;
  transform: Layer['transform'];
  quad: Layer['quad'];
  imgBlob: Blob | null;
}

interface StoredView {
  layers: StoredLayer[];
  maskBlob: Blob | null;
  baseBlob?: Blob | null;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('views')) db.createObjectStore('views');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function imageToBlob(img: HTMLImageElement): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片序列化失败'))), 'image/png');
  });
}

function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('遮罩序列化失败'))), 'image/png');
  });
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('缓存图片加载失败'));
    img.src = url;
  });
}

const imgBlobCache = new WeakMap<HTMLImageElement, Blob>();

async function imageToBlobCached(img: HTMLImageElement): Promise<Blob> {
  let blob = imgBlobCache.get(img);
  if (!blob) {
    blob = await imageToBlob(img);
    imgBlobCache.set(img, blob);
  }
  return blob;
}

async function serializeLayer(layer: Layer): Promise<StoredLayer | null> {
  if (layer.kind === 'car') {
    return {
      id: layer.id,
      name: layer.name,
      kind: layer.kind,
      visible: true,
      locked: true,
      opacity: 1,
      clipToMask: false,
      flipX: false,
      blend: 'source-over',
      transform: { ...layer.transform },
      quad: null,
      imgBlob: null,
    };
  }
  const blob = await imageToBlobCached(layer.img);
  return {
    id: layer.id,
    name: layer.name,
    kind: layer.kind,
    visible: layer.visible,
    locked: layer.locked,
    opacity: layer.opacity,
    clipToMask: layer.clipToMask,
    flipX: layer.flipX,
    blend: layer.blend,
    transform: { ...layer.transform },
    quad: layer.quad ? (layer.quad.map((p) => ({ ...p })) as Layer['quad']) : null,
    imgBlob: blob,
  };
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function queuePersistAll(getViews: () => Record<ViewKey, ViewData>): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistAll(getViews()).catch((e) => console.error('[store] persist failed:', e));
  }, 800);
}

async function persistAll(views: Record<ViewKey, ViewData>): Promise<void> {
  const records: [ViewKey, StoredView][] = [];
  for (const vk of VIEWS) {
    const v = views[vk];
    const layers = (await Promise.all(v.layers.map(serializeLayer))).filter((s): s is StoredLayer => s !== null);
    const maskBlob = v.mask ? await canvasToBlob(v.mask) : null;
    const baseBlob = v.baseImg ? await imageToBlobCached(v.baseImg) : null;
    records.push([vk, { layers, maskBlob, baseBlob }]);
  }
  const db = await openDB();
  try {
    const tx = db.transaction('views', 'readwrite');
    const store = tx.objectStore('views');
    for (const [vk, record] of records) {
      store.put(record, vk);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadAll(): Promise<Record<ViewKey, ViewData>> {
  const db = await openDB();
  try {
    const raw = await new Promise<Record<string, StoredView>>((resolve, reject) => {
      const tx = db.transaction('views', 'readonly');
      const store = tx.objectStore('views');
      const out: Record<string, StoredView> = {};
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          out[String(cur.key)] = cur.value as StoredView;
          cur.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    });
    const emptyView = (): ViewData => ({ layers: [makeCarLayer()], mask: null, baseImg: null });
    const result = {
      front: emptyView(),
      right: emptyView(),
      rear: emptyView(),
      left: emptyView(),
      hood: emptyView(),
    } as Record<ViewKey, ViewData>;
    for (const vk of VIEWS) {
      const sv = raw[vk];
      if (!sv) continue;
      result[vk].layers = [];
      for (const sl of sv.layers) {
        if (sl.kind === 'car') {
          result[vk].layers.push(makeCarLayer());
          continue;
        }
        try {
          if (!sl.imgBlob) continue;
          const img = await blobToImage(sl.imgBlob);
          result[vk].layers.push({
            id: sl.id,
            name: sl.name,
            kind: sl.kind,
            img,
            originalImg: null,
            visible: sl.visible,
            locked: sl.locked ?? false,
            opacity: sl.opacity,
            clipToMask: sl.clipToMask,
            flipX: sl.flipX,
            blend: sl.blend || 'source-over',
            transform: { ...sl.transform },
            quad: sl.quad ? (sl.quad.map((p) => ({ ...p })) as Layer['quad']) : null,
          });
        } catch {
          /* skip broken layer */
        }
      }
      if (sv.maskBlob) {
        try {
          const bmp = await createImageBitmap(sv.maskBlob);
          const c = document.createElement('canvas');
          c.width = bmp.width;
          c.height = bmp.height;
          c.getContext('2d')!.drawImage(bmp, 0, 0);
          result[vk].mask = c;
          bmp.close();
        } catch {
          /* skip broken mask */
        }
      }
      if (sv.baseBlob) {
        try {
          result[vk].baseImg = await blobToImage(sv.baseBlob);
        } catch {
          /* skip broken base image */
        }
      }
    }
    return result;
  } finally {
    db.close();
  }
}

export async function clearAll(): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction('views', 'readwrite');
    tx.objectStore('views').clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

interface ProjectLayerRecord {
  id: string;
  name: string;
  kind: Layer['kind'];
  visible: boolean;
  locked: boolean;
  opacity: number;
  clipToMask: boolean;
  flipX: boolean;
  blend: string;
  transform: Layer['transform'];
  quad: Layer['quad'];
  img: string | null;
}

interface ProjectViewRecord {
  layers: ProjectLayerRecord[];
  mask: string | null;
  base?: string | null;
}

export interface ProjectFile {
  app: 'itasha-studio';
  version: number;
  exportedAt: string;
  images: Record<string, string>;
  views: Record<string, ProjectViewRecord>;
}

function imageToDataURL(img: HTMLImageElement, type: string, quality?: number): string {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c.toDataURL(type, quality);
}

function dataURLToImage(url: string, cache: Map<string, HTMLImageElement>): Promise<HTMLImageElement> {
  const hit = cache.get(url);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cache.set(url, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error('工程图片解析失败'));
    img.src = url;
  });
}

export async function exportProject(views: Record<ViewKey, ViewData>): Promise<Blob> {
  const images: Record<string, string> = {};
  const keyByImg = new Map<HTMLImageElement, string>();
  let seq = 0;
  const keyOf = (img: HTMLImageElement): string => {
    let k = keyByImg.get(img);
    if (!k) {
      seq += 1;
      k = `img${seq}`;
      keyByImg.set(img, k);
      images[k] = imageToDataURL(img, 'image/webp', 0.95);
    }
    return k;
  };
  const out: ProjectFile = {
    app: 'itasha-studio',
    version: 1,
    exportedAt: new Date().toISOString(),
    images,
    views: {},
  };
  for (const vk of VIEWS) {
    const v = views[vk];
    const layers: ProjectLayerRecord[] = v.layers.map((l) => ({
      id: l.id,
      name: l.name,
      kind: l.kind,
      visible: l.visible,
      locked: l.locked,
      opacity: l.opacity,
      clipToMask: l.clipToMask,
      flipX: l.flipX,
      blend: l.blend || 'source-over',
      transform: { ...l.transform },
      quad: l.quad ? (l.quad.map((p) => ({ ...p })) as Layer['quad']) : null,
      img: l.kind === 'car' ? null : keyOf(l.img),
    }));
    out.views[vk] = {
      layers,
      mask: v.mask ? v.mask.toDataURL('image/png') : null,
      base: v.baseImg ? keyOf(v.baseImg) : null,
    };
  }
  return new Blob([JSON.stringify(out)], { type: 'application/json' });
}

export async function importProject(file: Blob): Promise<Record<ViewKey, ViewData>> {
  let parsed: ProjectFile;
  try {
    parsed = JSON.parse(await file.text()) as ProjectFile;
  } catch {
    throw new Error('工程文件不是有效的 JSON');
  }
  if (!parsed || parsed.app !== 'itasha-studio' || !parsed.views) {
    throw new Error('不是有效的痛车工程文件');
  }
  const images = parsed.images ?? {};
  const imgCache = new Map<string, HTMLImageElement>();
  const emptyView = (): ViewData => ({ layers: [makeCarLayer()], mask: null, baseImg: null });
  const result = {
    front: emptyView(),
    right: emptyView(),
    rear: emptyView(),
    left: emptyView(),
    hood: emptyView(),
  } as Record<ViewKey, ViewData>;
  for (const vk of VIEWS) {
    const pv = parsed.views[vk];
    if (!pv) continue;
    const layers: Layer[] = [makeCarLayer()];
    for (const pl of pv.layers) {
      if (pl.kind === 'car') continue;
      const url = pl.img ? images[pl.img] : null;
      if (!url) continue;
      const img = await dataURLToImage(url, imgCache);
      const t = pl.transform ?? { x: 600, y: 400, scale: 1, rotation: 0 };
      layers.push({
        id: pl.id || `L${Math.random().toString(36).slice(2, 9)}`,
        name: pl.name,
        kind: pl.kind,
        img,
        originalImg: null,
        visible: pl.visible !== false,
        locked: !!pl.locked,
        opacity: typeof pl.opacity === 'number' ? pl.opacity : 1,
        clipToMask: !!pl.clipToMask,
        flipX: !!pl.flipX,
        blend: pl.blend || 'source-over',
        transform: { ...t },
        quad: pl.quad ? (pl.quad.map((p) => ({ ...p })) as Layer['quad']) : null,
      });
    }
    let mask: HTMLCanvasElement | null = null;
    if (pv.mask) {
      const img = await dataURLToImage(pv.mask, imgCache);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || 1200;
      c.height = img.naturalHeight || 800;
      c.getContext('2d')!.drawImage(img, 0, 0);
      mask = c;
    }
    let baseImg: HTMLImageElement | null = null;
    if (pv.base) {
      const url = images[pv.base];
      if (url) baseImg = await dataURLToImage(url, imgCache);
    }
    result[vk] = { layers, mask, baseImg };
  }
  return result;
}
