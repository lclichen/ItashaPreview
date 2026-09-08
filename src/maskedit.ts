export interface AutoMaskOptions {
  threshold?: number;
  dilate?: number;
}

function getPixels(img: HTMLImageElement): { data: ImageData; w: number; h: number } {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, w, h), w, h };
}

function grayArray(imgData: ImageData, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  const d = imgData.data;
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  }
  return g;
}

export function sobelMagnitude(imgData: ImageData, w: number, h: number): Float32Array {
  const g = grayArray(imgData, w, h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = g[i - w - 1], t = g[i - w], tr = g[i - w + 1];
      const l = g[i - 1], r = g[i + 1];
      const bl = g[i + w - 1], b = g[i + w], br = g[i + w + 1];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * b + br - tl - 2 * t - tr;
      mag[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return mag;
}

function otsuThreshold(mag: Float32Array, maxVal = 1443): number {
  const bins = 256;
  const hist = new Float64Array(bins);
  const scale = (bins - 1) / maxVal;
  let total = 0;
  for (let i = 0; i < mag.length; i++) {
    const v = mag[i];
    if (v > 8) {
      hist[Math.min(bins - 1, (v * scale) | 0)]++;
      total++;
    }
  }
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < bins; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best / scale;
}

function dilateMask(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  let cur = src;
  for (let r = 0; r < radius; r++) {
    const next = new Uint8Array(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = cur[i];
        if (!v) {
          if (x > 0 && cur[i - 1]) v = 1;
          else if (x < w - 1 && cur[i + 1]) v = 1;
          else if (y > 0 && cur[i - w]) v = 1;
          else if (y < h - 1 && cur[i + w]) v = 1;
        }
        next[i] = v;
      }
    }
    cur = next;
  }
  return cur;
}

function floodOutside(walls: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (i: number) => {
    if (!walls[i] && !outside[i]) {
      outside[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return outside;
}

export function autoMaskFromEdges(
  img: HTMLImageElement,
  opts: AutoMaskOptions = {},
): HTMLCanvasElement {
  const { data: imgData, w, h } = getPixels(img);
  const d = imgData.data;
  const mag = sobelMagnitude(imgData, w, h);
  let maxMag = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > maxMag) maxMag = mag[i];
  const thresh = Math.min(opts.threshold ?? otsuThreshold(mag), maxMag * 0.08);
  const edges = new Uint8Array(w * h);
  for (let i = 0; i < mag.length; i++) {
    const alpha = d[i * 4 + 3];
    edges[i] = mag[i] > thresh || alpha < 30 ? 1 : 0;
  }
  const walls = dilateMask(edges, w, h, opts.dilate ?? 2);
  const outside = floodOutside(walls, w, h);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = outside[i] || d[i * 4 + 3] < 10 ? 0 : 1;
  }
  const cleaned = openMask(mask, w, h, 2);
  return maskToCanvas(cleaned, w, h);
}

function connectedComponents(flags: Uint8Array, w: number, h: number): Int32Array {
  const labels = new Int32Array(w * h).fill(0);
  let next = 0;
  const stack = new Int32Array(w * h);
  for (let s = 0; s < flags.length; s++) {
    if (!flags[s] || labels[s]) continue;
    next++;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = next;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && flags[i - 1] && !labels[i - 1]) { labels[i - 1] = next; stack[sp++] = i - 1; }
      if (x < w - 1 && flags[i + 1] && !labels[i + 1]) { labels[i + 1] = next; stack[sp++] = i + 1; }
      if (y > 0 && flags[i - w] && !labels[i - w]) { labels[i - w] = next; stack[sp++] = i - w; }
      if (y < h - 1 && flags[i + w] && !labels[i + w]) { labels[i + w] = next; stack[sp++] = i + w; }
    }
  }
  return labels;
}

