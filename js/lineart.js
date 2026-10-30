// Превращение фото в раскраску: упрощение цветов (k-means) → сглаживание областей →
// границы между областями = контур. Области получаются замкнутыми, поэтому в Procreate
// работает заливка перетаскиванием цвета.

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось открыть изображение'));
    img.src = src;
  });
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function imageToPixels(img, maxSide) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const s = Math.min(1, maxSide / Math.max(iw, ih));
  const c = makeCanvas(iw * s, ih * s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
}

// Раздельное box-размытие RGB, радиус r
function blurRGB(src, w, h, r) {
  if (r < 1) return Float32Array.from(src.filter((_, i) => i % 4 !== 3));
  const n = w * h;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = src[i * 4]; a[i * 3 + 1] = src[i * 4 + 1]; a[i * 3 + 2] = src[i * 4 + 2];
  }
  const b = new Float32Array(n * 3);
  const pass = (from, to, len, count, stride, step) => {
    for (let line = 0; line < count; line++) {
      const base = line * stride;
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0, cnt = 0;
        for (let k = 0; k <= r && k < len; k++) { sum += from[(base + k * step) * 3 + ch]; cnt++; }
        for (let x = 0; x < len; x++) {
          to[(base + x * step) * 3 + ch] = sum / cnt;
          const add = x + r + 1, rem = x - r;
          if (add < len) { sum += from[(base + add * step) * 3 + ch]; cnt++; }
          if (rem >= 0) { sum -= from[(base + rem * step) * 3 + ch]; cnt--; }
        }
      }
    }
  };
  pass(a, b, w, h, w, 1);
  pass(b, a, h, w, 1, w);
  return a;
}

function kmeans(rgb, n, k) {
  // выборка для обучения
  const step = Math.max(1, Math.floor(n / 25000));
  const sample = [];
  for (let i = 0; i < n; i += step) sample.push(i);
  const dist = (i, c) => {
    const dr = rgb[i * 3] - c[0], dg = rgb[i * 3 + 1] - c[1], db = rgb[i * 3 + 2] - c[2];
    return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
  };
  // k-means++ (детерминированный ГПСЧ, чтобы результат не скакал между перерисовками)
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const centers = [];
  const first = sample[Math.floor(sample.length / 2)];
  centers.push([rgb[first * 3], rgb[first * 3 + 1], rgb[first * 3 + 2]]);
  const d2 = new Float64Array(sample.length).fill(Infinity);
  while (centers.length < k) {
    const c = centers[centers.length - 1];
    let total = 0;
    for (let s = 0; s < sample.length; s++) { d2[s] = Math.min(d2[s], dist(sample[s], c)); total += d2[s]; }
    if (total === 0) break;
    let t = rnd() * total, pick = sample.length - 1;
    for (let s = 0; s < sample.length; s++) { t -= d2[s]; if (t <= 0) { pick = s; break; } }
    const i = sample[pick];
    centers.push([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]);
  }
  const K = centers.length;
  const nearest = (i) => {
    let best = 0, bd = Infinity;
    for (let c = 0; c < K; c++) { const d = dist(i, centers[c]); if (d < bd) { bd = d; best = c; } }
    return best;
  };
  for (let iter = 0; iter < 10; iter++) {
    const acc = new Float64Array(K * 4);
    for (const i of sample) {
      const c = nearest(i);
      acc[c * 4] += rgb[i * 3]; acc[c * 4 + 1] += rgb[i * 3 + 1]; acc[c * 4 + 2] += rgb[i * 3 + 2]; acc[c * 4 + 3]++;
    }
    for (let c = 0; c < K; c++) {
      if (acc[c * 4 + 3]) centers[c] = [acc[c * 4] / acc[c * 4 + 3], acc[c * 4 + 1] / acc[c * 4 + 3], acc[c * 4 + 2] / acc[c * 4 + 3]];
    }
  }
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) labels[i] = nearest(i);
  return { labels, centers };
}

// Мажоритарный фильтр 3×3: убирает рваные края областей
function modeFilter(labels, w, h, K) {
  const out = new Uint8Array(labels.length);
  const counts = new Uint16Array(K);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      counts.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          counts[labels[yy * w + xx]]++;
        }
      }
      let best = labels[y * w + x], bc = counts[best];
      for (let c = 0; c < K; c++) if (counts[c] > bc) { bc = counts[c]; best = c; }
      out[y * w + x] = best;
    }
  }
  return out;
}

// Сливаем связные области меньше minArea с соседней областью
function removeSmall(labels, w, h, minArea) {
  const n = w * h;
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const members = [];
  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1) continue;
    const lab = labels[start];
    let sp = 0, size = 0;
    stack[sp++] = start; comp[start] = start;
    members.length = 0;
    let neighbor = -1;
    while (sp) {
      const p = stack[--sp];
      members.push(p); size++;
      const x = p % w, y = (p - x) / w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q < 0) continue;
        if (labels[q] === lab) { if (comp[q] === -1) { comp[q] = start; stack[sp++] = q; } }
        else if (neighbor === -1) neighbor = labels[q];
      }
    }
    if (size < minArea && neighbor !== -1) for (const p of members) labels[p] = neighbor;
  }
}

