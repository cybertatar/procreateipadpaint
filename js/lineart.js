// Превращение фото в раскраску: упрощение цветов (k-means в Lab) → сглаживание областей →
// векторизация областей. Из одних и тех же путей строятся слой «Цвет» (заливки)
// и слой «Контур» (обводки), поэтому они совпадают точно, а области замкнуты
// и в Procreate работает заливка перетаскиванием цвета.

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

// sRGB → CIE Lab (на месте): расстояния в Lab ближе к восприятию цвета
function toLab(a) {
  const lin = (v) => (v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  for (let i = 0; i < a.length; i += 3) {
    const r = lin(a[i]), g = lin(a[i + 1]), b = lin(a[i + 2]);
    const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
    const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
    const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    a[i] = 116 * y - 16; a[i + 1] = 500 * (x - y); a[i + 2] = 200 * (y - z);
  }
  return a;
}

function kmeans(rgb, n, k) {
  // выборка для обучения
  const step = Math.max(1, Math.floor(n / 25000));
  const sample = [];
  for (let i = 0; i < n; i += step) sample.push(i);
  const dist = (i, c) => {
    const dr = rgb[i * 3] - c[0], dg = rgb[i * 3 + 1] - c[1], db = rgb[i * 3 + 2] - c[2];
    return dr * dr + dg * dg + db * db;
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

// Сливаем с самым частым соседом связные области меньше minArea и узкие ленточки
// (средняя ширина 2·площадь/периметр меньше minWidth): в раскраске они дают
// двойные линии и не закрашиваются
function removeSmall(labels, w, h, K, minArea, minWidth) {
  const n = w * h;
  const comp = new Uint8Array(n);
  const stack = new Int32Array(n);
  const members = [];
  const nbCount = new Uint32Array(K);
  let changed = false;
  for (let start = 0; start < n; start++) {
    if (comp[start]) continue;
    const lab = labels[start];
    let sp = 0, size = 0, perim = 0;
    stack[sp++] = start; comp[start] = 1;
    members.length = 0;
    nbCount.fill(0);
    while (sp) {
      const p = stack[--sp];
      members.push(p); size++;
      const x = p % w, y = (p - x) / w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q < 0) continue;
        if (labels[q] === lab) { if (!comp[q]) { comp[q] = 1; stack[sp++] = q; } }
        else { perim++; nbCount[labels[q]]++; }
      }
    }
    if (!perim) continue;
    if (size < minArea || (2 * size) / perim < minWidth) {
      let best = 0;
      for (let c = 1; c < K; c++) if (nbCount[c] > nbCount[best]) best = c;
      for (const p of members) labels[p] = best;
      changed = true;
    }
  }
  return changed;
}

export function posterize(px, { colors = 10, smooth = 2, cleanup = 2 } = {}) {
  const { w, h, data } = px;
  const n = w * h;
  const lab = toLab(blurRGB(data, w, h, Math.round(Math.max(w, h) / 400)));
  let { labels, centers } = kmeans(lab, n, colors);
  const K = centers.length;
  for (let i = 0; i < smooth * 2; i++) labels = modeFilter(labels, w, h, K);
  if (cleanup > 0) {
    const minArea = Math.round(n * [0, 0.0002, 0.0006, 0.0015, 0.003, 0.006][cleanup]);
    const minWidth = [0, 2, 3, 4, 5, 6][cleanup] * Math.max(w, h) / 1000;
    for (let i = 0; i < 3 && removeSmall(labels, w, h, K, minArea, minWidth); i++);
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

// Векторизация: каждая область превращается в замкнутый путь из линий и кривых Безье.
// smooth 0..5 — чем больше, тем глаже и проще кривые.
export function traceRegions(poster, smooth = 2) {
  const { w, h, labels, palette } = poster;
  // каждой метке — уникальный цвет, чтобы трассировщик разделил области ровно по меткам
  const ids = [];
  palette.forEach((p, i) => { if (p) ids.push(i); });
  const key = (i) => ({ r: (i * 37) & 255, g: (i * 91 + 40) & 255, b: (i * 151 + 80) & 255, a: 255 });
  const pal = ids.map(key);
  const remap = new Int16Array(palette.length).fill(-1);
  ids.forEach((id, k) => (remap[id] = k));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < labels.length; i++) {
    const c = pal[remap[labels[i]]];
    data[i * 4] = c.r; data[i * 4 + 1] = c.g; data[i * 4 + 2] = c.b; data[i * 4 + 3] = 255;
  }
  const tol = 0.8 + smooth * 0.6;
  const td = window.ImageTracer.imagedataToTracedata({ width: w, height: h, data }, {
    pal, colorquantcycles: 1, pathomit: 0, ltres: tol, qtres: tol,
    rightangleenhance: false, blurradius: 0, linefilter: false, roundcoords: 2,
  });
  const fmt = (n) => +n.toFixed(2);
  const sub = (path) => {
    const seg = path.segments;
    if (!seg.length) return '';
    let d = `M${fmt(seg[0].x1)} ${fmt(seg[0].y1)}`;
    for (const s of seg) d += s.type === 'L' ? `L${fmt(s.x2)} ${fmt(s.y2)}` : `Q${fmt(s.x2)} ${fmt(s.y2)} ${fmt(s.x3)} ${fmt(s.y3)}`;
    return d + 'Z';
  };
  const shapes = [];
  td.layers.forEach((layer, k) => {
    const color = palette[ids[k]];
    for (const path of layer) {
      if (path.isholepath) continue;
      const outer = sub(path);
      if (!outer) continue;
      const holes = path.holechildren.map((hi) => sub(layer[hi])).join('');
      shapes.push({ color, outer, holes });
    }
  });
  return { w, h, shapes, edges: traceEdges(labels, w, h, smooth) };
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

// SVG со сплошными цветными областями (обводка тем же цветом закрывает щели между соседями)
export function colorSvg(trace) {
  const paths = trace.shapes.map((s) => `<path fill="${rgb(s.color)}" stroke="${rgb(s.color)}" d="${s.outer}${s.holes}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${trace.w} ${trace.h}"><g fill-rule="evenodd" stroke-width="0.8" stroke-linejoin="round">${paths}</g></svg>`;
}

// Контур строится отдельно от заливок: граф границ между пикселями разных областей.
// Каждая граница между двумя соседями — ровно одна линия от развилки до развилки,
// поэтому линии не двоятся. Линии сглаживаются (концы на развилках закреплены,
// чтобы линии сходились), упрощаются и выводятся кривыми Безье.
function traceEdges(labels, w, h, smooth) {
  const W1 = w + 1;
  const lab = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : labels[y * w + x]);
  // H[y*w+x]: отрезок (x,y)–(x+1,y); V[y*W1+x]: отрезок (x,y)–(x,y+1)
  const H = new Uint8Array(w * (h + 1));
  const V = new Uint8Array(W1 * h);
  for (let y = 0; y <= h; y++) for (let x = 0; x < w; x++) if (lab(x, y - 1) !== lab(x, y)) H[y * w + x] = 1;
  for (let y = 0; y < h; y++) for (let x = 0; x <= w; x++) if (lab(x - 1, y) !== lab(x, y)) V[y * W1 + x] = 1;
  const D = new Uint8Array(W1 * (h + 1));
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      D[y * W1 + x] = (x < w ? H[y * w + x] : 0) + (x > 0 ? H[y * w + x - 1] : 0)
        + (y < h ? V[y * W1 + x] : 0) + (y > 0 ? V[(y - 1) * W1 + x] : 0);
    }
  }
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) D[y * W1 + x] = 9; // углы рамки не скругляем
  const step = (x, y) => {
    if (x < w && H[y * w + x]) { H[y * w + x] = 0; return [x + 1, y]; }
    if (x > 0 && H[y * w + x - 1]) { H[y * w + x - 1] = 0; return [x - 1, y]; }
    if (y < h && V[y * W1 + x]) { V[y * W1 + x] = 0; return [x, y + 1]; }
    if (y > 0 && V[(y - 1) * W1 + x]) { V[(y - 1) * W1 + x] = 0; return [x, y - 1]; }
    return null;
  };
  const walk = (x, y) => {
    const pts = [x, y];
    let p = step(x, y);
    while (p) {
      pts.push(p[0], p[1]);
      if (D[p[1] * W1 + p[0]] !== 2) break;
      p = step(p[0], p[1]);
    }
    return pts;
  };
  const chains = [];
  // сначала линии между развилками, потом оставшиеся замкнутые петли
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y <= h; y++) {
      for (let x = 0; x <= w; x++) {
        const d = D[y * W1 + x];
        if (!d || (pass === 0 && d === 2)) continue;
        while (true) {
          const pts = walk(x, y);
          if (pts.length < 4) break;
          chains.push(pts);
        }
      }
    }
  }
  const iters = 2 + smooth * 3;
  return chains.map((c) => curve(smoothChain(c, iters, D, W1)));
}

