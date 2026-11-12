/**
 * 全局状态、参数草稿、显示偏好、指标字典与数值格式化。
 */

export const GROUP_ORDER = ['SLM 与照明', '光路几何', '载波与级次', '编码', '评价窗口', '计算与输出', '显示与标注', '设计参数'];
export const PACK_GROUP = '设计参数';
export const PLANE_LABEL = { near: '近场', far: '远场' };

export const LS_KEY = {
  display: 'cgh.display.v1',
  pinned: 'cgh.pinnedKeys.v1',
};

/** 指标的字段字典（顺序决定下拉与表格顺序）。 */
export const FIELD_DEFS = {
  r1e2_mm: { label: '1/e² 半径', unit: 'mm' },
  r1e2_x_mm: { label: '1/e² 半径 rx', unit: 'mm' },
  r1e2_y_mm: { label: '1/e² 半径 ry', unit: 'mm' },
  d4sigma_x_mm: { label: 'D4σ x', unit: 'mm' },
  d4sigma_y_mm: { label: 'D4σ y', unit: 'mm' },
  centroid_x_mm: { label: '质心 x', unit: 'mm' },
  centroid_y_mm: { label: '质心 y', unit: 'mm' },
  offset_mm: { label: '质心偏移', unit: 'mm' },
  offset_x_mm: { label: '质心偏移 x', unit: 'mm' },
  offset_y_mm: { label: '质心偏移 y', unit: 'mm' },
  ideal_offset_x_mm: { label: '理想偏移 x', unit: 'mm' },
  ideal_offset_y_mm: { label: '理想偏移 y', unit: 'mm' },
  correlation: { label: '相关系数', unit: '' },
  normalized_rmse: { label: '归一化 RMSE', unit: '' },
  peak: { label: '峰值', unit: '' },
  zero_energy_fraction: { label: '零级能量占比', unit: '' },
  plus_energy_fraction: { label: '一级能量占比', unit: '' },
  zero_plus_peak_ratio: { label: '零/一级峰值比', unit: '' },
  roi_overlap: { label: '窗口重叠', unit: '' },
  total_power_relative_to_slm: { label: '总功率（相对 SLM）', unit: '' },
};

export const SCORE_METRICS = [
  { key: 'far.correlation', label: '远场相关系数', direction: 'max' },
  { key: 'near.correlation', label: '近场相关系数', direction: 'max' },
  { key: 'far.normalized_rmse', label: '远场归一化 RMSE', direction: 'min' },
  { key: 'far.plus_energy_fraction', label: '远场一级能量占比', direction: 'max' },
  { key: 'near.plus_energy_fraction', label: '近场一级能量占比', direction: 'max' },
  { key: 'far.zero_plus_peak_ratio', label: '远场零/一级峰值比', direction: 'min' },
  { key: 'far.r1e2_mm', label: '远场 1/e² 半径', direction: 'min' },
  { key: 'composite', label: '综合评分', direction: 'max' },
];

export const store = {
  health: null,
  data: null,
  draft: { settings: {}, packValues: {} },
  job: null,
  lastRun: null,
  sweepResult: null,
  optimizeResult: null,
  display: { cmap: 'gray', scale: 'linear', gamma: 0.7 },
  pinnedKeys: ['far.r1e2_mm', 'near.r1e2_mm'],
};

export function has(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

export function loadJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* 隐私模式/配额满：忽略 */
  }
}

export function activePack() {
  const data = store.data;
  if (!data) return null;
  const packs = Array.isArray(data.packs) ? data.packs : [];
  return packs.find((p) => p && p.id === data.activePack) || null;
}

export function schemaDefs() {
  const data = store.data;
  return data && Array.isArray(data.settingsSchema) ? data.settingsSchema : [];
}

export function packDefs() {
  const pack = activePack();
  return pack && Array.isArray(pack.params) ? pack.params : [];
}

export function allDefs() {
  return schemaDefs().concat(packDefs());
}

export function findDef(key) {
  return allDefs().find((d) => d && d.key === key) || null;
}

export function defScope(key) {
  return packDefs().some((d) => d && d.key === key) ? 'packValues' : 'settings';
}

/* ---------------- 参数草稿 ---------------- */

export function settingsValues() {
  const base = (store.data && store.data.settings) || {};
  return Object.assign({}, base, store.draft.settings);
}

export function packValues() {
  const base = (store.data && store.data.packValues) || {};
  return Object.assign({}, base, store.draft.packValues);
}

export function serverValues(scope) {
  if (scope === 'packValues') return (store.data && store.data.packValues) || {};
  return (store.data && store.data.settings) || {};
}

export function setDraftValue(scope, key, value) {
  const bucket = scope === 'packValues' ? store.draft.packValues : store.draft.settings;
  const base = serverValues(scope);
  if (has(base, key) && JSON.stringify(base[key]) === JSON.stringify(value)) {
    delete bucket[key];
  } else {
    bucket[key] = value;
  }
}