export function posterize(px, { colors = 10, smooth = 2, cleanup = 2 } = {}) {
  const { w, h, data } = px;
  const n = w * h;
  const rgb = blurRGB(data, w, h, Math.round(Math.max(w, h) / 500));
  let { labels, centers } = kmeans(rgb, n, colors);
  const K = centers.length;
  for (let i = 0; i < smooth; i++) labels = modeFilter(labels, w, h, K);
  if (cleanup > 0) {
    const minArea = Math.round(n * [0, 0.0002, 0.0006, 0.0015, 0.003, 0.006][cleanup]);
    removeSmall(labels, w, h, minArea);
    removeSmall(labels, w, h, minArea);
    if (smooth) labels = modeFilter(labels, w, h, K);
  }
  // цвета палитры: средние по исходному фото, только используемые
  const acc = new Float64Array(K * 4);
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    acc[c * 4] += data[i * 4]; acc[c * 4 + 1] += data[i * 4 + 1]; acc[c * 4 + 2] += data[i * 4 + 2]; acc[c * 4 + 3]++;
  }
  const palette = [];
  for (let c = 0; c < K; c++) {
    const cnt = acc[c * 4 + 3];
    palette.push(cnt ? [acc[c * 4] / cnt, acc[c * 4 + 1] / cnt, acc[c * 4 + 2] / cnt].map(Math.round) : null);
  }
  const used = palette.map((p, i) => ({ p, i, cnt: acc[i * 4 + 3] })).filter((e) => e.p).sort((a, b) => b.cnt - a.cnt);
  return { w, h, labels, palette, swatches: used.map((e) => e.p) };
}

export function boundaryMask(labels, w, h) {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if ((x < w - 1 && labels[p] !== labels[p + 1]) || (y < h - 1 && labels[p] !== labels[p + w])) m[p] = 1;
    }
  }
  return m;
}

// Вписываем рисунок в холст с полями
export function placeRect(cw, ch, W, H, margin = 0.06) {
  const s = Math.min((W * (1 - 2 * margin)) / cw, (H * (1 - 2 * margin)) / ch);
  const w = Math.round(cw * s), h = Math.round(ch * s);
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
}

// Евклидово преобразование расстояний (Felzenszwalb & Huttenlocher)
function edt(grid, w, h) {
  const INF = 1e20;
  const len = Math.max(w, h);
  const f = new Float64Array(len), d = new Float64Array(len), v = new Int32Array(len), z = new Float64Array(len + 1);
  const line = (n) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      do { const r = v[k]; s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r); } while (s <= z[k] && --k >= 0);
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const r = v[k]; d[q] = (q - r) * (q - r) + f[r]; }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    line(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    line(w);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
}

// Слой контура: маска границ → масштаб → утолщение до thickness px со сглаженным краем
export function renderLineLayer(mask, mw, mh, W, H, thickness, ink = [17, 17, 17]) {
  const rect = placeRect(mw, mh, W, H);
  const src = makeCanvas(mw, mh);
  const sctx = src.getContext('2d');
  const sd = sctx.createImageData(mw, mh);
  for (let i = 0; i < mask.length; i++) if (mask[i]) sd.data[i * 4 + 3] = 255;
  sctx.putImageData(sd, 0, 0);

  const pad = Math.ceil(thickness) + 2;
  const bw = rect.w + pad * 2, bh = rect.h + pad * 2;
  const tmp = makeCanvas(bw, bh);
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(src, pad, pad, rect.w, rect.h);
  const td = tctx.getImageData(0, 0, bw, bh);
  const grid = new Float64Array(bw * bh);
  for (let i = 0; i < grid.length; i++) grid[i] = td.data[i * 4 + 3] >= 100 ? 0 : 1e20;
  edt(grid, bw, bh);
  const half = Math.max(0.5, thickness / 2);
  for (let i = 0; i < grid.length; i++) {
    const a = Math.min(1, Math.max(0, half + 0.5 - Math.sqrt(grid[i])));
    td.data[i * 4] = ink[0]; td.data[i * 4 + 1] = ink[1]; td.data[i * 4 + 2] = ink[2];
    td.data[i * 4 + 3] = Math.round(a * 255);
  }
  tctx.putImageData(td, 0, 0);
  const out = makeCanvas(W, H);
  out.getContext('2d').drawImage(tmp, rect.x - pad, rect.y - pad);
  return out;
}

// Цветовая карта: области, залитые цветами палитры (подсказка для раскрашивания)
export function renderColorLayer(poster, W, H) {
  const { w, h, labels, palette } = poster;
  const src = makeCanvas(w, h);
  const sctx = src.getContext('2d');
  const sd = sctx.createImageData(w, h);
  for (let i = 0; i < labels.length; i++) {
    const p = palette[labels[i]];
    sd.data[i * 4] = p[0]; sd.data[i * 4 + 1] = p[1]; sd.data[i * 4 + 2] = p[2]; sd.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(sd, 0, 0);
  return renderImageLayer(src, w, h, W, H);
}

export function renderImageLayer(img, iw, ih, W, H) {
  const rect = placeRect(iw, ih, W, H);
  const out = makeCanvas(W, H);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
  return out;
}

// Слой контура из SVG каталога; толщина линий умножается на strokeScale
export async function renderSvgLayer(svgText, W, H, strokeScale = 1) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = doc.documentElement;
  const [, , vw, vh] = svg.getAttribute('viewBox').split(/[\s,]+/).map(Number);
  for (const el of svg.querySelectorAll('[stroke-width]')) {
    el.setAttribute('stroke-width', String(parseFloat(el.getAttribute('stroke-width')) * strokeScale));
  }
  const rect = placeRect(vw, vh, W, H);
  svg.setAttribute('width', rect.w);
  svg.setAttribute('height', rect.h);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const out = makeCanvas(W, H);
    out.getContext('2d').drawImage(img, rect.x, rect.y, rect.w, rect.h);
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}
