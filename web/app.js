/**
 * CGH 工具箱前端入口：顶栏、Tab 切换、任务轮询、结果区与提示。
 */

import { api, pollJob } from './api.js';
import * as S from './state.js';
import { createPanel } from './panel.js';
import { createImageView } from './imageView.js';
import { createSweepView } from './sweep.js';
import { createOptimizeView } from './optimize.js';

const store = S.store;
const $ = (id) => document.getElementById(id);

const els = {
  badgePython: $('badge-python'),
  badgePacks: $('badge-packs'),
  packSelect: $('pack-select'),
  btnRescan: $('btn-rescan'),
  btnPrompt: $('btn-prompt'),
  btnRun: $('btn-run'),
  btnCancel: $('btn-cancel'),
  btnDrawer: $('btn-drawer'),
  scrim: $('scrim'),
  sideBody: $('side-body'),
  summary: $('summary'),
  jobbar: $('jobbar'),
  jobbarTitle: $('jobbar-title'),
  jobbarPct: $('jobbar-pct'),
  jobbarFill: $('jobbar-fill'),
  jobbarMsg: $('jobbar-msg'),
  simEmpty: $('sim-empty'),
  simResults: $('sim-results'),
  emptyPack: $('empty-pack'),
  bigcards: $('bigcards'),
  metricsTable: $('metrics-table'),
  btnCopyCsv: $('btn-copy-csv'),
  imageGrid: $('image-grid'),
  artifactsCard: $('artifacts-card'),
  artifactDir: $('artifact-dir'),
  artifactLinks: $('artifact-links'),
  selCmap: $('sel-cmap'),
  selScale: $('sel-scale'),
  selVmax: $('sel-vmax'),
  rngGamma: $('rng-gamma'),
  gammaVal: $('gamma-val'),
  modal: $('modal'),
  modalTitle: $('modal-title'),
  modalPath: $('modal-path'),
  modalBody: $('modal-body'),
  promptTabs: $('prompt-tabs'),
  modalNote: $('modal-note'),
  modalCopy: $('modal-copy'),
  diagSummary: $('diag-summary'),
  diagBody: $('diag-body'),
  modalClose: $('modal-close'),
  toasts: $('toasts'),
  confirm: $('confirm'),
  confirmTitle: $('confirm-title'),
  confirmMsg: $('confirm-msg'),
  confirmYes: $('confirm-yes'),
  confirmNo: $('confirm-no'),
  btnEnv: $('btn-env'),
  envModal: $('env-modal'),
  envSummary: $('env-summary'),
  envList: $('env-list'),
  envNote: $('env-note'),
  envClose: $('env-close'),
  envCloseBtn: $('env-close-btn'),
  envRecheck: $('env-recheck'),
};

let envBusy = false;

let panel = null;
let imageView = null;
let sweepView = null;
let optimizeView = null;
let currentTab = 'sim';
let displayPrefsLoaded = false;
let confirmResolve = null;

/* ---------------- 提示 ---------------- */

function toast(message, kind) {
  if (!message) return;
  const node = document.createElement('div');
  node.className = `toast ${kind || 'error'}`;
  const text = document.createElement('p');
  text.textContent = String(message);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-x';
  close.title = '关闭提示';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.addEventListener('click', () => node.remove());
  node.append(text, close);
  els.toasts.append(node);
  while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();
  window.setTimeout(() => {
    node.classList.add('out');
    window.setTimeout(() => node.remove(), 220);
  }, 3000);
}

function confirmDialog(message, title) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    els.confirmTitle.textContent = title || '确认';
    els.confirmMsg.textContent = message;
    els.confirm.hidden = false;
    window.setTimeout(() => els.confirmYes.focus(), 30);
  });
}

function closeConfirm(value) {
  els.confirm.hidden = true;
  if (confirmResolve) {
    const fn = confirmResolve;
    confirmResolve = null;
    fn(value);
  }
}

async function copyText(text, okMessage) {
  const value = String(text == null ? '' : text);
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(value);
    toast(okMessage || '已复制', 'ok');
    return;
  } catch (err) {
    /* 降级：textarea + execCommand */
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  }
  area.remove();
  if (ok) toast(okMessage || '已复制', 'ok');
  else toast('复制失败，请手动选择文本', 'warn');
}

/* ---------------- 环境自检 ---------------- */

const ENV_STATUS = {
  pass: { text: '通过', cls: 'ok' },
  warn: { text: '注意', cls: 'warn' },
  fail: { text: '失败', cls: 'bad' },
};

function envPill(text, cls) {
  const span = document.createElement('span');
  span.className = `env-pill ${cls}`;
  span.textContent = text;
  return span;
}

function envItem(item) {
  const li = document.createElement('li');
  const status = ENV_STATUS[item.status] ? item.status : 'warn';
  li.className = `env-item ${status}`;

  const head = document.createElement('div');
  head.className = 'env-item-head';
  const mark = document.createElement('span');
  mark.className = 'env-mark';
  mark.textContent = status === 'pass' ? '✓' : status === 'warn' ? '!' : '×';
  mark.setAttribute('aria-hidden', 'true');
  const label = document.createElement('strong');
  label.textContent = item.label || item.id || '检查项';
  const tag = document.createElement('span');
  tag.className = `env-tag ${status}`;
  tag.textContent = ENV_STATUS[status].text;
  head.append(mark, label, tag);
  li.append(head);

  if (item.detail) {
    const detail = document.createElement('p');
    detail.className = 'env-detail mono';
    detail.textContent = item.detail;
    li.append(detail);
  }

  const fix = item.fix;
  if (fix && status !== 'pass' && (fix.title || (fix.steps && fix.steps.length) || fix.command)) {
    const box = document.createElement('div');
    box.className = 'env-fix';
    if (fix.title) {
      const h = document.createElement('p');
      h.className = 'env-fix-title';
      h.textContent = `解决方法：${fix.title}`;
      box.append(h);
    }
    if (Array.isArray(fix.steps) && fix.steps.length) {
      const ol = document.createElement('ol');
      ol.className = 'env-steps';
      for (const step of fix.steps) {
        if (!step) continue;
        const liStep = document.createElement('li');
        liStep.textContent = step;
        ol.append(liStep);
      }
      box.append(ol);
    }
    if (fix.command) {
      const row = document.createElement('div');
      row.className = 'env-cmd';
      const code = document.createElement('code');
      code.textContent = fix.command;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn ghost xs';
      copy.textContent = '复制命令';
      copy.title = '复制这条命令到终端执行';
      copy.addEventListener('click', () => copyText(fix.command, '命令已复制'));
      row.append(code, copy);
      box.append(row);
    }
    li.append(box);
  }
  return li;
}

