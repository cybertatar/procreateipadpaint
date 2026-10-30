import {
  loadImage, makeCanvas, imageToPixels, posterize, traceRegions, colorSvg, lineSvg,
  placeRect, renderImageLayer, renderSvgLayer,
} from './lineart.js';
import { buildPsd, buildSwatches, deliver, hexToRgb, rgbToHex, safeName } from './export.js';
import { listMine, getMine, putMine, deleteMine } from './store.js';

const tg = window.Telegram?.WebApp?.initData !== undefined && window.Telegram.WebApp.platform !== 'unknown'
  ? window.Telegram.WebApp : null;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const SIZES = {
  ipad: [2732, 2048],
  a4: [3508, 2480],
  square: [2048, 2048],
  print: [4096, 3072],
};
const PROCESS_SIDE = 1000;   // разрешение, на котором ищем области
const PREVIEW_SIDE = 1100;   // разрешение превью
const SVG_BASE_STROKE = 4;   // основная толщина линий в SVG каталога

let catalog = [];
let tab = 'catalog';
let cur = null;       // открытая раскраска
let psdBlob = null;   // готовый PSD, ждёт нажатия «Открыть в Procreate»
let renderSeq = 0;

/* ---------- Telegram и тема ---------- */
function applyTheme() {
  const dark = tg ? tg.colorScheme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  if (tg) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    tg.setHeaderColor?.(bg);
    tg.setBackgroundColor?.(bg);
  }
}
if (tg) {
  tg.ready();
  tg.expand();
  tg.onEvent('themeChanged', applyTheme);
  tg.BackButton.onClick(() => show('home'));
}
applyTheme();
const haptic = (t) => tg?.HapticFeedback?.notificationOccurred(t);

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3500);
}

function confirmAsk(text) {
  if (tg?.showConfirm) return new Promise((r) => tg.showConfirm(text, r));
  return Promise.resolve(confirm(text));
}

/* ---------- Навигация ---------- */
function show(view) {
  $$('.view').forEach((v) => (v.hidden = v.id !== view));
  window.scrollTo(0, 0);
  if (tg) view === 'home' ? tg.BackButton.hide() : tg.BackButton.show();
  if (view === 'home') { cur = null; renderGrid(); }
}
if (!tg) {
  // вне Telegram — своя кнопка «Назад»
  for (const id of ['editor', 'about']) {
    const b = document.createElement('button');
    b.className = 'link back';
    b.textContent = 'Назад к списку';
    b.style.marginBottom = '14px';
    b.onclick = () => show('home');
    $('#' + id).prepend(b);
  }
}
$$('[data-go]').forEach((b) => (b.onclick = () => show(b.dataset.go)));

/* ---------- Главная ---------- */
$$('.tabs button').forEach((b) => (b.onclick = () => {
  tab = b.dataset.tab;
  $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  renderGrid();
}));

function card(name, meta, src, onClick) {
  const b = document.createElement('button');
  b.className = 'card';
  b.innerHTML = `<span class="thumb"><img alt="" loading="lazy"></span><span class="name"></span><span class="meta"></span>`;
  b.querySelector('img').src = src;
  b.querySelector('.name').textContent = name;
  b.querySelector('.meta').textContent = meta;
  b.onclick = onClick;
  return b;
}

async function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '<p class="empty">Загружаю…</p>';
  try {
    if (tab === 'catalog') {
      if (!catalog.length) catalog = (await (await fetch('catalog/catalog.json')).json()).items;
      grid.innerHTML = '';
      for (const it of catalog) grid.append(card(it.name, it.tag || '', 'catalog/' + it.file, () => openCatalog(it)));
    } else {
      const mine = await listMine();
      grid.innerHTML = '';
      if (!mine.length) {
        grid.innerHTML = '<p class="empty"><strong>Здесь пока пусто</strong>Сделайте раскраску из фото и нажмите «Сохранить в „Мои“». Она будет храниться на этом устройстве.</p>';
        return;
      }
      for (const it of mine) {
        const url = URL.createObjectURL(it.thumb);
        grid.append(card(it.name, new Date(it.created).toLocaleDateString('ru-RU'), url, () => openMine(it.id)));
      }
    }
  } catch (e) {
    grid.innerHTML = `<p class="empty"><strong>Не получилось загрузить</strong>${e.message || e}</p>`;
  }
}