export function refineMaskExcludeDarkParts(
  img: HTMLImageElement,
  baseMask: HTMLCanvasElement,
  sensitivity: number,
): HTMLCanvasElement {
  const { data: imgData, w, h } = getPixels(img);
  const d = imgData.data;
  const base = maskToUint8(baseMask);

  const luma = new Float32Array(w * h);
  let sumL = 0;
  let countL = 0;
  for (let i = 0; i < base.length; i++) {
    const p = i * 4;
    luma[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    if (base[i] && d[p + 3] > 128 && luma[i] > 120) {
      sumL += luma[i];
      countL++;
    }
  }
  const bodyLuma = countL > 0 ? sumL / countL : 160;
  const darkT = Math.max(40, Math.min(200, bodyLuma * (1.05 - sensitivity * 0.01)));

  const dark = new Uint8Array(w * h);
  for (let i = 0; i < base.length; i++) {
    dark[i] = base[i] && luma[i] < darkT ? 1 : 0;
  }

  let yBottom = 0;
  let bottomCount = 0;
  for (let y = h - 1; y >= 0 && bottomCount < 40; y--) {
    let rowHit = 0;
    for (let x = 0; x < w; x++) if (base[y * w + x]) rowHit++;
    if (rowHit > w * 0.02) {
      yBottom = y;
      bottomCount++;
    }
  }

  const labels = connectedComponents(dark, w, h);
  const stats = new Map<number, { size: number; maxY: number; lumaSum: number }>();
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    let st = stats.get(l);
    if (!st) {
      st = { size: 0, maxY: 0, lumaSum: 0 };
      stats.set(l, st);
    }
    st.size++;
    st.lumaSum += luma[i];
    const y = (i / w) | 0;
    if (y > st.maxY) st.maxY = y;
  }

  const removeLabels = new Set<number>();
  for (const [l, st] of stats) {
    const avgL = st.lumaSum / st.size;
    const touchesBottom = st.maxY >= yBottom - 8;
    const big = st.size > w * h * 0.012;
    if ((touchesBottom && avgL < bodyLuma * 0.75) || (big && avgL < darkT)) {
      removeLabels.add(l);
    }
  }

  let out: Uint8Array = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i++) {
    out[i] = base[i] && (dark[i] === 0 || !removeLabels.has(labels[i])) ? 1 : 0;
  }

  out = closeMask(out, w, h, 3);
  out = keepMainComponents(out, w, h, 0.05);
  out = openMask(out, w, h, 1);
  return maskToCanvas(out, w, h);
}

function closeMask(src: Uint8Array, w: number, h: number, iters: number): Uint8Array {
  return erodeMask(dilateMask(src, w, h, iters), w, h, iters);
}

function erodeMask(src: Uint8Array, w: number, h: number, iters: number): Uint8Array {
  let cur = src;
  for (let k = 0; k < iters; k++) cur = erodeOnce(cur, w, h);
  return cur;
}

function erodeOnce(src: Uint8Array, w: number, h: number): Uint8Array {
  const next = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!src[i]) continue;
      const l = x > 0 ? src[i - 1] : 0;
      const r = x < w - 1 ? src[i + 1] : 0;
      const u = y > 0 ? src[i - w] : 0;
      const dn = y < h - 1 ? src[i + w] : 0;
      next[i] = l && r && u && dn ? 1 : 0;
    }
  }
  return next;
}

function keepMainComponents(src: Uint8Array, w: number, h: number, minRatio: number): Uint8Array {
  const labels = connectedComponents(src, w, h);
  const sizes = new Map<number, number>();
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    sizes.set(l, (sizes.get(l) ?? 0) + 1);
  }
  const total = src.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(src.length);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    out[i] = (sizes.get(l) ?? 0) >= total * minRatio ? 1 : 0;
  }
  return out;
}

function maskToCanvas(mask: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const imgData = ctx.createImageData(w, h);
  const d = imgData.data;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    d[p] = 255;
    d[p + 1] = 255;
    d[p + 2] = 255;
    d[p + 3] = mask[i] ? 255 : 0;
  }
  ctx.putImageData(imgData, 0, 0);
  return c;
}

export function autoMaskFromAlpha(img: HTMLImageElement): HTMLCanvasElement {
  const { data: imgData, w, h } = getPixels(img);
  const d = imgData.data;
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 3; i < mask.length; i++, p += 4) {
    mask[i] = d[p] > 40 ? 1 : 0;
  }
  const cleaned = openMask(mask, w, h, 3);
  return maskToCanvas(cleaned, w, h);
}

function openMask(src: Uint8Array, w: number, h: number, iters: number): Uint8Array {
  let cur = src;
  for (let k = 0; k < iters; k++) cur = erodeOnce(cur, w, h);
  return dilateMask(cur, w, h, iters);
}

export function wandMask(
  img: HTMLImageElement,
  sx: number,
  sy: number,
  tolerance: number,
): { mask: Uint8Array; w: number; h: number } | null {
  const { data: imgData, w, h } = getPixels(img);
  const d = imgData.data;
  const x = Math.round(sx);
  const y = Math.round(sy);
  if (x < 0 || y < 0 || x >= w || y >= h) return null;
  const si = y * w + x;
  const sr = d[si * 4], sg = d[si * 4 + 1], sb = d[si * 4 + 2], sa = d[si * 4 + 3];
  const tol2 = tolerance * tolerance * 4;
  const mask = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (i: number) => {
    if (mask[i]) return;
    const p = i * 4;
    const dr = d[p] - sr, dg = d[p + 1] - sg, db = d[p + 2] - sb, da = d[p + 3] - sa;
    if (dr * dr + dg * dg + db * db + da * da <= tol2) {
      mask[i] = 1;
      stack[sp++] = i;
    }
  };
  push(si);
  while (sp > 0) {
    const i = stack[--sp];
    const px = i % w;
    const py = (i / w) | 0;
    if (px > 0) push(i - 1);
    if (px < w - 1) push(i + 1);
    if (py > 0) push(i - w);
    if (py < h - 1) push(i + w);
  }
  return { mask, w, h };
}