function renderEnv() {
  if (!els.envList) return;
  const env = store.env;
  els.envList.replaceChildren();
  if (!env) {
    els.envSummary.replaceChildren(envPill('尚未检查', 'warn'));
    return;
  }
  const s = env.summary || { pass: 0, warn: 0, fail: 0 };
  const pills = [
    envPill(`通过 ${s.pass}`, 'ok'),
    envPill(`注意 ${s.warn}`, 'warn'),
    envPill(`失败 ${s.fail}`, 'bad'),
  ];
  if (env.canRun === false) {
    pills.push(envPill('暂不能计算', 'bad'));
  } else {
    pills.push(envPill('可以计算', 'ok'));
  }
  els.envSummary.replaceChildren(...pills);
  const info = document.createElement('span');
  info.className = 'muted mono env-info';
  const pyVersion = (env.python && (env.python.version || env.python.path)) || '—';
  info.textContent = `Python ${pyVersion}${env.port ? ` · 127.0.0.1:${env.port}` : ''}`;
  els.envSummary.append(info);
  els.envNote.textContent = env.paths && env.paths.projectDir ? env.paths.projectDir : '';

  for (const item of env.checks || []) els.envList.append(envItem(item));
}

async function checkEnv(options) {
  const opts = options || {};
  if (envBusy) return store.env;
  envBusy = true;
  if (els.btnEnv) {
    els.btnEnv.disabled = true;
    els.btnEnv.textContent = '检查中…';
  }
  try {
    store.env = await api.env();
  } catch (err) {
    store.env = {
      ok: false,
      canRun: false,
      summary: { pass: 0, warn: 0, fail: 1 },
      checks: [
        {
          id: 'request',
          label: '访问 /api/env',
          status: 'fail',
          detail: err.message,
          fix: {
            title: '后端没有响应',
            steps: [
              '确认「启动后端.bat」的黑色窗口还开着，没有关闭或报错退出',
              '若窗口已关闭，重新双击「启动后端.bat」，然后刷新本页',
              '仍失败时把窗口里的报错文字发给我',
            ],
            command: null,
          },
        },
      ],
    };
  } finally {
    envBusy = false;
    if (els.btnEnv) {
      els.btnEnv.disabled = false;
      els.btnEnv.textContent = '环境自检';
    }
  }
  renderEnv();
  renderHealth();
  if (opts.open) openEnv();
  if (!opts.quiet && store.env.summary && store.env.summary.fail > 0) {
    toast(`环境自检有 ${store.env.summary.fail} 项失败，点右上角「环境自检」查看解决方法`, 'error');
  }
  return store.env;
}

function openEnv() {
  els.envModal.hidden = false;
  renderEnv();
  if (!store.env) checkEnv({ quiet: true });
}

function closeEnv() {
  els.envModal.hidden = true;
}

/** 计算前的闸门：环境有硬失败就拦住并打开自检面板。 */
async function ensureEnv() {
  const env = store.env || (await checkEnv({ quiet: true }));
  if (env && env.canRun === false) {
    openEnv();
    toast('环境自检未通过，请按提示处理后重试', 'error');
    return false;
  }
  return true;
}

/* ---------------- 渲染：顶栏 ---------------- */

function renderHealth() {
  const health = store.health;
  const py = health && health.python;
  const ready = Boolean(py && py.ready);
  const env = store.env;
  const dot = document.createElement('span');
  dot.className = 'dot';

  let text;
  let okClass;
  let badClass;
  if (env) {
    const s = env.summary || { pass: 0, warn: 0, fail: 0 };
    text = s.fail > 0 ? `环境 ${s.fail} 项失败` : (s.warn > 0 ? `环境正常（${s.warn} 项注意）` : '环境正常');
    okClass = s.fail === 0;
    badClass = s.fail > 0;
  } else {
    text = health ? (ready ? 'Python 就绪' : 'Python 未就绪') : 'Python 状态未知';
    okClass = ready;
    badClass = Boolean(health) && !ready;
  }
  els.badgePython.replaceChildren(dot, document.createTextNode(text));
  els.badgePython.classList.toggle('ok', okClass);
  els.badgePython.classList.toggle('bad', badClass);
  const envLines = env && Array.isArray(env.checks)
    ? env.checks.map((c) => `${c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '×'} ${c.label}`).join('\n')
    : '';
  els.badgePython.title = env
    ? `点击查看环境自检详情\n${envLines}`
    : health
      ? `版本 ${py && py.version ? py.version : '—'}\n路径 ${py && py.path ? py.path : '—'}${py && py.note ? `\n${py.note}` : ''}\n并发 ${health.engine && health.engine.workers ? health.engine.workers : '—'}`
      : 'GET /api/health 无响应';
  els.badgePython.style.cursor = 'pointer';

  const packs = (store.data && Array.isArray(store.data.packs) && store.data.packs.length) || 0;
  els.badgePacks.textContent = `设计包 ${packs} 个`;
  const dir = health && health.packsDir ? health.packsDir : '';
  els.badgePacks.title = dir ? `扫描目录：${dir}` : '已扫描到的设计包数量';
  els.badgePacks.classList.toggle('ok', packs > 0);
}

function renderPackSelect() {
  const packs = (store.data && Array.isArray(store.data.packs) && store.data.packs) || [];
  els.packSelect.replaceChildren();
  if (!packs.length) {
    els.packSelect.append(new Option('（无设计包）', ''));
    els.packSelect.disabled = true;
    return;
  }
  els.packSelect.disabled = false;
  for (const pack of packs) {
    const ok = pack.ok !== false;
    els.packSelect.append(new Option(`${pack.name || pack.id}${ok ? '' : '（不可用）'}`, pack.id));
  }
  els.packSelect.value = store.data.activePack || packs[0].id;
  const current = packs.find((p) => p.id === els.packSelect.value);
  els.packSelect.title = current ? current.description || current.dir || '' : '';
}

/* ---------------- 渲染：摘要 ---------------- */

function encodingLabel() {
  const def = S.findDef('encoding_method');
  const values = S.settingsValues();
  const value = values.encoding_method;
  if (value === undefined || value === null) return '—';
  const option = def && Array.isArray(def.options) ? def.options.find((o) => String(o.value) === String(value)) : null;
  return option ? option.label || String(value) : String(value);
}

