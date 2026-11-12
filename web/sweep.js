/**
 * 参数扫描 Tab：可扫描参数勾选、取值区间、组合数估算、进度与结果表。
 */

import { SCORE_METRICS, fmtNum } from './state.js';

const KEY_METRICS = [
  { key: 'far.correlation', label: '远场相关' },
  { key: 'near.correlation', label: '近场相关' },
  { key: 'far.normalized_rmse', label: '远场 RMSE' },
];

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  const a = attrs || {};
  for (const key of Object.keys(a)) {
    const val = a[key];
    if (val === null || val === undefined || val === false) continue;
    if (key === 'class') node.className = val;
    else if (key === 'text') node.textContent = val;
    else if (key.indexOf('on') === 0 && typeof val === 'function') node.addEventListener(key.slice(2), val);
    else if (val === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(val));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    const list = Array.isArray(child) ? child : [child];
    for (const item of list) {
      if (item === null || item === undefined || item === false) continue;
      node.append(item instanceof Node ? item : document.createTextNode(String(item)));
    }
  }
  return node;
}

function toNumber(text) {
  const raw = String(text).trim();
  if (!raw) return NaN;
  const num = Number(raw);
  return Number.isFinite(num) ? num : NaN;
}

function formatParam(value) {
  if (typeof value === 'number') return fmtNum(value);
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (value === null || value === undefined) return '—';
  return String(value);
}

function classify(value) {
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return 1;
  return 2;
}