export function clearDraft() {
  store.draft.settings = {};
  store.draft.packValues = {};
}

export function dirtyCount() {
  return Object.keys(store.draft.settings).length + Object.keys(store.draft.packValues).length;
}

/** /api/run 与 /api/sweep 的增量覆盖项；无改动时返回空对象。 */
export function draftOverrides() {
  const out = {};
  if (Object.keys(store.draft.settings).length) out.settings = Object.assign({}, store.draft.settings);
  if (Object.keys(store.draft.packValues).length) out.packValues = Object.assign({}, store.draft.packValues);
  return out;
}

export function valueOf(def, scope) {
  const vals = scope === 'packValues' ? packValues() : settingsValues();
  if (has(vals, def.key)) return vals[def.key];
  if (def.value !== undefined && def.value !== null) return def.value;
  return def.default;
}

/* ---------------- 指标 ---------------- */

function boxOf(planeMetrics, field, allowArray) {
  if (!planeMetrics) return null;
  const boxes = [planeMetrics.plus, planeMetrics.combined, planeMetrics.zero];
  for (const box of boxes) {
    if (!box) continue;
    const value = box[field];
    if (typeof value === 'number' || (allowArray && Array.isArray(value))) return box;
  }
  return null;
}

export function metricValue(run, key) {
  if (!run || !run.metrics || typeof key !== 'string') return null;
  const dot = key.indexOf('.');
  if (dot < 0) return null;
  const plane = key.slice(0, dot);
  const field = key.slice(dot + 1);
  const box = boxOf(run.metrics[plane], field);
  return box ? box[field] : null;
}

/** 由一次运行结果生成可切换指标清单（仅列出后端实际返回的字段）。 */
export function metricCatalog(run) {
  const out = [];
  if (!run || !run.metrics) return out;
  for (const plane of ['near', 'far']) {
    if (!run.metrics[plane]) continue;
    for (const field of Object.keys(FIELD_DEFS)) {
      if (!boxOf(run.metrics[plane], field)) continue;
      out.push({
        key: `${plane}.${field}`,
        label: `${PLANE_LABEL[plane]} · ${FIELD_DEFS[field].label}`,
        short: FIELD_DEFS[field].label,
        unit: FIELD_DEFS[field].unit,
        plane,
        field,
      });
    }
  }
  return out;
}

/** 表格式指标行：key 取自 metrics.{plane}.{plus|combined}。 */
export const TABLE_ROWS = [
  { label: '1/e² 半径 r', field: 'r1e2_mm', unit: 'mm' },
  { label: '1/e² 半径 rx', field: 'r1e2_x_mm', unit: 'mm' },
  { label: '1/e² 半径 ry', field: 'r1e2_y_mm', unit: 'mm' },
  { label: 'D4σ x', field: 'd4sigma_x_mm', unit: 'mm' },
  { label: 'D4σ y', field: 'd4sigma_y_mm', unit: 'mm' },
  { label: '质心 x', field: 'centroid_x_mm', unit: 'mm' },
  { label: '质心 y', field: 'centroid_y_mm', unit: 'mm' },
  { label: '质心偏移', field: 'offset_mm', unit: 'mm' },
  { label: '质心偏移分量', field: 'offset_px', unit: 'px' },
  { label: '相关系数', field: 'correlation', unit: '' },
  { label: '归一化 RMSE', field: 'normalized_rmse', unit: '' },
  { label: '一级能量占比', field: 'plus_energy_fraction', unit: '' },
  { label: '零级能量占比', field: 'zero_energy_fraction', unit: '' },
  { label: '零/一级峰值比', field: 'zero_plus_peak_ratio', unit: '' },
];

export function tableValue(run, plane, field) {
  if (!run || !run.metrics) return null;
  const box = boxOf(run.metrics[plane], field, true);
  if (!box) return null;
  return box[field];
}

/* ---------------- 数值格式化 ---------------- */

function trimZeros(str) {
  if (!str || str.indexOf('.') < 0) return str;
  return str.replace(/0+$/, '').replace(/\.$/, '');
}

/** 量级自适应：>=100 一位小数；>=1 三位小数；<1 四位有效数字。 */
export function fmtNum(value, digits) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (typeof digits === 'number' && Number.isFinite(digits)) return value.toFixed(Math.max(0, Math.min(8, digits)));
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(3);
  const text = value.toPrecision(4);
  return text.indexOf('e') >= 0 ? text : trimZeros(text);
}

export function fmtPair(value, digits) {
  if (!Array.isArray(value)) return '—';
  return value.slice(0, 2).map((v) => fmtNum(v, digits)).join(' / ');
}

export function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtVector(value, digits) {
  if (!Array.isArray(value)) return '—';
  return `(${value.map((v) => fmtNum(v, digits)).join(', ')})`;
}