function summaryChips() {
  const derived = (store.data && store.data.derived) || {};
  const run = store.lastRun;
  const geo = run && run.geometry ? run.geometry : null;
  const combined = (plane) => (run && run.metrics && run.metrics[plane] && run.metrics[plane].combined) || null;

  const zeroNear = geo && Array.isArray(geo.near_center_mm) ? S.fmtVector(geo.near_center_mm, 3) : '0.000, 0.000';
  const zeroFar = geo && Array.isArray(geo.far_center_mm) ? S.fmtVector(geo.far_center_mm, 3) : '0.000, 0.000';
  const plusNear = (combined('near') && combined('near').plus_center_mm) || derived.near_plus_center_mm;
  const plusFar = (combined('far') && combined('far').plus_center_mm) || derived.far_plus_center_mm;

  const dx = typeof derived.dx_um === 'number' ? S.fmtNum(derived.dx_um) : '—';
  const dy = typeof derived.dy_um === 'number' ? S.fmtNum(derived.dy_um) : '—';

  return [
    { label: 'dx / dy', value: `${dx} / ${dy}`, unit: 'µm' },
    { label: '零级中心 · 近场', value: zeroNear, unit: 'mm' },
    { label: '+1 中心 · 近场', value: S.fmtVector(plusNear, 3), unit: 'mm' },
    { label: '零级中心 · 远场', value: zeroFar, unit: 'mm' },
    { label: '+1 中心 · 远场', value: S.fmtVector(plusFar, 3), unit: 'mm' },
    { label: '载波空间频率', value: S.fmtVector(derived.carrier_freq_per_mm, 3), unit: 'mm⁻¹' },
    { label: '近场视场', value: S.fmtPair(derived.near_span_mm, 1), unit: 'mm' },
    { label: '编码方式', value: encodingLabel(), unit: '' },
    { label: '上次耗时', value: run ? S.fmtDuration(run.elapsedMs) : '—', unit: '' },
  ];
}

function renderSummary() {
  els.summary.replaceChildren();
  for (const chip of summaryChips()) {
    const box = document.createElement('div');
    box.className = 'chip';
    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = chip.label;
    const value = document.createElement('span');
    value.className = 'chip-value mono';
    value.textContent = chip.value;
    value.title = `${chip.label} = ${chip.value}${chip.unit ? ' ' + chip.unit : ''}`;
    box.append(label, value);
    if (chip.unit && chip.value !== '—') {
      const unit = document.createElement('span');
      unit.className = 'chip-unit';
      unit.textContent = chip.unit;
      box.append(unit);
    }
    els.summary.append(box);
  }
}

/* ---------------- 渲染：结果 ---------------- */

function resolvePinned(catalog) {
  const exists = (key) => catalog.some((c) => c.key === key);
  const wanted = Array.isArray(store.pinnedKeys) ? store.pinnedKeys.slice(0, 2) : [];
  const fallback = ['far.r1e2_mm', 'near.r1e2_mm'].filter(exists);
  const keys = [];
  for (let i = 0; i < 2; i += 1) {
    if (wanted[i] && exists(wanted[i]) && keys.indexOf(wanted[i]) < 0) {
      keys[i] = wanted[i];
      continue;
    }
    if (fallback[i] && keys.indexOf(fallback[i]) < 0) {
      keys[i] = fallback[i];
      continue;
    }
    const next = catalog.find((c) => keys.indexOf(c.key) < 0) || catalog[0];
    keys[i] = next ? next.key : '';
  }
  return keys;
}

function renderBigCards() {
  const run = store.lastRun;
  const catalog = S.metricCatalog(run);
  els.bigcards.replaceChildren();
  if (!catalog.length) {
    els.bigcards.append(Object.assign(document.createElement('p'), { className: 'empty-line', textContent: '本次结果没有可展示的指标。' }));
    return;
  }
  const keys = resolvePinned(catalog);
  store.pinnedKeys = keys;
  S.saveJSON(S.LS_KEY.pinned, keys);

  const groups = { near: [], far: [] };
  for (const item of catalog) {
    (groups[item.plane] || (groups[item.plane] = [])).push(item);
  }

  keys.forEach((key, index) => {
    const item = catalog.find((c) => c.key === key) || catalog[0];
    const pin = Array.isArray(run.pinned) ? run.pinned.find((p) => p.key === item.key) : null;
    const digits = pin && typeof pin.digits === 'number' ? pin.digits : null;
    const value = S.metricValue(run, item.key);

    const card = document.createElement('article');
    card.className = 'bigcard';
    const top = document.createElement('div');
    top.className = 'bigcard-top';
    const kicker = document.createElement('span');
    kicker.className = 'bigcard-kicker';
    kicker.textContent = index === 0 ? '其一' : '其二';
    const select = document.createElement('select');
    select.className = 'bigcard-select';
    select.title = '切换该卡片显示的指标';
    select.setAttribute('aria-label', `第 ${index + 1} 张大数值卡的指标`);
    for (const plane of ['near', 'far']) {
      if (!groups[plane] || !groups[plane].length) continue;
      const group = document.createElement('optgroup');
      group.label = S.PLANE_LABEL[plane];
      for (const opt of groups[plane]) {
        group.append(new Option(opt.label, opt.key));
      }
      select.append(group);
    }
    select.value = item.key;
    select.addEventListener('change', () => {
      store.pinnedKeys[index] = select.value;
      S.saveJSON(S.LS_KEY.pinned, store.pinnedKeys);
      renderBigCards();
    });
    top.append(kicker, select);

    const valueRow = document.createElement('div');
    valueRow.className = 'bigcard-value';
    const num = document.createElement('strong');
    num.className = 'mono';
    num.textContent = S.fmtNum(value, digits);
    valueRow.append(num);
    if (item.unit) {
      const unit = document.createElement('span');
      unit.className = 'bigcard-unit';
      unit.textContent = item.unit;
      valueRow.append(unit);
    }

    const label = document.createElement('p');
    label.className = 'bigcard-label';
    label.textContent = item.label;

    card.append(top, valueRow, label);
    els.bigcards.append(card);
  });
}

function cellText(run, plane, row) {
  const value = S.tableValue(run, plane, row.field);
  if (Array.isArray(value)) return value.map((v) => S.fmtNum(v)).join(' / ');
  return S.fmtNum(value);
}

function renderMetricsTable() {
  const run = store.lastRun;
  const table = els.metricsTable;
  table.replaceChildren();

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.append(
    Object.assign(document.createElement('th'), { scope: 'col', textContent: '指标' }),
    Object.assign(document.createElement('th'), { scope: 'col', textContent: '近场' }),
    Object.assign(document.createElement('th'), { scope: 'col', textContent: '远场' }),
  );
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const row of S.TABLE_ROWS) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.className = 'metric-name';
    th.textContent = row.label;
    if (row.unit) {
      const unit = document.createElement('span');
      unit.className = 'metric-unit';
      unit.textContent = row.unit;
      th.append(unit);
    }
    tr.append(th);
    for (const plane of ['near', 'far']) {
      const td = document.createElement('td');
      td.className = 'mono num';
      td.textContent = cellText(run, plane, row);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
}