/* ---------- Открытие ---------- */
$('#file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const img = await loadImage(URL.createObjectURL(f));
    openPhoto({ name: f.name.replace(/\.[^.]+$/, '') || 'Моя раскраска', img, id: null });
  } catch (err) {
    toast('Не удалось открыть файл. Попробуйте JPG или PNG.');
  }
};

async function openCatalog(it) {
  try {
    const svgText = await (await fetch('catalog/' + it.file)).text();
    const [, , vw, vh] = svgText.match(/viewBox="([^"]+)"/)[1].split(/[\s,]+/).map(Number);
    cur = { kind: 'catalog', name: it.name, svgText, aspect: vw / vh, vw, vh, palette: it.palette.map(hexToRgb) };
    openEditor();
  } catch (e) {
    toast('Не удалось открыть раскраску');
  }
}

async function openMine(id) {
  const it = await getMine(id);
  if (!it) return toast('Раскраска не найдена');
  const img = await loadImage(URL.createObjectURL(it.photo));
  openPhoto({ name: it.name, img, id: it.id, settings: it.settings });
}

function openPhoto({ name, img, id, settings }) {
  const px = imageToPixels(img, PROCESS_SIDE);
  cur = { kind: 'photo', name, img, px, aspect: px.w / px.h, id, poster: null, posterKey: '' };
  if (settings) for (const [k, v] of Object.entries(settings)) { const el = $('#' + k); if (el) el.value = v; }
  openEditor();
}

function openEditor() {
  const photo = cur.kind === 'photo';
  $$('.photo-only').forEach((el) => (el.hidden = !photo));
  $('#layer-toggles').hidden = !photo;
  $('#btn-delete').hidden = !(photo && cur.id);
  $('#btn-save').textContent = photo && cur.id ? 'Сохранить изменения' : 'Сохранить в «Мои»';
  $('#title').value = cur.name;
  $('[data-layer="color"]').checked = true;
  $('[data-layer="orig"]').checked = false;
  setStatus('');
  show('editor');
  syncOutputs();
  invalidate();
}

/* ---------- Настройки и превью ---------- */
function canvasDims() {
  let [a, b] = SIZES[$('#canvas-size').value];
  if (a === b) return [a, b];
  const long = Math.max(a, b), short = Math.min(a, b);
  return cur.aspect >= 1 ? [long, short] : [short, long];
}
const thickPx = (W, H) => Number($('#thick').value) * Math.max(W, H) / 1000;

function syncOutputs() {
  $$('output[data-for]').forEach((o) => (o.textContent = $('#' + o.dataset.for).value));
}

function setBusy(on, text = 'Обрабатываю') {
  $('#busy').hidden = !on;
  $('#busy-text').textContent = text;
}

function setStatus(text, error = false) {
  const s = $('#status');
  s.textContent = text;
  s.classList.toggle('error', error);
}

function resetPsd() {
  psdBlob = null;
  const b = $('#btn-psd');
  b.textContent = 'Подготовить PSD для Procreate';
  b.classList.remove('ready');
  b.disabled = false;
}

let debounce;
function invalidate() {
  resetPsd();
  clearTimeout(debounce);
  setBusy(true);
  debounce = setTimeout(renderPreview, 60);
}

['colors', 'smooth', 'cleanup', 'thick'].forEach((id) => $('#' + id).addEventListener('input', () => {
  syncOutputs();
  clearTimeout(debounce);
  resetPsd();
  setBusy(true);
  debounce = setTimeout(renderPreview, 250);
}));
$('#canvas-size').onchange = invalidate;
$$('#layer-toggles input').forEach((i) => (i.onchange = renderPreview));
$('#inc-blank').onchange = resetPsd;
$('#inc-orig').onchange = resetPsd;
$('#title').oninput = () => { cur.name = $('#title').value; resetPsd(); };

// даём браузеру нарисовать индикатор загрузки перед тяжёлой работой
// (в фоновой вкладке rAF не срабатывает, поэтому есть запасной таймер)
const nextFrame = () => new Promise((r) => {
  const t = setTimeout(r, 50);
  requestAnimationFrame(() => setTimeout(() => { clearTimeout(t); r(); }, 0));
});