export function createSweepView(ctx) {
  const els = ctx.els;
  const axes = new Map();
  let items = [];
  let result = null;
  let sort = { key: 'score', dir: 'desc' };

  /* ---------- 单轴取值 ---------- */

  function defaultAxis(item) {
    const sweep = item.sweep || {};
    const listValues = Array.isArray(sweep.values) ? sweep.values : null;
    const hasStep = typeof sweep.min === 'number' && typeof sweep.max === 'number' && typeof sweep.step === 'number';
    const options = Array.isArray(item.options) ? item.options : [];
    const selected = new Set();
    if (item.type === 'enum') {
      const source = listValues || options.map((o) => o.value);
      source.forEach((v) => selected.add(String(v)));
    } else if (item.type === 'bool') {
      if (listValues) listValues.forEach((v) => selected.add(Boolean(v)));
      else {
        selected.add(true);
        selected.add(false);
      }
    }
    return {
      on: false,
      mode: listValues && !hasStep ? 'list' : 'step',
      min: hasStep ? sweep.min : typeof item.min === 'number' ? item.min : 0,
      max: hasStep ? sweep.max : typeof item.max === 'number' ? item.max : 1,
      step: hasStep ? sweep.step : typeof item.step === 'number' ? item.step : 0.1,
      list: listValues ? listValues.join(', ') : '',
      selected,
    };
  }

  function valuesOf(item, st) {
    if (item.type === 'enum') {
      const values = (item.options || []).map((o) => o.value).filter((v) => st.selected.has(String(v)));
      return values.length ? { values } : { values: [], error: '请至少选择一个取值' };
    }
    if (item.type === 'bool') {
      const values = [];
      if (st.selected.has(true)) values.push(true);
      if (st.selected.has(false)) values.push(false);
      return values.length ? { values } : { values: [], error: '请至少选择一个取值' };
    }
    if (st.mode === 'list') {
      const parts = String(st.list).split(/[,，;；\s]+/).filter((s) => s.length > 0);
      if (!parts.length) return { values: [], error: '值列表为空' };
      const values = [];
      for (const part of parts) {
        const num = toNumber(part);
        if (!Number.isFinite(num)) return { values: [], error: `“${part}” 不是数字` };
        values.push(item.type === 'int' ? Math.round(num) : num);
      }
      return { values };
    }
    const { min, max, step } = st;
    if (![min, max, step].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return { values: [], error: '请填写完整的 min / max / step' };
    }
    if (step <= 0) return { values: [], error: 'step 必须大于 0' };
    if (max < min) return { values: [], error: 'max 不能小于 min' };
    const count = Math.floor((max - min) / step + 1e-9) + 1;
    if (count <= 0) return { values: [], error: '取值区间为空' };
    if (count > 200) return { values: [], error: `组合过多（${count} 个取值，上限 200）` };
    const values = [];
    for (let i = 0; i < count; i += 1) {
      const raw = min + i * step;
      values.push(item.type === 'int' ? Math.round(raw) : Number(raw.toPrecision(12)));
    }
    return { values };
  }

  /* ---------- 渲染 ---------- */

  function axisNode(item) {
    const st = axes.get(item.key);
    const head = el(
      'div',
      { class: 'axis-head' },
      el(
        'label',
        { class: 'check' },
        el('input', {
          type: 'checkbox',
          checked: st.on,
          'aria-label': `扫描 ${item.label}`,
          onchange: (event) => {
            st.on = event.target.checked;
            body.hidden = !st.on;
            node.classList.toggle('active', st.on);
            updateEstimate();
          },
        }),
        el('span', { class: 'axis-label', text: item.label }),
      ),
      el('span', { class: 'tag mono', text: item.key }),
      item.unit ? el('span', { class: 'tag unit', text: item.unit }) : null,
      el('span', { class: 'axis-count mono', text: '' }),
    );

    const body = el('div', { class: 'axis-body', hidden: !st.on });
    const countEl = head.querySelector('.axis-count');

    const sync = () => {
      const res = valuesOf(item, st);
      countEl.textContent = res.error ? '—' : `${res.values.length} 个值`;
      countEl.title = res.error || '';
      countEl.classList.toggle('bad', Boolean(res.error) && st.on);
      node.classList.toggle('invalid', Boolean(res.error) && st.on);
      updateEstimate();
    };

    if (item.type === 'enum' || item.type === 'bool') {
      const grid = el('div', { class: 'check-grid' });
      const options = item.type === 'bool'
        ? [{ value: true, label: '开' }, { value: false, label: '关' }]
        : item.options || [];
      for (const opt of options) {
        const value = item.type === 'bool' ? Boolean(opt.value) : String(opt.value);
        const box = el('input', { type: 'checkbox', checked: st.selected.has(value), 'aria-label': `取值 ${opt.label || opt.value}` });
        box.addEventListener('change', () => {
          if (box.checked) st.selected.add(value);
          else st.selected.delete(value);
          sync();
        });
        grid.append(el('label', { class: 'check' }, box, el('span', { text: String(opt.label || opt.value) })));
      }
      body.append(el('p', { class: 'axis-hint', text: '勾选要扫描的取值（多选）。' }), grid);
    } else {
      const modeStep = el('input', { type: 'radio', name: `mode-${item.key}`, checked: st.mode === 'step' });
      const modeList = el('input', { type: 'radio', name: `mode-${item.key}`, checked: st.mode === 'list' });
      const modes = el(
        'div',
        { class: 'axis-modes' },
        el('label', { class: 'check' }, modeStep, el('span', { text: '按步长' })),
        el('label', { class: 'check' }, modeList, el('span', { text: '自定义值列表' })),
      );

      const minInput = el('input', { class: 'input mono', type: 'number', step: 'any', value: st.min, 'aria-label': `${item.label} min` });
      const maxInput = el('input', { class: 'input mono', type: 'number', step: 'any', value: st.max, 'aria-label': `${item.label} max` });
      const stepInput = el('input', { class: 'input mono', type: 'number', step: 'any', value: st.step, 'aria-label': `${item.label} step` });
      const stepFields = el(
        'div',
        { class: 'axis-fields' },
        el('label', null, el('span', { text: 'min' }), minInput),
        el('label', null, el('span', { text: 'max' }), maxInput),
        el('label', null, el('span', { text: 'step' }), stepInput),
      );

      const listInput = el('input', { class: 'input mono', type: 'text', value: st.list, placeholder: '0.3, 0.5, 0.8', 'aria-label': `${item.label} 自定义值列表` });
      const listField = el('label', { class: 'axis-list-field' }, el('span', { text: '自定义值（逗号分隔）' }), listInput);

      const applyMode = () => {
        stepFields.hidden = st.mode !== 'step';
        listField.hidden = st.mode !== 'list';
      };
      modeStep.addEventListener('change', () => {
        st.mode = 'step';
        applyMode();
        sync();
      });
      modeList.addEventListener('change', () => {
        st.mode = 'list';
        applyMode();
        sync();
      });
      minInput.addEventListener('input', () => {
        st.min = toNumber(minInput.value);
        sync();
      });
      maxInput.addEventListener('input', () => {
        st.max = toNumber(maxInput.value);
        sync();
      });
      stepInput.addEventListener('input', () => {
        st.step = toNumber(stepInput.value);
        sync();
      });
      listInput.addEventListener('input', () => {
        st.list = listInput.value;
        sync();
      });

      applyMode();
      body.append(modes, stepFields, listField);
    }

    const node = el('article', { class: 'axis', 'data-key': item.key }, head, body);
    if (st.on) node.classList.add('active');
    sync();
    return node;
  }

  function render() {
    items = ctx.getItems();
    const next = new Map();
    for (const item of items) {
      next.set(item.key, axes.get(item.key) || defaultAxis(item));
    }
    axes.clear();
    next.forEach((value, key) => axes.set(key, value));

    els.list.replaceChildren();
    if (!items.length) {
      els.list.append(el('p', { class: 'empty-line', text: '当前 schema 中没有标记 sweepable 的参数。' }));
    } else {
      for (const item of items) els.list.append(axisNode(item));
    }
    updateEstimate();
    setResult(typeof ctx.getResult === 'function' ? ctx.getResult() : result);
  }

  function totalCount() {
    let total = 1;
    let used = 0;
    for (const item of items) {
      const st = axes.get(item.key);
      if (!st || !st.on) continue;
      const res = valuesOf(item, st);
      if (res.error || !res.values.length) return 0;
      total *= res.values.length;
      used += 1;
    }
    return used ? total : 0;
  }

  function updateEstimate() {
    const total = totalCount();
    els.estimate.textContent = total ? `预计 ${total} 次计算` : '预计 0 次计算';
    els.estimate.classList.toggle('warn', total > 200);
    els.runBtn.disabled = ctx.isRunning() || total === 0;
  }

  /* ---------- 结果 ---------- */

  function columnsFor(sweep) {
    const cols = [];
    if (Array.isArray(sweep.columns) && sweep.columns.length) {
      for (const col of sweep.columns) {
        cols.push({ kind: 'axis', key: col.key, label: col.label || col.key, unit: col.unit || '' });
      }
    } else {
      const first = (sweep.rows && sweep.rows[0]) || null;
      const keys = first && first.params ? Object.keys(first.params) : [];
      for (const key of keys) cols.push({ kind: 'axis', key, label: key, unit: '' });
    }
    cols.push({ kind: 'score', key: 'score', label: 'score', unit: '' });
    for (const m of KEY_METRICS) cols.push({ kind: 'metric', key: m.key, label: m.label, unit: '' });
    return cols;
  }

  function cellValue(row, col) {
    if (col.kind === 'score') return typeof row.score === 'number' ? row.score : null;
    if (col.kind === 'metric') {
      const v = row.metrics ? row.metrics[col.key] : null;
      return typeof v === 'number' ? v : null;
    }
    return row.params ? row.params[col.key] : null;
  }

  function sortedRows(sweep, cols) {
    const rows = Array.isArray(sweep.rows) ? sweep.rows.slice() : [];
    const col = cols.find((c) => c.key === sort.key && c.kind === (sort.kind || 'score')) || cols.find((c) => c.key === 'score');
    if (!col) return rows;
    const sign = sort.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = cellValue(a, col);
      const bv = cellValue(b, col);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const ca = classify(av);
      const cb = classify(bv);
      if (ca !== cb) return ca - cb;
      if (ca === 2) return String(av).localeCompare(String(bv)) * sign;
      if (av === bv) return 0;
      return av > bv ? sign : -sign;
    });
    return rows;
  }

  function isBestRow(row, best) {
    if (!best || typeof row.score !== 'number' || typeof best.score !== 'number') return false;
    if (row.score !== best.score) return false;
    return JSON.stringify(row.params || {}) === JSON.stringify(best.params || {});
  }

  function setResult(next) {
    result = next || null;
    if (!result || !Array.isArray(result.rows)) {
      els.resultCard.hidden = true;
      return;
    }
    els.resultCard.hidden = false;
    const cols = columnsFor(result);
    const rows = sortedRows(result, cols);
    const best = result.best || null;

    els.summary.textContent = `共 ${result.total || rows.length} 组，评分 ${result.scoreMetric || '—'}，质量 ${result.quality || '—'}${
      best && typeof best.score === 'number' ? `，最优 ${fmtNum(best.score)}` : ''
    }`;

    const table = els.table;
    table.replaceChildren();

    const thead = el('thead');
    const headRow = el('tr');
    for (const col of cols) {
      const active = sort.key === col.key;
      const th = el('th', {
        scope: 'col',
        class: `sortable${active ? ' active' : ''}`,
        'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
        title: '点击排序',
      });
      const btn = el('button', { type: 'button', class: 'sort-btn' }, el('span', { text: col.label }), el('span', { class: 'sort-arrow', text: active ? (sort.dir === 'asc' ? '↑' : '↓') : '' }));
      btn.addEventListener('click', () => {
        if (sort.key === col.key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else sort = { key: col.key, dir: col.kind === 'axis' ? 'asc' : 'desc', kind: col.kind };
        setResult(result);
      });
      th.append(btn);
      headRow.append(th);
    }
    headRow.append(el('th', { scope: 'col', class: 'apply-col', text: '操作' }));
    thead.append(headRow);
    table.append(thead);

    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr', { class: isBestRow(row, best) ? 'best' : '' });
      if (row.ok === false) tr.classList.add('failed');
      for (const col of cols) {
        const value = cellValue(row, col);
        const td = el('td', { class: col.kind === 'axis' ? 'mono' : 'mono num' });
        if (col.kind === 'axis') {
          td.textContent = formatParam(value);
        } else {
          td.textContent = fmtNum(value);
        }
        if (col.kind === 'score' && isBestRow(row, best)) td.classList.add('best-score');
        tr.append(td);
      }
      const applyCell = el('td', { class: 'apply-col' });
      const applyBtn = el('button', {
        type: 'button',
        class: 'btn ghost xs',
        text: '应用',
        title: row.ok === false ? '该组合计算失败，仍可回填参数' : '把该行参数回填到左侧面板',
      });
      applyBtn.addEventListener('click', () => {
        ctx.onApply(row.params || {});
      });
      applyCell.append(applyBtn);
      tr.append(applyCell);
      if (row.ok === false && row.note) tr.title = row.note;
      tbody.append(tr);
    }
    table.append(tbody);
    table.dataset.best = best ? '1' : '';
  }

  function exportCsv() {
    if (!result || !Array.isArray(result.rows)) return;
    const cols = columnsFor(result);
    const rows = sortedRows(result, cols);
    const head = cols.map((c) => c.label).join(',');
    const lines = [head];
    for (const row of rows) {
      lines.push(
        cols
          .map((col) => {
            const value = cellValue(row, col);
            if (value === null || value === undefined) return '';
            const text = typeof value === 'number' ? String(value) : formatParam(value);
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          })
          .join(','),
      );
    }
    const blob = new Blob([`\ufeff${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sweep-${result.scoreMetric || 'result'}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------- 进度 ---------- */

  function setJob(job) {
    if (!job || job.kind !== 'sweep') {
      els.progress.hidden = true;
      els.progressFill.style.width = '0%';
      return;
    }
    els.progress.hidden = false;
    const total = (job.sweep && typeof job.sweep.total === 'number' && job.sweep.total) || job.total || 0;
    let done = job.sweep && typeof job.sweep.completed === 'number' ? job.sweep.completed : 0;
    if (!done && total && typeof job.progress === 'number') done = Math.round(job.progress * total);
    const pct = typeof job.progress === 'number' ? Math.max(2, Math.min(100, job.progress * 100)) : 2;
    els.progressFill.style.width = `${pct}%`;
    els.progressText.textContent = total ? `已完成 ${done}/${total} · ${job.message || '计算中'}` : `${job.message || '计算中'}`;
  }

  function setBusy(busy) {
    els.runBtn.disabled = busy || totalCount() === 0;
    els.runBtn.textContent = busy ? '扫描中…' : '运行扫描';
  }

  function collectRequest() {
    const list = [];
    for (const item of items) {
      const st = axes.get(item.key);
      if (!st || !st.on) continue;
      const res = valuesOf(item, st);
      if (res.error) {
        ctx.toast(`「${item.label}」${res.error}`);
        return null;
      }
      list.push({ key: item.key, values: res.values });
    }
    if (!list.length) {
      ctx.toast('请先勾选要扫描的参数');
      return null;
    }
    return {
      axes: list,
      scoreMetric: els.metric.value,
      direction: els.direction.value,
      quality: els.quality.value,
    };
  }

  function buildMetricOptions(defaultKey) {
    els.metric.replaceChildren();
    for (const item of SCORE_METRICS) {
      els.metric.append(el('option', { value: item.key, text: item.label }));
    }
    if (!SCORE_METRICS.some((m) => m.key === defaultKey)) defaultKey = SCORE_METRICS[0].key;
    els.metric.value = defaultKey;
    syncDirection();
  }

  function syncDirection() {
    const def = SCORE_METRICS.find((m) => m.key === els.metric.value);
    if (def) els.direction.value = def.direction;
  }

  els.metric.addEventListener('change', syncDirection);
  els.runBtn.addEventListener('click', () => {
    const req = collectRequest();
    if (req) ctx.onRun(req);
  });
  els.csvBtn.addEventListener('click', exportCsv);

  return {
    render,
    setResult,
    setJob,
    setBusy,
    buildMetricOptions,
    totalCount,
  };
}