function metricsCsv() {
  const run = store.lastRun;
  if (!run) return '';
  const esc = (text) => {
    const value = String(text == null ? '' : text);
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  const lines = ['指标,近场,远场'];
  for (const row of S.TABLE_ROWS) {
    lines.push([esc(`${row.label}${row.unit ? ` (${row.unit})` : ''}`), esc(cellText(run, 'near', row)), esc(cellText(run, 'far', row))].join(','));
  }
  return lines.join('\n');
}

function renderArtifacts() {
  const run = store.lastRun;
  const art = run && run.artifacts ? run.artifacts : null;
  if (!art) {
    els.artifactsCard.hidden = true;
    return;
  }
  els.artifactsCard.hidden = false;
  els.artifactDir.textContent = art.dir || '—';
  els.artifactDir.title = art.dir || '';
  els.artifactLinks.replaceChildren();
  const items = [
    ['BMP', art.bmp],
    ['CSV', art.csv],
    ['JSON', art.json],
  ];
  for (const [label, href] of items) {
    if (!href) continue;
    const link = document.createElement('a');
    link.className = 'btn ghost sm';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = `下载 ${label}`;
    link.title = `打开 ${href}`;
    els.artifactLinks.append(link);
  }
  if (!els.artifactLinks.children.length) {
    els.artifactLinks.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: '本次运行未生成文件。' }));
  }
}

function renderResults() {
  const run = store.lastRun;
  if (!run) {
    els.simEmpty.hidden = false;
    els.simResults.hidden = true;
    const pack = S.activePack();
    els.emptyPack.textContent = pack ? `${pack.name || pack.id}` : '—';
    return;
  }
  els.simEmpty.hidden = true;
  els.simResults.hidden = false;
  renderBigCards();
  renderDiagnosis();
  renderMetricsTable();
  renderArtifacts();
  imageView.setDisplay(store.display);
  imageView.setData(run.images || null, run.overlays || null);
  if (!run.images) {
    els.imageGrid.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-line', textContent: '本次运行未返回图像（withImages=false）。' }));
  }
}

/* ---------------- 诊断：一级 vs 理想一级 ---------------- */

function diagStat(label, value, hint) {
  const box = document.createElement('div');
  box.className = 'diag-stat';
  const v = document.createElement('span');
  v.className = 'diag-stat-value mono';
  v.textContent = value;
  const l = document.createElement('span');
  l.className = 'diag-stat-label';
  l.textContent = label;
  box.append(v, l);
  if (hint) box.title = hint;
  return box;
}

function renderDiagnosis() {
  const run = store.lastRun;
  const diag = run && run.diagnosis;
  const body = els.diagBody;
  if (!diag) {
    els.diagSummary.textContent = '';
    body.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'muted',
      textContent: '本次结果没有诊断信息（后端为旧版本）。重新计算一次即可。',
    }));
    return;
  }
  els.diagSummary.textContent = diag.summary || '';

  const stats = document.createElement('div');
  stats.className = 'diag-stats';
  const corrNear = typeof diag.near_correlation === 'number' ? diag.near_correlation : null;
  const corrFar = typeof diag.far_correlation === 'number' ? diag.far_correlation : null;
  stats.append(
    diagStat('近场 一级/理想 相关', S.fmtNum(corrNear, 3), '近场一级与理想一级的强度相关系数，1 为完全一致'),
    diagStat('远场 一级/理想 相关', S.fmtNum(corrFar, 3), '远场一级与理想一级的强度相关系数'),
    diagStat('可分辨尺度', `${S.fmtNum(diag.diffraction_limit_mm, 2)} mm`, 'λz/w：照明孔径 2w 在相机面能分辨的最小尺度'),
    diagStat('目标最小结构', diag.target_feature_mm ? `${S.fmtNum(diag.target_feature_mm, 2)} mm` : '—', '理想一级频谱 90% 能量对应的半周期'),
    diagStat('弱照明能量', `${S.fmtNum((diag.weak_illumination_fraction || 0) * 100, 0)}%`, '所需 SLM 复场中落在照明区之外、送不出去的能量占比'),
  );

  const list = document.createElement('ul');
  list.className = 'diag-list';
  for (const item of diag.items || []) {
    const li = document.createElement('li');
    li.className = `diag-item ${item.level || 'info'}`;
    const head = document.createElement('div');
    head.className = 'diag-item-head';
    const dot = document.createElement('span');
    dot.className = 'diag-dot';
    const title = document.createElement('strong');
    title.textContent = item.title || '';
    head.append(dot, title);
    const detail = document.createElement('p');
    detail.className = 'diag-detail';
    detail.textContent = item.detail || '';
    li.append(head, detail);
    if (item.action && item.action.kind === 'set') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost xs diag-action';
      btn.textContent = item.action.label || '应用建议值';
      btn.title = `把 ${item.action.key} 改为 ${item.action.value}（只改草稿，需点保存或直接计算）`;
      btn.addEventListener('click', () => applyParams({ [item.action.key]: item.action.value }));
      li.append(btn);
    }
    list.append(li);
  }

  body.replaceChildren(stats, list);
}

/* ---------------- 参数面板 ---------------- */

function renderPanel() {
  panel.render({
    pack: S.activePack(),
    schema: S.schemaDefs(),
    packParams: S.packDefs(),
    settings: S.settingsValues(),
    packValues: S.packValues(),
  });
}

function dirtyKeys() {
  const set = new Set();
  Object.keys(store.draft.settings).forEach((key) => set.add(`settings:${key}`));
  Object.keys(store.draft.packValues).forEach((key) => set.add(`packValues:${key}`));
  return set;
}

async function saveSettings() {
  const payload = S.draftOverrides();
  if (!payload.settings && !payload.packValues) {
    toast('没有需要保存的改动', 'warn');
    return;
  }
  try {
    const res = await api.saveSettings(payload);
    if (res.settings) store.data.settings = res.settings;
    if (res.packValues) store.data.packValues = res.packValues;
    S.clearDraft();
    renderPanel();
    renderSummary();
    refreshDerived();
    if (Array.isArray(res.warnings)) {
      res.warnings.slice(0, 3).forEach((w) => toast(w, 'warn'));
    }
    const clamped = Array.isArray(res.clamped) ? res.clamped : [];
    if (clamped.length) {
      const plain = (v) => (typeof v === 'number' && Number.isInteger(v) ? String(v) : S.fmtNum(v));
      clamped.slice(0, 3).forEach((item) => {
        const def = S.findDef(item.key);
        const label = def ? def.label || item.key : item.key;
        toast(`${label} 被修正：${plain(item.from)} → ${plain(item.to)}${item.reason ? `（${item.reason}）` : ''}`, 'warn');
      });
      if (clamped.length > 3) toast(`另有 ${clamped.length - 3} 项参数被后端修正`, 'warn');
    } else {
      toast('参数已保存', 'ok');
    }
  } catch (err) {
    toast(err.message);
  }
}

function resetDraft() {
  S.clearDraft();
  renderPanel();
  renderSummary();
  toast('已还原未保存改动', 'ok');
}