function smoothChain(flat, iters, D, W1) {
  const n = flat.length / 2;
  const closed = n > 2 && flat[0] === flat[flat.length - 2] && flat[1] === flat[flat.length - 1];
  let pts = [];
  for (let i = 0; i < (closed ? n - 1 : n); i++) pts.push([flat[i * 2], flat[i * 2 + 1]]);
  // замкнутую петлю, проходящую через развилку, сглаживаем с закреплённой развилкой
  const pinned = closed && D[pts[0][1] * W1 + pts[0][0]] !== 2;
  const m = pts.length;
  for (let k = 0; k < iters; k++) {
    const next = pts.map((p) => p.slice());
    for (let i = 0; i < m; i++) {
      if (!closed && (i === 0 || i === m - 1)) continue;
      if (pinned && i === 0) continue;
      const a = pts[(i - 1 + m) % m], b = pts[(i + 1) % m];
      next[i][0] = (a[0] + 2 * pts[i][0] + b[0]) / 4;
      next[i][1] = (a[1] + 2 * pts[i][1] + b[1]) / 4;
    }
    pts = next;
  }
  return { pts: simplify(pts, closed, 0.35), closed };
}

// Дуглас–Пекер
function simplify(pts, closed, eps) {
  if (pts.length < 4) return pts;
  const src = closed ? [...pts, pts[0]] : pts;
  const keep = new Uint8Array(src.length);
  keep[0] = keep[src.length - 1] = 1;
  const stack = [[0, src.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = src[a], [bx, by] = src[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let best = -1, bd = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((src[i][0] - ax) * dy - (src[i][1] - ay) * dx) / len;
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = src.filter((_, i) => keep[i]);
  if (closed) out.pop();
  return out.length >= (closed ? 3 : 2) ? out : pts;
}

// Ломаная → гладкая кривая (Catmull-Rom в кубические Безье)
function curve({ pts, closed }) {
  const n = pts.length;
  const f = (v) => +v.toFixed(2);
  const at = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} `
      + `${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return closed ? d + 'Z' : d;
}

// SVG только с контуром; strokeWidth в единицах viewBox
export function lineSvg(trace, strokeWidth, ink = '#111') {
  const paths = trace.edges.map((d) => `<path d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${trace.w} ${trace.h}"><g fill="none" stroke="${ink}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round">${paths}</g></svg>`;
}

// Вписываем рисунок в холст с полями
export function placeRect(cw, ch, W, H, margin = 0.06) {
  const s = Math.min((W * (1 - 2 * margin)) / cw, (H * (1 - 2 * margin)) / ch);
  const w = Math.round(cw * s), h = Math.round(ch * s);
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
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
