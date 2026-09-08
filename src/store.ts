import type { Layer, ViewKey } from './types';

const DB_NAME = 'itasha-studio';
const DB_VERSION = 1;
const VIEWS: ViewKey[] = ['front', 'right', 'rear', 'left'];

interface StoredLayer {
  id: string;
  name: string;
  kind: Layer['kind'];
  visible: boolean;
  opacity: number;
  clipToMask: boolean;
  flipX: boolean;
  transform: Layer['transform'];
  imgBlob: Blob;
}

interface StoredView {
  layers: StoredLayer[];
  maskBlob: Blob | null;
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

async function serializeLayer(layer: Layer): Promise<StoredLayer> {
  let blob = imgBlobCache.get(layer.img);
  if (!blob) {
    blob = await imageToBlob(layer.img);
    imgBlobCache.set(layer.img, blob);
  }
  return {
    id: layer.id,
    name: layer.name,
    kind: layer.kind,
    visible: layer.visible,
    opacity: layer.opacity,
    clipToMask: layer.clipToMask,
    flipX: layer.flipX,
    transform: { ...layer.transform },
    imgBlob: blob,
  };
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function queuePersistAll(getViews: () => Record<ViewKey, { layers: Layer[]; mask: HTMLCanvasElement | null }>): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistAll(getViews()).catch((e) => console.error('[store] persist failed:', e));
  }, 800);
}

async function persistAll(
  views: Record<ViewKey, { layers: Layer[]; mask: HTMLCanvasElement | null }>,
): Promise<void> {
  const records: [ViewKey, StoredView][] = [];
  for (const vk of VIEWS) {
    const v = views[vk];
    const layers = await Promise.all(v.layers.map(serializeLayer));
    const maskBlob = v.mask ? await canvasToBlob(v.mask) : null;
    records.push([vk, { layers, maskBlob }]);
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

export async function loadAll(): Promise<Record<ViewKey, { layers: Layer[]; mask: HTMLCanvasElement | null }>> {
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
    const result = {
      front: { layers: [] as Layer[], mask: null as HTMLCanvasElement | null },
      right: { layers: [] as Layer[], mask: null as HTMLCanvasElement | null },
      rear: { layers: [] as Layer[], mask: null as HTMLCanvasElement | null },
      left: { layers: [] as Layer[], mask: null as HTMLCanvasElement | null },
    } as Record<ViewKey, { layers: Layer[]; mask: HTMLCanvasElement | null }>;
    for (const vk of VIEWS) {
      const sv = raw[vk];
      if (!sv) continue;
      for (const sl of sv.layers) {
        try {
          const img = await blobToImage(sl.imgBlob);
          result[vk].layers.push({
            id: sl.id,
            name: sl.name,
            kind: sl.kind,
            img,
            originalImg: null,
            visible: sl.visible,
            opacity: sl.opacity,
            clipToMask: sl.clipToMask,
            flipX: sl.flipX,
            transform: { ...sl.transform },
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