function applyParams(params) {
  const entries = Object.entries(params || {});
  for (const [key, value] of entries) {
    S.setDraftValue(S.defScope(key), key, value);
  }
  renderPanel();
  if (entries.length) panel.highlight(entries[0][0]);
  toast(`已回填 ${entries.length} 项参数，保存后生效`, 'ok');
}

/** 预设构型：把一组已知自洽的值写进草稿（仍然要手动保存）。 */
function applyPreset(id) {
  const presets = (store.data && store.data.presets) || [];
  const preset = presets.find((item) => item.id === id);
  if (!preset) {
    toast(`找不到预设 ${id}`, 'warn');
    return;
  }
  const entries = Object.entries(preset.values || {});
  for (const [key, value] of entries) {
    S.setDraftValue(S.defScope(key), key, value);
  }
  renderPanel();
  renderSummary();
  if (entries.length) panel.highlight(entries[0][0]);
  scheduleHealth();
  toast(`已套用预设「${preset.label}」：${entries.length} 项改动，保存后生效`, 'ok');
}

/** 单项修改（体检/建议按钮用）。 */
function setParam(key, value) {
  S.setDraftValue(S.defScope(key), key, value);
  renderPanel();
  renderSummary();
  panel.highlight(key);
  scheduleHealth();
  toast(`已把「${key}」改为 ${value}，保存后生效`, 'ok');
}

/** 草稿改动后即时重算体检（防抖 250ms）：不等保存，也不用重跑仿真。 */
let healthTimer = 0;
function scheduleHealth() {
  if (healthTimer) clearTimeout(healthTimer);
  healthTimer = window.setTimeout(async () => {
    healthTimer = 0;
    const overrides = S.draftOverrides();
    try {
      const res = await api.healthcheck({ settings: overrides.settings || {} });
      if (!res || !Array.isArray(res.health) || !store.data) return;
      store.data.health = res.health;
      if (panel && panel.refreshHealth) panel.refreshHealth(res.health);
      if (optimizeView && optimizeView.refreshStart) optimizeView.refreshStart();
    } catch (err) {
      /* 体检是辅助信息，失败不打断编辑 */
    }
  }, 250);
}

/** 参数改动后刷新后端的体检结论（不等下一次计算）。 */
async function refreshDerived() {
  try {
    const data = await api.state();
    if (!data || !store.data) return;
    store.data.health = data.health;
    store.data.presets = data.presets;
    store.data.roles = data.roles;
    store.data.roleOrder = data.roleOrder;
    store.data.derived = data.derived;
    renderPanel();
    renderSummary();
    if (optimizeView) optimizeView.render();
  } catch (err) {
    /* 体检刷新失败不影响主流程 */
  }
}

/* ---------------- 任务 ---------------- */

function jobBusy() {
  return Boolean(store.job);
}

function syncJobUI() {
  const job = store.job;
  const busy = Boolean(job);
  els.btnRun.disabled = busy;
  els.btnRun.textContent = busy ? '计算中…' : '开始计算';
  els.btnCancel.hidden = !busy;
  els.jobbar.hidden = !busy;
  if (job) {
    els.jobbarTitle.textContent =
      job.kind === 'sweep' ? '参数扫描中' : job.kind === 'optimize' ? '自动优化中' : '仿真计算中';
    const pct = typeof job.progress === 'number' ? Math.round(job.progress * 100) : 0;
    els.jobbarPct.textContent = `${Math.max(0, Math.min(100, pct))}%`;
    els.jobbarFill.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    els.jobbarMsg.textContent = job.message || '已提交，等待后端…';
  } else {
    els.jobbarFill.style.width = '0%';
  }
  if (sweepView) {
    sweepView.setBusy(busy);
    sweepView.setJob(job);
  }
  if (optimizeView) {
    optimizeView.setBusy(busy);
    optimizeView.setJob(job);
  }
}

async function startJob(kind, payload) {
  if (store.job) {
    toast('已有任务在运行，请等待或取消', 'warn');
    return;
  }
  if (!(await ensureEnv())) return;
  const expected = kind === 'sweep' && Array.isArray(payload.axes)
    ? payload.axes.reduce((acc, axis) => acc * (Array.isArray(axis.values) ? axis.values.length : 1), 1)
    : kind === 'optimize' ? Number(payload.maxEvals) || 0
      : 0;
  try {
    const res = kind === 'run'
      ? await api.run(payload)
      : kind === 'sweep'
        ? await api.sweep(payload)
        : await api.optimize(payload);
    store.job = { id: res.jobId, kind, status: 'queued', progress: 0, message: '已排队', total: expected };
    syncJobUI();
    pollJob(res.jobId, {
      onUpdate(job) {
        store.job = {
          id: res.jobId,
          kind,
          status: job.status,
          progress: typeof job.progress === 'number' ? job.progress : 0,
          message: job.message || '',
          sweep: job.sweep || null,
          optimize: job.optimize || null,
          total: typeof job.total === 'number' ? job.total : expected,
        };
        syncJobUI();
      },
      onDone(job) {
        store.job = null;
        syncJobUI();
        if (kind === 'run') {
          store.lastRun = job.result || null;
          renderSummary();
          renderResults();
          toast(`计算完成，用时 ${S.fmtDuration(store.lastRun && store.lastRun.elapsedMs)}`, 'ok');
          const warnings = store.lastRun && Array.isArray(store.lastRun.warnings) ? store.lastRun.warnings : [];
          warnings.slice(0, 2).forEach((w) => toast(w, 'warn'));
        } else if (kind === 'sweep') {
          store.sweepResult = job.sweep || null;
          sweepView.setResult(store.sweepResult);
          const best = store.sweepResult && store.sweepResult.best;
          toast(best && typeof best.score === 'number' ? `扫描完成，最优评分 ${S.fmtNum(best.score)}` : '扫描完成', 'ok');
        } else {
          store.optimizeResult = job.optimize || null;
          optimizeView.setResult(store.optimizeResult);
          const best = store.optimizeResult && store.optimizeResult.best;
          const delta = store.optimizeResult && store.optimizeResult.delta;
          toast(
            best && typeof best.score === 'number'
              ? `优化完成：相似系数 ${S.fmtNum(best.score, 4)}${typeof delta === 'number' && delta ? `（${delta > 0 ? '+' : ''}${delta.toFixed(4)}）` : ''}`
              : '优化完成',
            'ok',
          );
        }
      },
      onError(job) {
        store.job = null;
        syncJobUI();
        toast((job && job.error && job.error.message) || '任务失败', 'error');
      },
      onCancelled() {
        store.job = null;
        syncJobUI();
        toast('任务已取消', 'warn');
      },
    });
  } catch (err) {
    toast(err.message);
  }
}

