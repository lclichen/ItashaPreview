import type { Layer, Point, Quad } from './types';
import { IMG_W, IMG_H } from './state';

export function quadFromTransform(layer: Layer): Quad {
  const t = layer.transform;
  const iw = (layer.img.naturalWidth || layer.img.width) * t.scale;
  const ih = (layer.img.naturalHeight || layer.img.height) * t.scale;
  const rad = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const local: [number, number][] = [
    [-iw / 2, -ih / 2],
    [iw / 2, -ih / 2],
    [iw / 2, ih / 2],
    [-iw / 2, ih / 2],
  ];
  return local.map(([px, py]) => {
    const sx = layer.flipX ? -px : px;
    return { x: t.x + sx * cos - py * sin, y: t.y + sx * sin + py * cos };
  }) as Quad;
}

function isAffine(q: Quad): boolean {
  const dx1 = q[1].x - q[2].x;
  const dx2 = q[3].x - q[2].x;
  const dx3 = q[0].x - q[1].x + q[2].x - q[3].x;
  const dy1 = q[1].y - q[2].y;
  const dy2 = q[3].y - q[2].y;
  const dy3 = q[0].y - q[1].y + q[2].y - q[3].y;
  return Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9 && Math.abs(dx1 * dy2 - dy1 * dx2) > 1e-9;
}

export function homography(q: Quad): number[] {
  const [p0, p1, p2, p3] = q;
  if (isAffine(q)) {
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0];
  }
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  const den = dx1 * dy2 - dy1 * dx2;
  const g = (dx3 * dy2 - dy3 * dx2) / den;
  const h = (dx1 * dy3 - dy1 * dx3) / den;
  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
  ];
}

export function applyH(m: number[], u: number, v: number): Point {
  const w = m[6] * u + m[7] * v + 1;
  return { x: (m[0] * u + m[1] * v + m[2]) / w, y: (m[3] * u + m[4] * v + m[5]) / w };
}

export function invertH(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h] = m;
  const A = e * 1 - f * h;
  const B = c * h - b;
  const C = b * f - c * e;
  const D = f * g - d;
  const E = a * 1 - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const det = a * A + b * D + c * G;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0];
  const s = 1 / det;
  return [A * s, B * s, C * s, D * s, E * s, F * s, G * s, H * s];
}

export function quadUV(q: Quad, p: Point): Point | null {
  const inv = invertH(homography(q));
  const w = inv[6] * p.x + inv[7] * p.y + 1;
  if (Math.abs(w) < 1e-9) return null;
  const u = (inv[0] * p.x + inv[1] * p.y + inv[2]) / w;
  const v = (inv[3] * p.x + inv[4] * p.y + inv[5]) / w;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { x: u, y: v };
}

export function quadBounds(q: Quad): { x: number; y: number; w: number; h: number } {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function affineOf(s0: Point, s1: Point, s2: Point, d0: Point, d1: Point, d2: Point): number[] | null {
  const dx1 = s1.x - s0.x;
  const dy1 = s1.y - s0.y;
  const dx2 = s2.x - s0.x;
  const dy2 = s2.y - s0.y;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-9) return null;
  const a = ((d1.x - d0.x) * dy2 - (d2.x - d0.x) * dy1) / det;
  const b = ((d2.x - d0.x) * dx1 - (d1.x - d0.x) * dx2) / det;
  const c = d0.x - a * s0.x - b * s0.y;
  const d = ((d1.y - d0.y) * dy2 - (d2.y - d0.y) * dy1) / det;
  const e = ((d2.y - d0.y) * dx1 - (d1.y - d0.y) * dx2) / det;
  const f = d0.y - d * s0.x - e * s0.y;
  return [a, d, b, e, c, f];
}

const GRID = 14;
const SUPERSAMPLE = 2;

export function renderQuadTo(ctx: CanvasRenderingContext2D, layer: Layer, q: Quad, ss = SUPERSAMPLE): void {
  const img = layer.img;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const m = homography(q);
  const outW = IMG_W * ss;
  const outH = IMG_H * ss;
  ctx.clearRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const u0 = i / GRID;
      const u1 = (i + 1) / GRID;
      const v0 = j / GRID;
      const v1 = (j + 1) / GRID;
      const raw00 = applyH(m, u0, v0);
      const raw10 = applyH(m, u1, v0);
      const raw11 = applyH(m, u1, v1);
      const raw01 = applyH(m, u0, v1);
      const p00 = { x: raw00.x * ss, y: raw00.y * ss };
      const p10 = { x: raw10.x * ss, y: raw10.y * ss };
      const p11 = { x: raw11.x * ss, y: raw11.y * ss };
      const p01 = { x: raw01.x * ss, y: raw01.y * ss };
      if (
        Math.max(p00.x, p10.x, p11.x, p01.x) < -2 ||
        Math.min(p00.x, p10.x, p11.x, p01.x) > outW + 2 ||
        Math.max(p00.y, p10.y, p11.y, p01.y) < -2 ||
        Math.min(p00.y, p10.y, p11.y, p01.y) > outH + 2
      ) {
        continue;
      }
      const sx0 = (layer.flipX ? 1 - u1 : u0) * iw;
      const sy0 = v0 * ih;
      const sw = (u1 - u0) * iw;
      const sh = (v1 - v0) * ih;
      const src = layer.flipX ? [sw, 0, 0, 0, sw, sh] : [0, 0, sw, 0, 0, sh];
      const a = affineOf(
        { x: src[0], y: src[1] },
        { x: src[2], y: src[3] },
        { x: src[4], y: src[5] },
        p00,
        p10,
        p01,
      );
      if (!a) continue;
      const cxm = (p00.x + p10.x + p11.x + p01.x) / 4;
      const cym = (p00.y + p10.y + p11.y + p01.y) / 4;
      const grow = (p: Point): Point => {
        const ddx = p.x - cxm;
        const ddy = p.y - cym;
        const len = Math.hypot(ddx, ddy) || 1;
        return { x: p.x + (ddx / len) * 0.75, y: p.y + (ddy / len) * 0.75 };
      };
      const g00 = grow(p00);
      const g10 = grow(p10);
      const g11 = grow(p11);
      const g01 = grow(p01);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(g00.x, g00.y);
      ctx.lineTo(g10.x, g10.y);
      ctx.lineTo(g11.x, g11.y);
      ctx.lineTo(g01.x, g01.y);
      ctx.closePath();
      ctx.clip();
      ctx.setTransform(a[0], a[1], a[2], a[3], a[4], a[5]);
      ctx.drawImage(img, sx0, sy0, sw, sh, 0, 0, sw, sh);
      ctx.restore();
    }
  }
}

const quadCanvasCache = new WeakMap<Layer, { key: string; canvas: HTMLCanvasElement }>();

export function quadRenderCanvas(layer: Layer): HTMLCanvasElement | null {
  if (!layer.quad) return null;
  const key = `${layer.quad.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('|')}|${layer.flipX}|${layer.img.src}`;
  const hit = quadCanvasCache.get(layer);
  if (hit && hit.key === key) return hit.canvas;
  const c = document.createElement('canvas');
  c.width = IMG_W * SUPERSAMPLE;
  c.height = IMG_H * SUPERSAMPLE;
  renderQuadTo(c.getContext('2d')!, layer, layer.quad);
  quadCanvasCache.set(layer, { key, canvas: c });
  return c;
}
