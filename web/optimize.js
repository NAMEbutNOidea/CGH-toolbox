/**
 * 自动优化 Tab：勾选可变参数 → 以「一级 vs 理想一级」的相似系数为目标做坐标模式搜索。
 *
 * 与「参数扫描」的分工：扫描是穷举你给定的取值集合，优化是让后端自己决定下一步往哪走，
 * 因此这里只需要给区间，不需要给步长。
 *
 * 2026-11 重构：
 *   · 变量按角色分组——设计旋钮默认勾选，标定项默认不勾（它会把装调误差吸进标定里）；
 *   · 默认区间收窄到当前值 ±30%，不再把 0.2–12 mm 的整个量程丢给优化器；
 *   · 结果显示后端去重后的真实评估次数、饱和提示、fast→full 复核。
 */

import { fmtNum } from './state.js';

const RANK_LABEL = { recommended: '推荐', optional: '可选', caution: '慎用' };

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

/** 变量取值的人类可读形式：枚举显示标签，数值带单位。 */
function formatValue(def, value) {
  if (value === undefined || value === null) return '—';
  if (def && def.type === 'enum') {
    const hit = (def.options || []).find((o) => String(o.value) === String(value));
    return hit ? (hit.label || hit.value) : String(value);
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${fmtNum(num)}${(def && def.unit) || ''}`;
}

function trimNum(value) {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  const digits = abs >= 100 ? 1 : abs >= 1 ? 3 : 4;
  return String(Number(value.toPrecision(digits)));
}

/**
 * 围绕当前值给一个「有意义」的默认搜索区间。
 * 旧版用 0.5×–2×，对 2.5 mm 芯径就是 1.25–5 mm，两端都已经被窗口切掉，
 * 纯属浪费评估；±30% 才落在「同一个光斑、只是标定略有偏差」的范围里。
 */
function defaultRange(def, current) {
  const lo = Number(def.min);
  const hi = Number(def.max);
  let v = Number(current);
  if (!Number.isFinite(v)) v = Number(def.default);
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) return [lo, hi];
  const frac = def.role === 'calibration' ? 0.2 : 0.3;
  if (Math.abs(v) < 1e-12) {
    const span = (hi - lo) * 0.08;
    if (!(span > 0)) return [lo, hi];
    return [Math.max(lo, -span), Math.min(hi, span)];
  }
  const a = Math.max(lo, v * (1 - frac));
  const b = Math.min(hi, v * (1 + frac));
  if (!(b > a)) return [lo, hi];
  return [Math.round(a * 1e4) / 1e4, Math.round(b * 1e4) / 1e4];
}

export function createOptimizeView(ctx) {
  const els = ctx.els;
  const marks = new Map(); // key -> {on, min, max}
  let defs = [];
  let result = null;

  function currentOf(def) {
    const value = ctx.getValue(def.key);
    return value === undefined || value === null ? def.default : value;
  }

  /* ---------------- 变量列表 ---------------- */

  function varRow(def) {
    const state = marks.get(def.key);
    const current = currentOf(def);
    const isEnum = def.type === 'enum';
    const tag = el('span', {
      class: `opt-rank ${def.rank === 'recommended' ? 'rec' : (def.rank === 'caution' ? 'caution' : '')}`,
      text: RANK_LABEL[def.rank] || '可选',
    });

    const head = el(
      'div',
      { class: 'opt-head' },
      el(
        'label',
        { class: 'check' },
        el('input', {
          type: 'checkbox',
          checked: state.on,
          'aria-label': `把 ${def.label} 作为优化变量`,
          onchange: (event) => {
            state.on = event.target.checked;
            body.hidden = !state.on;
            node.classList.toggle('active', state.on);
            updateEstimate();
          },
        }),
        el('span', { class: 'opt-label', text: def.label }),
      ),
      tag,
      el('span', { class: 'opt-current mono', text: `当前 ${formatValue(def, current)}` }),
    );

    const body = el('div', { class: 'opt-body', hidden: !state.on });
    if (isEnum) {
      const names = (def.options || []).map((o) => o.label || o.value);
      body.append(el('p', {
        class: 'opt-hint',
        text: `离散量：${names.length} 个取值会各试一次（${names.join('、')}）。`,
      }));
    } else {
      const minInput = el('input', {
        class: 'input mono', type: 'number', step: 'any', value: trimNum(state.min),
        'aria-label': `${def.label} 搜索下限`,
      });
      const maxInput = el('input', {
        class: 'input mono', type: 'number', step: 'any', value: trimNum(state.max),
        'aria-label': `${def.label} 搜索上限`,
      });
      minInput.addEventListener('input', () => {
        state.min = toNumber(minInput.value);
        updateEstimate();
      });
      maxInput.addEventListener('input', () => {
        state.max = toNumber(maxInput.value);
        updateEstimate();
      });
      body.append(
        el(
          'div',
          { class: 'opt-fields' },
          el('label', null, el('span', { text: '下限' }), minInput),
          el('label', null, el('span', { text: '上限' }), maxInput),
          el('span', { class: 'opt-unit mono', text: def.unit || '' }),
          el('button', {
            class: 'mini-btn', type: 'button', text: '±30%',
            title: '把区间重置为当前值的 ±30%（标定项 ±20%）',
            onclick: () => {
              const [lo, hi] = defaultRange(def, currentOf(def));
              state.min = lo;
              state.max = hi;
              minInput.value = trimNum(lo);
              maxInput.value = trimNum(hi);
              updateEstimate();
            },
          }),
        ),
      );
    }
    if (def.note) body.append(el('p', { class: 'opt-note', text: def.note }));

    const node = el('article', { class: 'axis opt-var', 'data-key': def.key }, head, body);
    if (state.on) node.classList.add('active');
    return node;
  }

  function renderList() {
    const params = ctx.getParams() || [];
    defs = params.filter((p) => p.optimizable);
    const next = new Map();
    for (const def of defs) {
      const prev = marks.get(def.key);
      if (prev) {
        next.set(def.key, prev);
        continue;
      }
      const [lo, hi] = def.type === 'enum' ? [null, null] : defaultRange(def, currentOf(def));
      // 标定项默认不勾：它会把装调误差吸进标定里，数字好看但装置没变
      const auto = def.rank === 'recommended' && def.role !== 'calibration';
      next.set(def.key, { on: auto, min: lo, max: hi });
    }
    marks.clear();
    next.forEach((value, key) => marks.set(key, value));

    els.list.replaceChildren();
    if (!defs.length) {
      els.list.append(el('p', { class: 'empty-line', text: '当前 schema 没有可优化参数。' }));
    } else {
      const knobs = defs.filter((d) => d.role !== 'calibration');
      const calib = defs.filter((d) => d.role === 'calibration');
      if (knobs.length) {
        els.list.append(el('h3', { class: 'opt-group-title', text: '设计旋钮（改了装置还是那台装置）' }));
        knobs.forEach((def) => els.list.append(varRow(def)));
      }
      if (calib.length) {
        els.list.append(el('h3', { class: 'opt-group-title warn', text: '标定项（默认不勾：优化它等于让算法吸收装调误差）' }));
        calib.forEach((def) => els.list.append(varRow(def)));
      }
    }
    renderExcluded();
    renderStartPoint();
    updateEstimate();
    setResult(typeof ctx.getResult === 'function' ? ctx.getResult() : result);
  }

  /** 起点体检：参数组合本身自相矛盾时，先修起点比优化更有效。 */
  function renderStartPoint() {
    if (!els.startPoint) return;
    const items = (ctx.getHealth && ctx.getHealth()) || [];
    const bad = items.filter((i) => i.level === 'warn');
    if (!bad.length) {
      els.startPoint.hidden = true;
      els.startPoint.replaceChildren();
      return;
    }
    els.startPoint.hidden = false;
    const rows = bad.map((item) => el('div', { class: 'health-item warn' },
      el('div', { class: 'health-item-head' },
        el('span', { class: 'health-dot warn', 'aria-hidden': 'true' }),
        el('strong', { text: item.title })),
      el('p', { class: 'health-detail', text: item.detail }),
      item.action
        ? el('button', {
          class: 'btn ghost sm', type: 'button', text: item.action.label || '应用建议',
          onclick: () => {
            if (item.action.preset) ctx.onPreset && ctx.onPreset(item.action.preset);
            else if (item.action.setting) ctx.onSet && ctx.onSet(item.action.setting.key, item.action.setting.value);
          },
        })
        : null));
    els.startPoint.replaceChildren(
      el('div', { class: 'health-head' },
        el('span', { class: 'health-dot warn', 'aria-hidden': 'true' }),
        el('strong', { text: '起点参数自相矛盾，先修这里比优化更有效' })),
      el('div', { class: 'health-list' }, rows));
  }

  function renderExcluded() {
    const lines = [];
    for (const item of ctx.getExcluded() || []) {
      lines.push(el(
        'li',
        null,
        el('strong', { text: item.title }),
        el('span', { class: 'opt-exc-reason', text: item.reason }),
      ));
    }
    for (const def of (ctx.getParams() || []).filter((p) => p.optimizable === false && p.note)) {
      lines.push(el(
        'li',
        null,
        el('strong', { text: def.label }),
        el('span', { class: 'opt-exc-reason', text: def.note }),
      ));
    }
    els.excluded.replaceChildren(...lines);
    if (els.excludedBox) els.excludedBox.hidden = lines.length === 0;
  }

  /* ---------------- 估算与请求 ---------------- */

  function selected() {
    return defs.filter((def) => {
      const st = marks.get(def.key);
      return st && st.on;
    });
  }

  function updateEstimate() {
    const list = selected();
    let evals = list.length ? 1 : 0;
    let bad = 0;
    let enums = 0;
    let nums = 0;
    for (const def of list) {
      const st = marks.get(def.key);
      if (def.type === 'enum') {
        evals += Math.max(0, (def.options || []).length - 1);
        enums += 1;
      } else {
        evals += 4;
        nums += 1;
        if (!Number.isFinite(st.min) || !Number.isFinite(st.max) || !(st.max > st.min)) bad += 1;
      }
    }
    const label = list.length
      ? `已选 ${list.length} 个（${nums} 连续 + ${enums} 离散）· 粗扫至少 ${evals} 次`
      : '已选 0 个变量';
    els.estimate.textContent = label;
    els.estimate.classList.toggle('warn', bad > 0);
    if (bad > 0) els.estimate.title = '有变量的下限不小于上限，请修正';
    else els.estimate.title = list.length
      ? '粗扫之后会用剩余预算做局部精修；重复的参数组合会自动跳过，不重复计算'
      : '';
    els.runBtn.disabled = ctx.isRunning() || list.length === 0 || bad > 0;
  }

  function collectRequest() {
    const list = selected();
    if (!list.length) {
      ctx.toast('请先勾选要优化的参数');
      return null;
    }
    const variables = [];
    const ranges = {};
    for (const def of list) {
      const st = marks.get(def.key);
      variables.push(def.key);
      if (def.type === 'enum') continue;
      if (!Number.isFinite(st.min) || !Number.isFinite(st.max)) {
        ctx.toast(`「${def.label}」的区间没填完整`);
        return null;
      }
      if (!(st.max > st.min)) {
        ctx.toast(`「${def.label}」的区间上限必须大于下限`);
        return null;
      }
      ranges[def.key] = { min: st.min, max: st.max };
    }
    const budget = Math.max(6, Math.min(400, Math.round(toNumber(els.budget.value) || 40)));
    return {
      variables,
      ranges,
      objective: els.objective.value,
      quality: els.quality.value,
      maxEvals: budget,
      verify: els.verify ? Boolean(els.verify.checked) : true,
    };
  }

  /* ---------------- 结果 ---------------- */

  function scoreText(value) {
    return typeof value === 'number' ? value.toFixed(4) : '—';
  }

  function chart(history, baseScore) {
    const pts = history.map((row, index) => ({ row, index })).filter((p) => typeof p.row.score === 'number');
    if (!pts.length) return el('p', { class: 'empty-line', text: '没有可绘制的评估点。' });
    const W = 640;
    const H = 130;
    const padL = 6;
    const padR = 6;
    const padT = 10;
    const padB = 16;
    const values = pts.map((p) => p.row.score);
    if (typeof baseScore === 'number') values.push(baseScore);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (!(hi > lo)) {
      hi = lo + 0.01;
      lo -= 0.01;
    }
    const xOf = (i) => padL + ((W - padL - padR) * i) / Math.max(1, history.length - 1);
    const yOf = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
    const line = pts.map((p) => `${xOf(p.index).toFixed(1)},${yOf(p.row.score).toFixed(1)}`).join(' ');
    const bestPoint = pts.reduce((acc, p) => (acc === null || p.row.score > acc.row.score ? p : acc), null);

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'opt-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '相似系数随评估次数的变化');

    const grid = document.createElementNS(ns, 'line');
    grid.setAttribute('x1', padL);
    grid.setAttribute('x2', W - padR);
    grid.setAttribute('y1', H - padB);
    grid.setAttribute('y2', H - padB);
    grid.setAttribute('class', 'opt-axis');
    svg.append(grid);

    if (typeof baseScore === 'number') {
      const baseLine = document.createElementNS(ns, 'line');
      baseLine.setAttribute('x1', padL);
      baseLine.setAttribute('x2', W - padR);
      baseLine.setAttribute('y1', yOf(baseScore).toFixed(1));
      baseLine.setAttribute('y2', yOf(baseScore).toFixed(1));
      baseLine.setAttribute('class', 'opt-base-line');
      svg.append(baseLine);
    }

    const poly = document.createElementNS(ns, 'polyline');
    poly.setAttribute('points', line);
    poly.setAttribute('class', 'opt-line');
    svg.append(poly);

    for (const p of pts) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', xOf(p.index).toFixed(1));
      dot.setAttribute('cy', yOf(p.row.score).toFixed(1));
      dot.setAttribute('r', p.row.energyOk === false ? '3.4' : '2.2');
      dot.setAttribute('class', `opt-dot${p.row.energyOk === false ? ' warn' : ''}`);
      dot.append(Object.assign(document.createElementNS(ns, 'title'), {
        textContent: `#${p.row.n} ${p.row.tag || ''} · 相似系数 ${p.row.score.toFixed(4)}`
          + (typeof p.row.merit === 'number' ? ` · 归一化改进 ${p.row.merit >= 0 ? '+' : ''}${p.row.merit.toFixed(3)}` : ''),
      }));
      svg.append(dot);
    }
    if (bestPoint) {
      const mark = document.createElementNS(ns, 'circle');
      mark.setAttribute('cx', xOf(bestPoint.index).toFixed(1));
      mark.setAttribute('cy', yOf(bestPoint.row.score).toFixed(1));
      mark.setAttribute('r', '5');
      mark.setAttribute('class', 'opt-best-dot');
      svg.append(mark);
    }
    const caption = el('p', { class: 'opt-chart-cap mono' },
      `${lo.toFixed(3)} – ${hi.toFixed(3)} · 共 ${history.length} 次真实评估`);
    return el('div', { class: 'opt-chart-wrap' }, svg, caption);
  }

  function renderBest(data) {
    const base = data.base || {};
    const best = data.best || {};
    const vars = data.variables || [];
    const rows = [];
    for (const def of vars) {
      const before = base.values ? base.values[def.key] : undefined;
      const after = best.values ? best.values[def.key] : undefined;
      const changed = JSON.stringify(before) !== JSON.stringify(after);
      rows.push(el(
        'tr',
        { class: changed ? 'changed' : '' },
        el('td', { text: def.label }),
        el('td', { class: 'mono num', text: formatValue(def, before) }),
        el('td', { class: 'mono num strong', text: formatValue(def, after) }),
      ));
    }
    const table = el(
      'table',
      { class: 'data-table opt-best-table', id: 'opt-best-table' },
      el('thead', null, el('tr', null,
        el('th', { scope: 'col', text: '变量' }),
        el('th', { scope: 'col', text: '基线' }),
        el('th', { scope: 'col', text: '最优' }))),
      el('tbody', null, rows),
    );

    const merit = typeof data.deltaMerit === 'number' ? data.deltaMerit : null;
    const cards = el(
      'div',
      { class: 'opt-cards' },
      el('div', { class: 'opt-card' },
        el('span', { class: 'opt-card-label', text: '基线相似系数' }),
        el('strong', { class: 'opt-card-value mono', text: scoreText(base.score) })),
      el('div', { class: 'opt-card accent' },
        el('span', { class: 'opt-card-label', text: '最优相似系数' }),
        el('strong', { class: 'opt-card-value mono', text: scoreText(best.score) })),
      el('div', { class: 'opt-card' },
        el('span', { class: 'opt-card-label', text: '变化' }),
        el('strong', {
          class: `opt-card-value mono ${typeof data.delta === 'number' && data.delta > 0 ? 'up' : ''}`,
          text: typeof data.delta === 'number' ? `${data.delta >= 0 ? '+' : ''}${data.delta.toFixed(4)}` : '—',
        })),
      el('div', { class: 'opt-card' },
        el('span', { class: 'opt-card-label', text: '归一化改进' }),
        el('strong', {
          class: `opt-card-value mono ${merit > 0 ? 'up' : ''}`,
          title: '按两个平面的剩余误差归一后的改进量：0 = 没动，1 = 把剩下的误差全消掉',
          text: merit === null ? '—' : `${merit >= 0 ? '+' : ''}${merit.toFixed(3)}`,
        })),
      el('div', { class: 'opt-card' },
        el('span', { class: 'opt-card-label', text: '近 / 远 一级相关' }),
        el('strong', {
          class: 'opt-card-value mono small',
          text: `${scoreText(best.near)} / ${scoreText(best.far)}`,
        })),
    );
    els.best.replaceChildren(cards, table);
  }

  function renderNotes(data) {
    const notes = [];
    if (Array.isArray(data.saturated) && data.saturated.length) {
      notes.push(el('p', { class: 'opt-warn-line' },
        `⚠ ${data.saturated.join('、')}相似系数已 ≥ 0.97（饱和）：继续优化只能挪动小数点后第三位。`
        + '想有实质提升，把评价函数改成「一级能量占比」，或检查起点参数是否自相矛盾。'));
    }
    if (data.cached) {
      notes.push(el('p', { class: 'opt-hint' },
        `已自动跳过 ${data.cached} 次重复组合（同样的参数不重复算 FFT）。`));
    }
    if (data.verify) {
      const v = data.verify;
      notes.push(el('p', { class: 'opt-verify mono' },
        `full 档复核：基线 ${scoreText(v.base && v.base.score)} → 最优 ${scoreText(v.best && v.best.score)}`
        + `（近 ${scoreText(v.best && v.best.near)} / 远 ${scoreText(v.best && v.best.far)}）`
        + (typeof v.delta === 'number' ? ` · Δ ${v.delta >= 0 ? '+' : ''}${v.delta.toFixed(4)}` : '')));
    }
    if (els.notes) els.notes.replaceChildren(...notes);
  }

  function renderHistory(data) {
    const table = els.table;
    table.replaceChildren();
    const history = Array.isArray(data.history) ? data.history : [];
    const head = el('tr', null,
      el('th', { scope: 'col', text: '#' }),
      el('th', { scope: 'col', text: '试探' }),
      el('th', { scope: 'col', text: '相似系数' }),
      el('th', { scope: 'col', text: '改进' }),
      el('th', { scope: 'col', text: '近场' }),
      el('th', { scope: 'col', text: '远场' }),
      el('th', { scope: 'col', text: '一级能量' }),
      el('th', { scope: 'col', text: '耗时' }));
    table.append(el('thead', null, head));
    const tbody = el('tbody');
    for (const row of history) {
      const tr = el('tr', { class: row.ok === false ? 'failed' : (row.energyOk === false ? 'weak' : '') });
      tr.append(el('td', { class: 'mono num', text: String(row.n) }));
      tr.append(el('td', { class: 'mono', text: row.tag || '' }));
      tr.append(el('td', { class: 'mono num strong', text: scoreText(row.score) }));
      tr.append(el('td', {
        class: `mono num ${typeof row.merit === 'number' && row.merit > 0.001 ? 'up' : ''}`,
        text: typeof row.merit === 'number'
          ? `${row.merit >= 0 ? '+' : ''}${row.merit.toFixed(3)}`
          : '—',
      }));
      tr.append(el('td', { class: 'mono num', text: scoreText(row.near) }));
      tr.append(el('td', { class: 'mono num', text: scoreText(row.far) }));
      tr.append(el('td', {
        class: 'mono num',
        text: typeof row.energy === 'number' ? row.energy.toFixed(3) : '—',
      }));
      tr.append(el('td', { class: 'mono num', text: `${row.elapsedMs || 0} ms` }));
      if (row.ok === false && row.note) tr.title = row.note;
      else if (row.energyOk === false) tr.title = '一级能量明显低于基线，评分按比例下调（防止靠变暗刷分）';
      tbody.append(tr);
    }
    table.append(tbody);
    els.historySummary.textContent =
      `逐次评估记录（${history.length} 次真实计算，其中不可行 ${history.filter((r) => r.ok === false).length} 次）`;
  }

  function setResult(next) {
    result = next || null;
    if (!result || !Array.isArray(result.history)) {
      els.resultCard.hidden = true;
      return;
    }
    els.resultCard.hidden = false;
    const base = result.base || {};
    const best = result.best || {};
    const delta = typeof result.delta === 'number' ? result.delta : 0;
    els.summary.textContent =
      `基线 ${scoreText(base.score)} → 最优 ${scoreText(best.score)}`
      + `${delta ? `（${delta > 0 ? '+' : ''}${delta.toFixed(4)}）` : ''}`
      + ` · ${result.evaluated || 0} 次计算 · 质量 ${result.quality || '—'}`;
    const hits = Array.isArray(result.atBounds) ? result.atBounds : [];
    if (els.boundsHint) {
      const names = hits
        .map((key) => (result.variables || []).find((v) => v.key === key))
        .filter(Boolean)
        .map((v) => v.label);
      els.boundsHint.hidden = names.length === 0;
      els.boundsHint.textContent = names.length
        ? `最优值贴在搜索区间边界：${names.join('、')}。真正的最优可能落在区间外，可放宽区间后重跑。`
        : '';
    }
    renderBest(result);
    renderNotes(result);
    els.chart.replaceChildren(chart(result.history, base.score));
    renderHistory(result);
    els.applyBtn.disabled = !best.values || !Object.keys(best.values).length;
  }

  /* ---------------- 进度 ---------------- */

  function setJob(job) {
    if (!job || job.kind !== 'optimize') {
      els.progress.hidden = true;
      els.progressFill.style.width = '0%';
      return;
    }
    els.progress.hidden = false;
    const pct = typeof job.progress === 'number' ? Math.max(2, Math.min(100, job.progress * 100)) : 2;
    els.progressFill.style.width = `${pct}%`;
    els.progressText.textContent = job.message || '优化中';
  }

  function setBusy(busy) {
    els.runBtn.disabled = busy || selected().length === 0;
    els.runBtn.textContent = busy ? '优化中…' : '开始优化';
  }

  function buildObjectiveOptions(defaultKey) {
    const list = ctx.getObjectives() || [];
    els.objective.replaceChildren();
    for (const item of list) {
      els.objective.append(el('option', { value: item.value, text: item.label, title: item.help || '' }));
    }
    const want = defaultKey && list.some((o) => o.value === defaultKey) ? defaultKey : (list[0] && list[0].value);
    if (want) els.objective.value = want;
  }

  els.runBtn.addEventListener('click', () => {
    const req = collectRequest();
    if (!req) return;
    const warnings = [];
    if (!req.variables.includes('encoding_method')) {
      warnings.push('没勾「编码方式」：它是代价最低、收益最直接的变量，建议一起试一遍。');
    }
    const health = (ctx.getHealth && ctx.getHealth()) || [];
    if (health.some((i) => i.level === 'warn')) {
      warnings.push('当前起点参数有体检警告：先按提示修正起点，比在这个起点上优化更有效。');
    }
    ctx.onRun(req, warnings);
  });
  els.applyBtn.addEventListener('click', () => {
    const best = result && result.best;
    if (!best || !best.values) return;
    ctx.onApply(best.values);
  });

  return { render: renderList, setResult, setJob, setBusy, buildObjectiveOptions,
           refreshStart: renderStartPoint };
}