async function startRun() {
  const pack = S.activePack();
  if (!pack) {
    toast('没有可用设计包，请先检查 designs 目录', 'warn');
    return;
  }
  if (pack.ok === false) {
    toast(`设计包不可用：${pack.error || '检查未通过'}`, 'warn');
    return;
  }
  const payload = Object.assign({ packId: pack.id, quality: 'full', saveBmp: true, withImages: true }, S.draftOverrides());
  await startJob('run', payload);
}

async function cancelJob() {
  if (!store.job) return;
  const id = store.job.id;
  try {
    await api.cancel(id);
    toast('已请求取消（后端在下一个检查点退出）', 'warn');
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- 设计包 ---------------- */

async function refreshState() {
  store.data = await api.state();
}

async function switchPack(id) {
  if (!store.data || !id || id === store.data.activePack) return;
  if (S.dirtyCount() > 0) {
    const ok = await confirmDialog('当前参数有未保存改动，切换设计包会丢弃这些改动。继续切换？', '切换设计包');
    if (!ok) {
      els.packSelect.value = store.data.activePack || '';
      return;
    }
  }
  els.packSelect.disabled = true;
  try {
    await api.saveSettings({ activePack: id });
    S.clearDraft();
    await refreshState();
    store.lastRun = null;
    store.sweepResult = null;
    renderAll();
    toast(`已切换到 ${S.activePack() ? S.activePack().name : id}`, 'ok');
  } catch (err) {
    toast(err.message);
    els.packSelect.value = store.data.activePack || '';
  } finally {
    els.packSelect.disabled = false;
  }
}

async function rescanPacks() {
  els.btnRescan.disabled = true;
  try {
    const res = await api.reloadPacks();
    const count = Array.isArray(res.packs) ? res.packs.length : 0;
    await refreshState();
    renderAll();
    toast(`重新扫描完成，发现 ${count} 个设计包`, 'ok');
  } catch (err) {
    toast(err.message);
  } finally {
    els.btnRescan.disabled = false;
  }
}

/* ---------------- 显示控件 ---------------- */

function syncDisplayControls() {
  els.selCmap.value = store.display.cmap;
  els.selScale.value = store.display.scale;
  els.selVmax.value = store.display.vmaxMode || 'window';
  els.rngGamma.value = String(store.display.gamma);
  els.gammaVal.textContent = Number(store.display.gamma).toFixed(2);
}

function initDisplayControls() {
  const saved = S.loadJSON(S.LS_KEY.display, null);
  displayPrefsLoaded = Boolean(saved);
  store.display = {
    cmap: saved && saved.cmap === 'jet' ? 'jet' : 'gray',
    scale: saved && saved.scale === 'log' ? 'log' : 'linear',
    gamma: saved && typeof saved.gamma === 'number' ? saved.gamma : 0.7,
    // 总览图上零级常比一级亮几十倍，默认按评价窗口归一化，一级才看得清
    vmaxMode: saved && saved.vmaxMode === 'full' ? 'full' : 'window',
  };
  syncDisplayControls();

  const persist = () => S.saveJSON(S.LS_KEY.display, store.display);
  els.selCmap.addEventListener('change', () => {
    store.display.cmap = els.selCmap.value;
    persist();
    imageView.setDisplay(store.display);
  });
  els.selScale.addEventListener('change', () => {
    store.display.scale = els.selScale.value;
    persist();
    imageView.setDisplay(store.display);
  });
  els.selVmax.addEventListener('change', () => {
    store.display.vmaxMode = els.selVmax.value;
    persist();
    imageView.setDisplay(store.display);
  });

  let raf = 0;
  els.rngGamma.addEventListener('input', () => {
    store.display.gamma = Number(els.rngGamma.value);
    els.gammaVal.textContent = store.display.gamma.toFixed(2);
    persist();
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      imageView.setDisplay(store.display);
    });
  });
}

/* ---------------- Tab / 抽屉 / 弹窗 ---------------- */

function switchTab(name) {
  currentTab = name;
  for (const btn of document.querySelectorAll('.tab')) {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  $('pane-sim').hidden = name !== 'sim';
  $('pane-sweep').hidden = name !== 'sweep';
  $('pane-optimize').hidden = name !== 'optimize';
  if (name === 'sweep') sweepView.setJob(store.job);
  if (name === 'optimize') optimizeView.setJob(store.job);
}

function initTabs() {
  for (const btn of document.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }
  document.querySelector('.tabs').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const order = ['sim', 'sweep', 'optimize'];
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const idx = order.indexOf(currentTab);
    switchTab(order[(idx + step + order.length) % order.length]);
    const target = document.querySelector(`.tab[data-tab="${currentTab}"]`);
    if (target) target.focus();
  });
}

function setDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  els.btnDrawer.setAttribute('aria-expanded', String(open));
}

function initDrawer() {
  els.btnDrawer.addEventListener('click', () => setDrawer(!document.body.classList.contains('drawer-open')));
  $('btn-drawer-close').addEventListener('click', () => setDrawer(false));
  els.scrim.addEventListener('click', () => setDrawer(false));
}