function ensureTrace() {
  const key = ['colors', 'smooth', 'cleanup'].map((id) => $('#' + id).value).join('|');
  if (cur.posterKey !== key) {
    const smooth = Number($('#smooth').value);
    cur.poster = posterize(cur.px, {
      colors: Number($('#colors').value), smooth, cleanup: Number($('#cleanup').value),
    });
    cur.trace = traceRegions(cur.poster, smooth);
    cur.posterKey = key;
  }
  return cur.trace;
}

// толщина px на холсте W×H → единицы viewBox рисунка шириной vw
function strokeUnits(vw, vh, W, H, px) {
  return px / (placeRect(vw, vh, W, H).w / vw);
}

async function lineLayer(W, H, px) {
  if (cur.kind === 'catalog') return renderSvgLayer(cur.svgText, W, H, strokeUnits(cur.vw, cur.vh, W, H, px) / SVG_BASE_STROKE);
  const t = ensureTrace();
  return renderSvgLayer(lineSvg(t, strokeUnits(t.w, t.h, W, H, px)), W, H);
}

async function colorLayer(W, H) {
  return renderSvgLayer(colorSvg(ensureTrace()), W, H);
}

// векторный контур для отдельного скачивания
function contourSvgText() {
  const [W, H] = canvasDims();
  const px = thickPx(W, H);
  if (cur.kind === 'catalog') {
    const s = strokeUnits(cur.vw, cur.vh, W, H, px) / SVG_BASE_STROKE;
    return cur.svgText.replace(/stroke-width="([\d.]+)"/g, (_, v) => `stroke-width="${+(v * s).toFixed(2)}"`);
  }
  const t = ensureTrace();
  return lineSvg(t, +strokeUnits(t.w, t.h, W, H, px).toFixed(2));
}

