/**
 * 图像卡片：解码 → LUT 上色 → canvas 绘制 → 悬停读数；总览图额外标出 0/+1 窗口。
 * 点击任意图像打开大图查看器（滚轮缩放 / 拖拽平移）。
 */

import { fmtNum } from './state.js';
import { decodeImage, paintToImageData, mmToPixel, pixelToMm, sampleAt } from './imageData.js';
import { openZoom } from './zoom.js';

const SLOTS = [
  { key: 'near_overview', title: '近场 · 总览' },
  { key: 'near_zero', title: '近场 · 零级' },
  { key: 'near_plus', title: '近场 · 一级' },
  { key: 'near_ideal', title: '近场 · 理想一级' },
  { key: 'far_overview', title: '远场 · 总览' },
  { key: 'far_zero', title: '远场 · 零级' },
  { key: 'far_plus', title: '远场 · 一级' },
  { key: 'far_ideal', title: '远场 · 理想一级' },
  { key: 'phase', title: '相位图 · 0 – 2π', wide: true },
];

export function createImageView(host) {
  let display = { cmap: 'gray', scale: 'linear', gamma: 0.7 };
  let images = null;
  let overlays = {};
  let cards = [];

  function drawCard(card) {
    const meta = card.meta;
    if (!meta) return;
    const sig = `${display.cmap}|${display.scale}|${display.gamma}|${display.vmaxMode || 'window'}`;
    if (card.sig === sig && card.drawn) return;
    card.ctx.putImageData(paintToImageData(meta, display), 0, 0);
    card.sig = sig;
    card.drawn = true;
  }

  function readoutText(meta, mm, sample) {
    const xs = fmtNum(mm.x, 2);
    const ys = fmtNum(mm.y, 2);
    if (meta.phase) return `x ${xs} mm · y ${ys} mm · 相位 ${fmtNum(sample.phaseRad, 2)} rad`;
    return `x ${xs} mm · y ${ys} mm · 强度 ${fmtNum(sample.rel)}（Imax ${fmtNum(meta.vmax)}）`;
  }

  function attachHover(card) {
    const canvas = card.canvas;
    const meta = card.meta;
    canvas.addEventListener('pointermove', (event) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const fx = (event.clientX - rect.left) / rect.width;
      const fy = (event.clientY - rect.top) / rect.height;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
      const px = Math.min(meta.w - 1, Math.max(0, Math.floor(fx * meta.w)));
      const py = Math.min(meta.h - 1, Math.max(0, Math.floor(fy * meta.h)));
      card.readout.textContent = readoutText(meta, pixelToMm(meta, px, py), sampleAt(meta, px, py));
      card.readout.classList.add('active');
    });
    canvas.addEventListener('pointerleave', () => {
      card.readout.textContent = card.idle;
      card.readout.classList.remove('active');
    });
  }

  /** 总览图上的窗口框：用百分比定位的 DOM，随卡片缩放，文字不糊。 */
  function buildBoxes(meta, boxes) {
    const layer = document.createElement('div');
    layer.className = 'img-boxes';
    for (const box of boxes) {
      const a = mmToPixel(meta, box.cx - box.hx, box.cy - box.hy);
      const b = mmToPixel(meta, box.cx + box.hx, box.cy + box.hy);
      const left = (Math.min(a.px, b.px) / meta.w) * 100;
      const top = (Math.min(a.py, b.py) / meta.h) * 100;
      const width = (Math.abs(b.px - a.px) / meta.w) * 100;
      const height = (Math.abs(b.py - a.py) / meta.h) * 100;
      const el = document.createElement('div');
      el.className = `img-box ${box.kind}`;
      el.style.left = `${left}%`;
      el.style.top = `${top}%`;
      el.style.width = `${width}%`;
      el.style.height = `${height}%`;
      el.title = `${box.label} 评价窗口：中心 (${fmtNum(box.cx, 2)}, ${fmtNum(box.cy, 2)}) mm，`
        + `半宽 ${fmtNum(box.hx, 2)} × ${fmtNum(box.hy, 2)} mm`;
      const tag = document.createElement('span');
      tag.className = 'img-box-tag';
      tag.textContent = box.label;
      // 0 级标签放框下方，其余放上方：三个窗口挨得近时不会撞在一起
      tag.style.top = box.kind === 'zero' || top < 8 ? '100%' : '-1.4em';
      el.append(tag);
      layer.append(el);
    }
    return layer;
  }

  function buildCard(slot, img) {
    const meta = decodeImage(img);
    const canvas = document.createElement('canvas');
    canvas.width = meta.w;
    canvas.height = meta.h;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${slot.title}，强度分布`);
    canvas.title = `${slot.title}：点击放大，悬停查看坐标与强度`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const idle = meta.phase ? '悬停查看坐标与相位' : '悬停查看坐标与强度';
    const readout = document.createElement('p');
    readout.className = 'img-readout mono';
    readout.textContent = idle;

    const wrap = document.createElement('div');
    wrap.className = 'img-canvas-wrap';
    wrap.append(canvas);
    const boxes = overlays[slot.key];
    if (boxes && boxes.length) wrap.append(buildBoxes(meta, boxes));

    const plot = document.createElement('div');
    plot.className = 'plot';
    plot.append(
      axisLabel('tick x0', fmtNum(meta.x0, 2)),
      axisLabel('tick x1', fmtNum(meta.x1, 2)),
      axisLabel('tick y1', fmtNum(meta.y1, 2)),
      axisLabel('tick y0', fmtNum(meta.y0, 2)),
      wrap,
    );

    const fig = document.createElement('figure');
    fig.className = slot.wide ? 'img-card wide' : 'img-card';
    const head = document.createElement('figcaption');
    head.className = 'img-head';
    const title = document.createElement('span');
    title.className = 'img-title';
    title.textContent = slot.title;
    const metaText = document.createElement('span');
    metaText.className = 'img-meta mono';
    metaText.textContent = `${meta.w}×${meta.h}`;
    metaText.title = meta.phase ? '相位 0..2π' : `vmax = ${fmtNum(meta.vmax)} ${meta.unit}`;
    head.append(title, metaText);
    fig.append(head, plot, readout);

    const card = { node: fig, canvas, ctx, meta, sig: '', drawn: false, readout, idle };
    attachHover(card);
    wrap.addEventListener('click', () => {
      openZoom({ title: slot.title, meta, display, boxes });
    });
    return card;
  }

  function axisLabel(cls, text) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    return span;
  }

  function build() {
    host.replaceChildren();
    cards = [];
    if (!images) return;
    for (const slot of SLOTS) {
      const img = images[slot.key];
      if (!img || !img.data) continue;
      const card = buildCard(slot, img);
      if (!card) continue;
      cards.push(card);
      host.append(card.node);
    }
  }

  function redraw() {
    for (const card of cards) drawCard(card);
  }

  return {
    setData(next, nextOverlays) {
      images = next || null;
      overlays = nextOverlays || {};
      build();
      redraw();
    },
    setDisplay(next) {
      display = Object.assign({}, display, next || {});
      redraw();
    },
    getDisplay() {
      return Object.assign({}, display);
    },
    clear() {
      images = null;
      overlays = {};
      cards = [];
      host.replaceChildren();
    },
    count() {
      return cards.length;
    },
  };
}