let promptRaw = '';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** 极简 markdown 渲染：标题、列表、表格、代码块、粗体、行内代码；其余按段落。 */
function renderPromptMarkdown(markdown) {
  const frag = document.createDocumentFragment();
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  let list = null;
  let listTag = '';
  let code = null;
  const flushList = () => {
    if (list) {
      frag.append(list);
      list = null;
      listTag = '';
    }
  };
  const splitRow = (line) => {
    const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = [];
    let cur = '';
    let inCode = false;
    for (let k = 0; k < body.length; k += 1) {
      const ch = body[k];
      if (ch === '\\' && body[k + 1] === '|') {
        cur += '|';
        k += 1;
        continue;
      }
      if (ch === '`') inCode = !inCode;
      if (ch === '|' && !inCode) {
        cells.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };
  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isTableSeparator = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && /-/.test(line);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line)) {
      if (code) {
        frag.append(code);
        code = null;
      } else {
        flushList();
        code = document.createElement('pre');
        code.className = 'prompt-code mono';
      }
      continue;
    }
    if (code) {
      code.textContent += `${line}\n`;
      continue;
    }
    // markdown 表格：| a | b |  +  |---|---|
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushList();
      const table = document.createElement('table');
      table.className = 'prompt-table';
      const thead = document.createElement('thead');
      const hrow = document.createElement('tr');
      for (const cell of splitRow(line)) {
        const th = document.createElement('th');
        th.innerHTML = inlineMarkdown(cell);
        hrow.append(th);
      }
      thead.append(hrow);
      table.append(thead);
      const tbody = document.createElement('tbody');
      let j = i + 2;
      for (; j < lines.length && isTableRow(lines[j]); j++) {
        const tr = document.createElement('tr');
        for (const cell of splitRow(lines[j])) {
          const td = document.createElement('td');
          td.innerHTML = inlineMarkdown(cell);
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      frag.append(table);
      i = j - 1;
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = Math.min(4, heading[1].length + 1);
      const node = document.createElement(`h${level}`);
      node.className = 'prompt-h';
      node.innerHTML = inlineMarkdown(heading[2]);
      frag.append(node);
      continue;
    }
    if (/^(---+|\*\*\*+|___+)$/.test(line.trim())) {
      flushList();
      const hr = document.createElement('hr');
      hr.className = 'prompt-hr';
      frag.append(hr);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushList();
      const p = document.createElement('p');
      p.className = 'prompt-quote';
      p.innerHTML = inlineMarkdown(quote[1]);
      frag.append(p);
      continue;
    }
    const bullet = line.match(/^([-*]|\d+\.)\s+(.*)$/);
    if (bullet) {
      const tag = /\d/.test(bullet[1]) ? 'ol' : 'ul';
      if (!list || listTag !== tag) {
        flushList();
        list = document.createElement(tag);
        list.className = 'prompt-list';
        listTag = tag;
      }
      const li = document.createElement('li');
      if (tag === 'ol') {
        const n = parseInt(bullet[1], 10);
        if (n > 0) li.value = n;
      }
      li.innerHTML = inlineMarkdown(bullet[2]);
      list.append(li);
      continue;
    }
    // 列表项的续行（源文件里为了换行缩进 2 个以上空格）
    if (list && /^\s{2,}\S/.test(raw)) {
      const last = list.lastElementChild;
      if (last) {
        last.innerHTML += ' ' + inlineMarkdown(line.trim());
        continue;
      }
    }
    if (!line.trim()) {
      flushList();
      continue;
    }
    flushList();
    const p = document.createElement('p');
    p.className = 'prompt-p';
    p.innerHTML = inlineMarkdown(line);
    frag.append(p);
  }
  flushList();
  if (code) frag.append(code);
  return frag;
}

/* ---------------- 提示词弹窗（MATLAB / 通用 两套模板） ---------------- */

const promptCache = new Map();
let promptTemplates = null;
let promptKind = 'matlab';

function promptPlaceholder(text) {
  return Object.assign(document.createElement('p'), { className: 'muted', textContent: text });
}

function renderPromptTabs() {
  const templates = Array.isArray(promptTemplates) ? promptTemplates : [];
  if (templates.length < 2) {
    els.promptTabs.replaceChildren();
    els.promptTabs.hidden = true;
    return;
  }
  els.promptTabs.hidden = false;
  const frag = document.createDocumentFragment();
  for (const item of templates) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'prompt-tab';
    btn.dataset.kind = item.id;
    btn.textContent = item.label;
    btn.title = item.hint || item.label;
    btn.classList.toggle('active', item.id === promptKind);
    btn.disabled = item.available === false;
    btn.addEventListener('click', () => loadPrompt(item.id));
    frag.append(btn);
  }
  els.promptTabs.replaceChildren(frag);
}

function applyPrompt(data, kind) {
  promptRaw = data.markdown || '';
  els.modalBody.className = 'prompt-doc';
  els.modalBody.replaceChildren(
    promptRaw ? renderPromptMarkdown(promptRaw) : promptPlaceholder('（模板文件为空，检查 prompts/ 目录）'),
  );
  els.modalPath.textContent = data.path || '';
  els.modalNote.textContent = promptRaw
    ? `${kind || promptKind} · 已复制可用`
    : '文件缺失或为空';
  els.modalCopy.disabled = !promptRaw;
}

function loadPrompt(kind) {
  const next = kind || promptKind;
  promptKind = next;
  renderPromptTabs();
  const cached = promptCache.get(next);
  if (cached) {
    applyPrompt(cached, next);
    return Promise.resolve(cached);
  }
  els.modalBody.className = 'prompt-doc';
  els.modalBody.replaceChildren(promptPlaceholder('正在加载提示词…'));
  els.modalCopy.disabled = true;
  return api
    .prompt(next)
    .then((res) => {
      if (Array.isArray(res.templates) && res.templates.length) promptTemplates = res.templates;
      const data = { markdown: res.markdown || '', path: res.path || '' };
      promptCache.set(res.kind || next, data);
      if (promptKind === (res.kind || next)) applyPrompt(data, res.kind || next);
      renderPromptTabs();
      return data;
    })
    .catch((err) => {
      els.modalBody.replaceChildren(promptPlaceholder(err.message));
      els.modalNote.textContent = '加载失败';
      toast(err.message);
      return null;
    });
}

function openPrompt() {
  els.modal.hidden = false;
  els.modalTitle.textContent = '整理脚本提示词';
  els.modalPath.textContent = '';
  els.modalNote.textContent = '选择脚本类型后整段复制给 AI';
  els.promptTabs.hidden = false;
  renderPromptTabs();
  loadPrompt(promptKind);
}

function closeModal() {
  els.modal.hidden = true;
}

function initModal() {
  els.btnPrompt.addEventListener('click', openPrompt);
  els.modalClose.addEventListener('click', closeModal);
  els.modal.addEventListener('click', (event) => {
    if (event.target.dataset.close === '1') closeModal();
  });
  els.modalCopy.addEventListener('click', () => copyText(promptRaw || els.modalBody.textContent, '提示词已复制'));

  els.confirmYes.addEventListener('click', () => closeConfirm(true));
  els.confirmNo.addEventListener('click', () => closeConfirm(false));
  els.confirm.addEventListener('click', (event) => {
    if (event.target.dataset.close === '1') closeConfirm(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.confirm.hidden) closeConfirm(false);
    else if (!els.envModal.hidden) closeEnv();
    else if (!els.modal.hidden) closeModal();
  });
}

/* ---------------- 初始化 ---------------- */

function initTopbar() {
  els.btnRun.addEventListener('click', startRun);
  els.btnCancel.addEventListener('click', cancelJob);
  els.btnRescan.addEventListener('click', rescanPacks);
  els.packSelect.addEventListener('change', () => switchPack(els.packSelect.value));
  els.badgePython.addEventListener('click', () => openEnv());
  if (els.btnEnv) els.btnEnv.addEventListener('click', () => checkEnv({ open: true }));
  if (els.envClose) els.envClose.addEventListener('click', closeEnv);
  if (els.envCloseBtn) els.envCloseBtn.addEventListener('click', closeEnv);
  if (els.envRecheck) els.envRecheck.addEventListener('click', () => checkEnv({ open: true, quiet: true }));
  if (els.envModal) {
    els.envModal.addEventListener('click', (event) => {
      if (event.target.dataset.close === '1') closeEnv();
    });
  }
  els.btnCopyCsv.addEventListener('click', () => {
    if (!store.lastRun) {
      toast('还没有可复制的指标', 'warn');
      return;
    }
    copyText(metricsCsv(), '指标表已复制为 CSV');
  });
}