async function renderPreview() {
  const seq = ++renderSeq;
  const it = cur;
  if (!it) return;
  setBusy(true);
  await nextFrame();
  try {
    const [W, H] = canvasDims();
    const s = Math.min(1, PREVIEW_SIDE / Math.max(W, H));
    const pw = Math.round(W * s), ph = Math.round(H * s);
    const lines = await lineLayer(pw, ph, thickPx(W, H) * s);
    const color = it.kind === 'photo' && $('[data-layer="color"]').checked ? await colorLayer(pw, ph) : null;
    if (seq !== renderSeq || it !== cur) return;
    const c = $('#preview');
    c.width = pw; c.height = ph;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pw, ph);
    if (color) ctx.drawImage(color, 0, 0);
    if (it.kind === 'photo' && $('[data-layer="orig"]').checked) {
      ctx.globalAlpha = 0.45;
      ctx.drawImage(renderImageLayer(it.img, it.px.w, it.px.h, pw, ph), 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(lines, 0, 0);
    renderPalette();
    setBusy(false);
  } catch (e) {
    console.error(e);
    if (seq === renderSeq) { setBusy(false); setStatus('Ошибка обработки: ' + (e.message || e), true); }
  }
}

function currentPalette() {
  return cur.kind === 'catalog' ? cur.palette : (cur.poster?.swatches || []);
}

function renderPalette() {
  const el = $('#palette');
  el.innerHTML = '';
  for (const c of currentPalette().slice(0, 30)) {
    const sw = document.createElement('span');
    sw.style.background = rgbToHex(c);
    sw.title = rgbToHex(c);
    el.append(sw);
  }
}

/* ---------- Экспорт ---------- */
async function preparePsd() {
  const it = cur;
  const [W, H] = canvasDims();
  const lines = await lineLayer(W, H, thickPx(W, H));
  const bg = makeCanvas(W, H);
  const bctx = bg.getContext('2d');
  bctx.fillStyle = '#ffffff';
  bctx.fillRect(0, 0, W, H);
  const layers = [{ name: 'Фон', canvas: bg }];
  if (it.kind === 'photo') {
    if ($('#inc-orig').checked) layers.push({ name: 'Оригинал', canvas: renderImageLayer(it.img, it.px.w, it.px.h, W, H), hidden: true });
    layers.push({ name: 'Цвет', canvas: await colorLayer(W, H) });
    if ($('#inc-blank').checked) layers.push({ name: 'Раскраска', canvas: makeCanvas(W, H) });
  } else {
    layers.push({ name: 'Цвет', canvas: makeCanvas(W, H) });
  }
  layers.push({ name: 'Контур', canvas: lines });
  return buildPsd(W, H, layers);
}

$('#btn-psd').onclick = async () => {
  const b = $('#btn-psd');
  if (psdBlob) {
    const how = await deliver(psdBlob, safeName(cur.name) + '.psd');
    if (how === 'downloaded') setStatus('Файл сохранён. Откройте его в Procreate через «Файлы» или «Импорт» в галерее.');
    if (how === 'shared') { setStatus('Готово'); haptic('success'); }
    return;
  }
  if (!window.agPsd) return setStatus('Библиотека PSD ещё загружается, попробуйте через пару секунд.', true);
  b.disabled = true;
  setBusy(true, 'Собираю PSD');
  setStatus('');
  await nextFrame();
  try {
    psdBlob = await preparePsd();
    b.textContent = `Открыть в Procreate · ${(psdBlob.size / 1048576).toFixed(1)} МБ`;
    b.classList.add('ready');
    haptic('success');
  } catch (e) {
    console.error(e);
    setStatus('Не удалось собрать PSD: ' + (e.message || e) + '. Попробуйте холст поменьше.', true);
    haptic('error');
  } finally {
    b.disabled = false;
    setBusy(false);
  }
};

$('#btn-swatches').onclick = async () => {
  const pal = currentPalette();
  if (!pal.length) return setStatus('Палитра ещё не готова', true);
  if (!window.fflate) return setStatus('Библиотека ещё загружается, попробуйте через пару секунд.', true);
  const how = await deliver(buildSwatches(cur.name, pal), safeName(cur.name) + '.swatches');
  if (how === 'downloaded') setStatus('Палитра сохранена. Откройте файл .swatches, Procreate добавит её во вкладку «Палитры».');
};

$('#btn-svg').onclick = async () => {
  try {
    const blob = new Blob([contourSvgText()], { type: 'image/svg+xml' });
    const how = await deliver(blob, safeName(cur.name) + '-kontur.svg');
    if (how === 'downloaded') setStatus('Векторный контур сохранён в SVG.');
  } catch (e) {
    setStatus('Не удалось сохранить SVG: ' + (e.message || e), true);
  }
};

$('#btn-save').onclick = async () => {
  if (cur.kind !== 'photo') return;
  const b = $('#btn-save');
  b.disabled = true;
  try {
    // фото храним уменьшенным до 2048 px, превью — из текущего рендера
    const ph = makeCanvas(...fit(cur.img, 2048));
    ph.getContext('2d').drawImage(cur.img, 0, 0, ph.width, ph.height);
    const prev = $('#preview');
    const th = makeCanvas(...fit(prev, 400));
    th.getContext('2d').drawImage(prev, 0, 0, th.width, th.height);
    const toBlob = (c, q) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    const item = {
      id: cur.id || String(Date.now()),
      name: $('#title').value.trim() || 'Моя раскраска',
      created: Date.now(),
      photo: await toBlob(ph, 0.9),
      thumb: await toBlob(th, 0.85),
      settings: Object.fromEntries(['colors', 'smooth', 'cleanup', 'thick', 'canvas-size'].map((k) => [k, $('#' + k).value])),
    };
    await putMine(item);
    cur.id = item.id;
    $('#btn-delete').hidden = false;
    b.textContent = 'Сохранить изменения';
    toast('Сохранено в «Мои»');
    haptic('success');
  } catch (e) {
    toast('Не удалось сохранить: ' + (e.message || e));
  } finally {
    b.disabled = false;
  }
};

$('#btn-delete').onclick = async () => {
  if (!cur.id || !(await confirmAsk('Удалить эту раскраску из «Мои»?'))) return;
  await deleteMine(cur.id);
  toast('Удалено');
  tab = 'mine';
  $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === 'mine')));
  show('home');
};

function fit(src, max) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.round(w * s), Math.round(h * s)];
}

renderGrid();
