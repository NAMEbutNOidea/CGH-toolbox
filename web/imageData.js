/**
 * 图像载荷解码与上色（imageView 与 zoom 共用）。
 * 契约 §0：uint16 小端、行优先；值 = u16 / 65535 * vmax。
 */

function base64Bytes(text) {
  if (typeof text !== 'string' || text.length === 0) return new Uint8Array(0);
  const bin = window.atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function jet(t) {
  return [
    clamp01(1.5 - Math.abs(4 * t - 3)),
    clamp01(1.5 - Math.abs(4 * t - 2)),
    clamp01(1.5 - Math.abs(4 * t - 1)),
  ];
}

function gray(t) {
  return [t, t, t];
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 256 级色表，把 log 与 gamma 折进 LUT，逐像素只做一次查表。 */
export function buildLut(cmap, scale, gamma) {
  const lut = new Uint8Array(768);
  const sampler = cmap === 'jet' ? jet : gray;
  const g = Number.isFinite(gamma) && gamma > 0 ? gamma : 1;
  for (let i = 0; i < 256; i += 1) {
    let t = i / 255;
    if (scale === 'log') t = Math.log10(1 + 999 * t) / 3;
    if (g !== 1) t = Math.pow(t, g);
    const rgb = sampler(clamp01(t));
    lut[i * 3] = Math.round(rgb[0] * 255);
    lut[i * 3 + 1] = Math.round(rgb[1] * 255);
    lut[i * 3 + 2] = Math.round(rgb[2] * 255);
  }
  return lut;
}

const lutCache = new Map();

export function lutFor(display) {
  const sig = `${display.cmap}|${display.scale}|${display.gamma}`;
  if (!lutCache.has(sig)) {
    if (lutCache.size > 6) lutCache.clear();
    lutCache.set(sig, buildLut(display.cmap, display.scale, display.gamma));
  }
  return lutCache.get(sig);
}

export function decodeImage(img) {
  const w = Math.max(1, Math.round(numberOr(img.w, 1)));
  const h = Math.max(1, Math.round(numberOr(img.h, 1)));
  const bytes = base64Bytes(img.data);
  const phase = img.kind === 'phase';
  const meta = {
    w,
    h,
    phase,
    vmax: numberOr(img.vmax, 1),
    unit: img.unit || 'mm',
    x0: numberOr(img.x0, 0),
    x1: numberOr(img.x1, w),
    y0: numberOr(img.y0, 0),
    y1: numberOr(img.y1, h),
    vmaxWindows: numberOr(img.vmax_windows, 0) > 0 ? img.vmax_windows : null,
    u16: null,
    u8: null,
  };
  if (phase) {
    meta.u8 = bytes;
  } else {
    const n = w * h;
    const u16 = new Uint16Array(n);
    const limit = Math.min(n, bytes.length >> 1);
    for (let i = 0, j = 0; i < limit; i += 1, j += 2) {
      u16[i] = bytes[j] | (bytes[j + 1] << 8);
    }
    meta.u16 = u16;
  }
  return meta;
}

let scratch = null;

function scratchCtx(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  return scratch.getContext('2d');
}

/** 当前显示设置下的亮度增益：窗口归一化时按窗口峰值放大（截断到满量程）。 */
export function displayGain(meta, display) {
  const mode = (display && display.vmaxMode) || 'window';
  if (mode === 'window' && meta.vmaxWindows && meta.vmax > 0) {
    return Math.max(1, meta.vmax / meta.vmaxWindows);
  }
  return 1;
}

/** 按当前显示设置把整幅图渲染成 ImageData（可直接 putImageData 到同尺寸 canvas）。 */
export function paintToImageData(meta, display) {
  const lut = lutFor(display);
  const gain = displayGain(meta, display);
  const ctx = scratchCtx(meta.w, meta.h);
  const image = ctx.createImageData(meta.w, meta.h);
  const data = image.data;
  const n = meta.w * meta.h;
  if (meta.phase) {
    const u8 = meta.u8 || new Uint8Array(0);
    for (let i = 0; i < n; i += 1) {
      const c = (u8[i] || 0) * 3;
      const o = i * 4;
      data[o] = lut[c];
      data[o + 1] = lut[c + 1];
      data[o + 2] = lut[c + 2];
      data[o + 3] = 255;
    }
  } else {
    const u16 = meta.u16 || new Uint16Array(0);
    for (let i = 0; i < n; i += 1) {
      let idx = Math.round((u16[i] / 65535) * gain * 255);
      if (idx > 255) idx = 255;
      const c = idx * 3;
      const o = i * 4;
      data[o] = lut[c];
      data[o + 1] = lut[c + 1];
      data[o + 2] = lut[c + 2];
      data[o + 3] = 255;
    }
  }
  return image;
}

/** 物理坐标（mm）→ 图内像素坐标。y0 在上（图已按 +y 朝上翻转过）。 */
export function mmToPixel(meta, xMm, yMm) {
  const fx = (xMm - meta.x0) / (meta.x1 - meta.x0 || 1);
  const fy = (yMm - meta.y0) / (meta.y1 - meta.y0 || 1);
  return { px: fx * meta.w, py: fy * meta.h };
}

export function pixelToMm(meta, px, py) {
  return {
    x: meta.x0 + ((px + 0.5) / meta.w) * (meta.x1 - meta.x0),
    y: meta.y0 + ((py + 0.5) / meta.h) * (meta.y1 - meta.y0),
  };
}

export function sampleAt(meta, px, py) {
  const x = Math.min(meta.w - 1, Math.max(0, Math.floor(px)));
  const y = Math.min(meta.h - 1, Math.max(0, Math.floor(py)));
  const i = y * meta.w + x;
  if (meta.phase) return { rel: null, phaseRad: ((meta.u8[i] || 0) / 255) * Math.PI * 2 };
  return { rel: (meta.u16[i] || 0) / 65535, phaseRad: null };
}