function renderAll() {
  renderHealth();
  renderPackSelect();
  renderPanel();
  renderSummary();
  sweepView.buildMetricOptions((store.data && store.data.scoreMetric) || 'far.correlation');
  sweepView.render();
  if (optimizeView) {
    optimizeView.buildObjectiveOptions('both');
    optimizeView.render();
  }
  renderResults();
  syncDisplayControls();
  syncJobUI();
}

async function boot() {
  try {
    store.health = await api.health();
  } catch (err) {
    store.health = null;
  }
  try {
    await refreshState();
  } catch (err) {
    store.data = null;
    toast(`加载状态失败：${err.message}`);
  }

  if (!displayPrefsLoaded && store.data && store.data.settings && typeof store.data.settings.display_gamma === 'number') {
    store.display.gamma = store.data.settings.display_gamma;
    S.saveJSON(S.LS_KEY.display, store.display);
  }

  const savedPinned = S.loadJSON(S.LS_KEY.pinned, null);
  if (Array.isArray(savedPinned) && savedPinned.length === 2) store.pinnedKeys = savedPinned;

  renderAll();
  checkEnv({ quiet: true });
  if (!store.data) {
    toast('无法获取 /api/state，界面已进入空白状态', 'error');
  }
}

function main() {
  imageView = createImageView(els.imageGrid);
  panel = createPanel({
    host: els.sideBody,
    getDirtyCount: S.dirtyCount,
    getDirtyKeys: dirtyKeys,
    onEdit(scope, key, value) {
      S.setDraftValue(scope, key, value);
      panel.refreshDirty();
      renderSummary();
      scheduleHealth();
    },
    onSave: saveSettings,
    onReset: resetDraft,
    onError: (msg) => toast(msg),
    getRoles: () => (store.data && store.data.roles) || {},
    getRoleOrder: () => (store.data && store.data.roleOrder) || null,
    getHealth: () => (store.data && store.data.health) || [],
    getPresets: () => (store.data && store.data.presets) || [],
    getLabels: () => {
      const map = {};
      S.schemaDefs().forEach((def) => { if (def && def.key) map[def.key] = def.label || def.key; });
      S.packDefs().forEach((def) => { if (def && def.key) map[def.key] = def.label || def.key; });
      return map;
    },
    onPreset: applyPreset,
    onSet: setParam,
  });

  sweepView = createSweepView({
    els: {
      list: $('axis-list'),
      estimate: $('sweep-estimate'),
      metric: $('sweep-metric'),
      direction: $('sweep-direction'),
      quality: $('sweep-quality'),
      runBtn: $('btn-sweep'),
      progress: $('sweep-progress'),
      progressFill: $('sweep-progress-fill'),
      progressText: $('sweep-progress-text'),
      resultCard: $('sweep-result-card'),
      table: $('sweep-table'),
      summary: $('sweep-summary'),
      csvBtn: $('btn-sweep-csv'),
    },
    getItems() {
      const items = [];
      const push = (def, scope) => {
        if (!def || !def.sweepable) return;
        if (['number', 'int', 'enum', 'bool'].indexOf(def.type) < 0) return;
        items.push({
          key: def.key,
          label: def.label || def.key,
          unit: def.unit || '',
          type: def.type,
          options: Array.isArray(def.options) ? def.options : [],
          sweep: def.sweep || null,
          min: def.min,
          max: def.max,
          step: def.step,
          scope,
        });
      };
      S.schemaDefs().forEach((def) => push(def, 'settings'));
      S.packDefs().forEach((def) => push(def, 'packValues'));
      return items;
    },
    isRunning: jobBusy,
    getResult: () => store.sweepResult,
    toast,
    onApply: applyParams,
    onRun(req) {
      const pack = S.activePack();
      if (!pack) {
        toast('没有可用设计包', 'warn');
        return;
      }
      if (pack.ok === false) {
        toast(`设计包不可用：${pack.error || '检查未通过'}`, 'warn');
        return;
      }
      const payload = Object.assign(
        {
          packId: pack.id,
          quality: req.quality,
          axes: req.axes,
          scoreMetric: req.scoreMetric,
          direction: req.direction,
        },
        S.draftOverrides(),
      );
      startJob('sweep', payload);
    },
  });

  optimizeView = createOptimizeView({
    els: {
      list: $('opt-var-list'),
      estimate: $('opt-estimate'),
      excludedBox: $('opt-excluded'),
      excluded: $('opt-excluded-list'),
      objective: $('opt-objective'),
      quality: $('opt-quality'),
      budget: $('opt-budget'),
      runBtn: $('btn-optimize'),
      applyBtn: $('btn-opt-apply'),
      progress: $('opt-progress'),
      progressFill: $('opt-progress-fill'),
      progressText: $('opt-progress-text'),
      resultCard: $('opt-result-card'),
      summary: $('opt-summary'),
      best: $('opt-best'),
      chart: $('opt-chart'),
      table: $('opt-table'),
      boundsHint: $('opt-bounds'),
      historySummary: $('opt-history-summary'),
      startPoint: $('opt-startpoint'),
      notes: $('opt-notes'),
      verify: $('opt-verify'),
    },
    getParams: () => (store.data && Array.isArray(store.data.optimizeParams) ? store.data.optimizeParams : []),
    getObjectives: () => (store.data && Array.isArray(store.data.optimizeObjectives) ? store.data.optimizeObjectives : []),
    getExcluded: () => (store.data && Array.isArray(store.data.optimizeExcluded) ? store.data.optimizeExcluded : []),
    getHealth: () => (store.data && store.data.health) || [],
    getPresets: () => (store.data && store.data.presets) || [],
    onPreset: applyPreset,
    onSet: setParam,
    getValue: (key) => {
      const def = S.findDef(key);
      return def ? S.valueOf(def, S.defScope(key)) : undefined;
    },
    isRunning: jobBusy,
    getResult: () => store.optimizeResult,
    toast,
    onApply: applyParams,
    onRun(req, warnings) {
      const pack = S.activePack();
      if (!pack) {
        toast('没有可用设计包', 'warn');
        return;
      }
      if (pack.ok === false) {
        toast(`设计包不可用：${pack.error || '检查未通过'}`, 'warn');
        return;
      }
      if (warnings && warnings.length) toast(warnings[0], 'warn');
      const payload = Object.assign(
        {
          packId: pack.id,
          quality: req.quality,
          variables: req.variables,
          ranges: req.ranges,
          objective: req.objective,
          maxEvals: req.maxEvals,
        },
        S.draftOverrides(),
      );
      startJob('optimize', payload);
    },
  });

  initTopbar();
  initTabs();
  initDrawer();
  initModal();
  initDisplayControls();
  syncJobUI();
  boot();
}

main();