export function maskToUint8(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, p = 3; i < out.length; i++, p += 4) {
    out[i] = data[p] > 127 ? 1 : 0;
  }
  return out;
}

export function uint8ToMaskCanvas(mask: Uint8Array, w: number, h: number): HTMLCanvasElement {
  return maskToCanvas(mask, w, h);
}

export function stampCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  add: boolean,
): void {
  ctx.save();
  ctx.globalCompositeOperation = add ? 'source-over' : 'destination-out';
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}

export function stampLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  add: boolean,
): void {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / (radius * 0.4)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    stampCircle(ctx, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, add);
  }
}

export function edgeOverlayCanvas(img: HTMLImageElement, threshold?: number): HTMLCanvasElement {
  const { data: imgData, w, h } = getPixels(img);
  const mag = sobelMagnitude(imgData, w, h);
  const thresh = threshold ?? otsuThreshold(mag);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const out = ctx.createImageData(w, h);
  const d = out.data;
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] > thresh) {
      const p = i * 4;
      d[p] = 255;
      d[p + 1] = 220;
      d[p + 2] = 0;
      d[p + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

export function invertMaskCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let p = 3; p < d.length; p += 4) {
    d[p] = d[p] > 127 ? 0 : 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

export function clearMaskCanvas(canvas: HTMLCanvasElement): void {
  canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
}

export function chromaKeyCutout(img: HTMLImageElement, tolerance = 42): HTMLCanvasElement {
  const { data: imgData, w, h } = getPixels(img);
  const d = imgData.data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const od = octx.createImageData(w, h);
  const o = od.data;
  o.set(d);

  const b = 8;
  const pts: [number, number][] = [
    [b, b], [w - 1 - b, b], [b, h - 1 - b], [w - 1 - b, h - 1 - b],
    [w >> 1, b], [w >> 1, h - 1 - b], [b, h >> 1], [w - 1 - b, h >> 1],
  ];
  const samples: number[][] = [];
  for (const [cx, cy] of pts) {
    let r = 0, g = 0, bl = 0, n = 0;
    for (let y = cy - 5; y <= cy + 5; y++) {
      for (let x = cx - 5; x <= cx + 5; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const p = (y * w + x) * 4;
        if (d[p + 3] > 200) {
          r += d[p]; g += d[p + 1]; bl += d[p + 2]; n++;
        }
      }
    }
    if (n > 30) samples.push([r / n, g / n, bl / n]);
  }

  if (!samples.length) {
    octx.putImageData(od, 0, 0);
    return out;
  }

  const bgColors: number[][] = [];
  for (const s of samples) {
    let merged = false;
    for (const bc of bgColors) {
      if (Math.hypot(s[0] - bc[0], s[1] - bc[1], s[2] - bc[2]) < 24) {
        bc[0] = (bc[0] + s[0]) / 2;
        bc[1] = (bc[1] + s[1]) / 2;
        bc[2] = (bc[2] + s[2]) / 2;
        merged = true;
        break;
      }
    }
    if (!merged) bgColors.push([...s]);
  }

  const t = tolerance;
  const dist = new Float32Array(w * h);
  for (let i = 0, p = 0; i < dist.length; i++, p += 4) {
    let best = Infinity;
    for (const bc of bgColors) {
      const dd = Math.hypot(d[p] - bc[0], d[p + 1] - bc[1], d[p + 2] - bc[2]);
      if (dd < best) best = dd;
    }
    dist[i] = best;
  }

  const bgLike = new Uint8Array(w * h);
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] < t) bgLike[i] = 1;
  }

  const bg = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const i = y * w + x;
      if (bgLike[i] && !bg[i]) { bg[i] = 1; stack.push(i); }
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      const i = y * w + x;
      if (bgLike[i] && !bg[i]) { bg[i] = 1; stack.push(i); }
    }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0 && bgLike[i - 1] && !bg[i - 1]) { bg[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && bgLike[i + 1] && !bg[i + 1]) { bg[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && bgLike[i - w] && !bg[i - w]) { bg[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && bgLike[i + w] && !bg[i + w]) { bg[i + w] = 1; stack.push(i + w); }
  }

  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bg[y * w + x]) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) near[ny * w + nx] = 1;
        }
      }
    }
  }

  const lo = t * 0.35;
  for (let i = 0, p = 0; i < bg.length; i++, p += 4) {
    if (bg[i]) {
      o[p + 3] = 0;
    } else if (near[i]) {
      o[p + 3] = dist[i] >= t ? 255 : Math.max(0, Math.min(255, Math.round(((dist[i] - lo) / (t - lo)) * 255)));
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

export function refineCutoutAlpha(canvas: HTMLCanvasElement, cutLow = 96, softHigh = 208): void {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;
  for (let p = 3; p < d.length; p += 4) {
    const a = d[p];
    if (a < cutLow) d[p] = 0;
    else if (a < softHigh) d[p] = Math.round(((a - cutLow) / (softHigh - cutLow)) * 255);
  }
  ctx.putImageData(id, 0, 0);
}
