// Экспорт для Procreate: многослойный PSD (Procreate открывает его со слоями)
// и палитра .swatches (zip с Swatches.json).

// layers: снизу вверх, [{ name, canvas, hidden }]
export function buildPsd(W, H, layers) {
  const composite = document.createElement('canvas');
  composite.width = W; composite.height = H;
  const ctx = composite.getContext('2d');
  for (const l of layers) if (!l.hidden && l.canvas) ctx.drawImage(l.canvas, 0, 0);
  const psd = {
    width: W,
    height: H,
    canvas: composite,
    children: layers.map((l) => ({ name: l.name, canvas: l.canvas, hidden: !!l.hidden, opacity: l.opacity ?? 1 })),
  };
  const buf = window.agPsd.writePsd(psd, { generateThumbnail: false });
  return new Blob([buf], { type: 'image/vnd.adobe.photoshop' });
}

function rgbToHsb([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return { hue: h, saturation: max ? d / max : 0, brightness: max };
}

export function buildSwatches(name, colors) {
  const json = JSON.stringify([{
    name,
    swatches: colors.slice(0, 30).map((c) => ({ ...rgbToHsb(c), alpha: 1, colorSpace: 0 })),
  }]);
  const zip = window.fflate.zipSync({ 'Swatches.json': window.fflate.strToU8(json) }, { level: 0 });
  return new Blob([zip], { type: 'application/zip' });
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function safeName(s) {
  return (s || 'raskraska').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 60) || 'raskraska';
}

// Отдаём файл: на iPad через системное меню «Поделиться» (там есть Procreate),
// иначе обычным скачиванием. Вызывать прямо из обработчика нажатия.
export async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}
