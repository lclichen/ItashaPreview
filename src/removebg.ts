const KEY_STORAGE = 'itasha_removebg_key';

import { refineCutoutAlpha } from './maskedit';

export function getRemoveBgKey(): string {
  return localStorage.getItem(KEY_STORAGE) ?? '';
}

export function setRemoveBgKey(key: string): void {
  if (key) localStorage.setItem(KEY_STORAGE, key);
  else localStorage.removeItem(KEY_STORAGE);
}

export async function removeBgBlob(srcBlob: Blob, apiKey: string): Promise<Blob> {
  const fd = new FormData();
  fd.append('image_file', srcBlob, 'input.png');
  fd.append('size', 'auto');
  const resp = await fetch('/removebg-api/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey },
    body: fd,
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      const first = j?.errors?.[0];
      if (first) msg = `${first.title ?? first.code ?? msg}${first.detail ? `: ${first.detail}` : ''}`;
    } catch {
      /* keep default */
    }
    if (resp.status === 401) msg = 'API Key 无效（401）';
    else if (resp.status === 402) msg = '免费额度已用完（402），请在 remove.bg 查看账户';
    else if (resp.status === 429) msg = '请求过于频繁（429），请稍后重试';
    else if (resp.status >= 500) msg = '无法连接 remove.bg 服务（当前部署环境网络受限时可改用「本地 AI 抠图」）';
    throw new Error(msg);
  }
  return resp.blob();
}

export async function removeBgLocal(srcBlob: Blob): Promise<Blob> {
  const mod = (await import('@imgly/background-removal')) as {
    removeBackground: (img: Blob, cfg?: Record<string, unknown>) => Promise<Blob>;
  };
  const progress = (key: string, current: number, total: number) => {
    if (key.startsWith('fetch')) {
      document.dispatchEvent(new CustomEvent('local-rmbg-progress', { detail: Math.round((current / total) * 100) }));
    }
  };
  let out: Blob;
  try {
    out = await mod.removeBackground(srcBlob, { publicPath: '/imgly-data/', model: 'large', progress });
  } catch {
    out = await mod.removeBackground(srcBlob, { model: 'large', progress });
  }
  const img = await blobToImage(out);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  refineCutoutAlpha(c);
  return await new Promise<Blob>((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('结果导出失败'))), 'image/png');
  });
}

export async function queryCredits(apiKey: string): Promise<number | null> {
  try {
    const resp = await fetch('/removebg-api/v1.0/account', {
      headers: { 'X-Api-Key': apiKey },
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const credits = j?.data?.attributes?.credits;
    return typeof credits === 'number' ? credits : null;
  } catch {
    return null;
  }
}

export async function layerImageToBlob(img: HTMLImageElement): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('导出图层图像失败'))), 'image/png');
  });
}

export async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('抠图结果加载失败'));
    img.src = url;
  });
}

export function canvasToImage(c: HTMLCanvasElement): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('抠图结果加载失败'));
    img.src = c.toDataURL('image/png');
  });
}
