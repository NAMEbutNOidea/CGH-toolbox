/**
 * 大图查看器：点击卡片打开，滚轮以光标为中心缩放，拖拽平移，双击复位。
 * 总览图上会按 overlays 标出 0 级 / +1 级 / -1 级的评价窗口。
 */

import { fmtNum } from './state.js';
import { paintToImageData, mmToPixel, pixelToMm, sampleAt } from './imageData.js';

const MIN_ZOOM = 0.8;
const MAX_ZOOM = 40;

let root = null;
let ui = null;
let current = null;

function build() {
  const modal = document.createElement('div');
  modal.className = 'zoom-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="zoom-backdrop" data-close="1"></div>
    <div class="zoom-card" role="dialog" aria-modal="true" aria-labelledby="zoom-title">
      <div class="zoom-head">
        <h2 id="zoom-title">查看</h2>
        <span class="zoom-legend" id="zoom-legend"></span>
        <button class="icon-btn" type="button" data-close="1" title="关闭（Esc）" aria-label="关闭">×</button>
      </div>
      <div class="zoom-stage" id="zoom-stage">
        <canvas id="zoom-canvas"></canvas>
        <div class="zoom-hint">滚轮缩放 · 拖拽平移 · 双击复位</div>
      </div>
      <div class="zoom-foot">
        <span class="zoom-readout mono" id="zoom-readout"></span>
        <div class="zoom-actions">
          <span class="zoom-pct mono" id="zoom-pct">100%</span>
          <button class="btn ghost xs" type="button" id="zoom-fit">适应窗口</button>
          <button class="btn ghost xs" type="button" id="zoom-1to1">1:1</button>
        </div>
      </div>
    </div>`;
  document.body.append(modal);

  const stage = modal.querySelector('#zoom-stage');
  const canvas = modal.querySelector('#zoom-canvas');
  ui = {
    modal,
    stage,
    canvas,
    ctx: canvas.getContext('2d'),
    title: modal.querySelector('#zoom-title'),
    legend: modal.querySelector('#zoom-legend'),
    readout: modal.querySelector('#zoom-readout'),
    pct: modal.querySelector('#zoom-pct'),
    off: document.createElement('canvas'),
    view: { zoom: 1, tx: 0, ty: 0, fit: 1 },
    drag: null,
  };

  modal.addEventListener('click', (event) => {
    if (event.target.dataset.close === '1') close();
  });
  modal.querySelector('#zoom-fit').addEventListener('click', () => resetView(true));
  modal.querySelector('#zoom-1to1').addEventListener('click', () => {
    const v = ui.view;
    v.zoom = 1 / v.fit;
    centerAt();
    render();
  });

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', () => {
    if (!current) return;
    ui.readout.textContent = '滚轮缩放 · 拖拽平移';
  });
  canvas.addEventListener('dblclick', () => resetView(true));

  const observer = new ResizeObserver(() => {
    if (!current || modal.hidden) return;
    sizeCanvas();
    render();
  });
  observer.observe(stage);

  document.addEventListener('keydown', (event) => {
    if (modal.hidden || event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  });
  return modal;
}

function sizeCanvas() {
  const rect = ui.stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  ui.canvas.width = Math.round(w * dpr);
  ui.canvas.height = Math.round(h * dpr);
  ui.canvas.style.width = `${w}px`;
  ui.canvas.style.height = `${h}px`;
  ui.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ui.cssW = w;
  ui.cssH = h;
}

function fitScale(meta) {
  const w = ui.cssW || 1;
  const h = ui.cssH || 1;
  return Math.min(w / meta.w, h / meta.h);
}

function centerAt() {
  const v = ui.view;
  const meta = current.meta;
  const scale = v.fit * v.zoom;
  v.tx = (ui.cssW - meta.w * scale) / 2;
  v.ty = (ui.cssH - meta.h * scale) / 2;
}

function resetView(animateReset) {
  if (!current) return;
  const v = ui.view;
  v.zoom = 1;
  v.fit = fitScale(current.meta);
  centerAt();
  void animateReset;
  render();
}

function onWheel(event) {
  if (!current) return;
  event.preventDefault();
  const v = ui.view;
  const rect = ui.canvas.getBoundingClientRect();
  const cx = event.clientX - rect.left;
  const cy = event.clientY - rect.top;
  const factor = Math.exp(-event.deltaY * 0.0011);
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
  if (next === v.zoom) return;
  const k = next / v.zoom;
  v.tx = cx - (cx - v.tx) * k;
  v.ty = cy - (cy - v.ty) * k;
  v.zoom = next;
  render();
}

function onDown(event) {
  if (!current) return;
  ui.canvas.setPointerCapture(event.pointerId);
  ui.drag = { x: event.clientX, y: event.clientY, tx: ui.view.tx, ty: ui.view.ty };
  ui.canvas.classList.add('dragging');
}

function onMove(event) {
  if (!current) return;
  if (ui.drag) {
    const v = ui.view;
    v.tx = ui.drag.tx + (event.clientX - ui.drag.x);
    v.ty = ui.drag.ty + (event.clientY - ui.drag.y);
    render();
    return;
  }
  const rect = ui.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const meta = current.meta;
  const scale = ui.view.fit * ui.view.zoom;
  const px = (x - ui.view.tx) / scale;
  const py = (y - ui.view.ty) / scale;
  if (px < 0 || py < 0 || px >= meta.w || py >= meta.h) {
    ui.readout.textContent = '滚轮缩放 · 拖拽平移';
    return;
  }
  const mm = pixelToMm(meta, px, py);
  const s = sampleAt(meta, px, py);
  ui.readout.textContent = meta.phase
    ? `x ${fmtNum(mm.x, 3)} mm · y ${fmtNum(mm.y, 3)} mm · 相位 ${fmtNum(s.phaseRad, 2)} rad`
    : `x ${fmtNum(mm.x, 3)} mm · y ${fmtNum(mm.y, 3)} mm · 强度 ${fmtNum(s.rel)}（Imax ${fmtNum(meta.vmax)}）`;
}

function onUp() {
  ui.drag = null;
  ui.canvas.classList.remove('dragging');
}

const BOX_STYLE = {
  plus: { stroke: '#38bdf8', label: '#e0f2fe' },
  zero: { stroke: '#fbbf24', label: '#fef3c7' },
  minus: { stroke: '#94a3b8', label: '#e2e8f0' },
};

function drawBoxes(ctx, boxes) {
  const v = ui.view;
  const meta = current.meta;
  const scale = v.fit * v.zoom;
  ctx.save();
  ctx.lineJoin = 'round';
  for (const box of boxes) {
    const a = mmToPixel(meta, box.cx - box.hx, box.cy - box.hy);
    const b = mmToPixel(meta, box.cx + box.hx, box.cy + box.hy);
    const x = v.tx + Math.min(a.px, b.px) * scale;
    const y = v.ty + Math.min(a.py, b.py) * scale;
    const w = Math.abs(b.px - a.px) * scale;
    const h = Math.abs(b.py - a.py) * scale;
    const style = BOX_STYLE[box.kind] || BOX_STYLE.zero;
    ctx.setLineDash(box.kind === 'minus' ? [5, 4] : []);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = style.stroke;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w), Math.max(1, h));

    const text = box.label;
    ctx.font = '600 12px ui-monospace, Consolas, monospace';
    const tw = ctx.measureText(text).width;
    const lx = x + 3;
    const ly = y > 18 ? y - 5 : y + h + 14;
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(9, 14, 26, 0.72)';
    ctx.fillRect(lx - 2, ly - 11, tw + 8, 15);
    ctx.fillStyle = style.label;
    ctx.fillText(text, lx + 2, ly);
  }
  ctx.restore();
}

function render() {
  if (!current) return;
  const { meta, boxes } = current;
  const ctx = ui.ctx;
  const v = ui.view;
  const scale = v.fit * v.zoom;
  ctx.save();
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, ui.cssW, ui.cssH);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(ui.off, v.tx, v.ty, meta.w * scale, meta.h * scale);
  ctx.restore();
  if (boxes && boxes.length) drawBoxes(ctx, boxes);
  const pct = Math.round((scale / ui.view.fit) * 100);
  ui.pct.textContent = `${pct}%`;
}

export function openZoom({ title, meta, display, boxes }) {
  if (!root) root = build();
  current = { meta, boxes: boxes || [] };
  ui.title.textContent = title || '查看';
  ui.legend.innerHTML = (boxes || [])
    .filter((box) => box.kind !== 'minus')
    .map((box) => `<span class="zoom-chip ${box.kind}">${box.label}</span>`)
    .join('');
  ui.off.width = meta.w;
  ui.off.height = meta.h;
  ui.off.getContext('2d').putImageData(paintToImageData(meta, display), 0, 0);
  root.hidden = false;
  document.body.classList.add('zoom-open');
  sizeCanvas();
  resetView(false);
  ui.readout.textContent = '滚轮缩放 · 拖拽平移 · 双击复位';
}

export function closeZoom() {
  if (!root) return;
  root.hidden = true;
  document.body.classList.remove('zoom-open');
  current = null;
}

function close() {
  closeZoom();
}
