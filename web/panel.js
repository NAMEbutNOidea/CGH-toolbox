/**
 * 左侧参数面板（schema 驱动）。
 *
 * 布局：一行一个参数（标签在左、控件在右、单位跟在数值后），分组可折叠，
 * 顶部搜索可过滤，帮助文本收进「?」气泡。
 *
 * 2026-11 重构：参数不再是平铺的一堆输入框，而是按 role 分小节——
 *   设计旋钮（日常改） / 标定项（慎动） / 装置常量（默认折叠） / 评价定义 / 数值 / 显示。
 * 不满足 dependsOn 的控件直接灰掉，避免「改了没反应」。
 * 顶部给「配置体检」和预设，任何时刻都能退回一个已知自洽的构型。
 */

import { GROUP_ORDER, PACK_GROUP, has, loadJSON, saveJSON } from './state.js';

const LS_KEY = 'cgh.panel.v2';

const ROLE_FALLBACK = ['design', 'calibration', 'device', 'measure', 'numeric', 'output', 'display'];

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

function listText(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined) return '';
  return String(value);
}

function parseNumberList(raw) {
  const parts = raw.split(/[,，;；\s]+/).filter((s) => s.length > 0);
  const out = [];
  for (const part of parts) {
    const num = Number(part);
    if (!Number.isFinite(num)) return { error: part };
    out.push(num);
  }
  return { values: out };
}

function groupIndex(name) {
  const idx = GROUP_ORDER.indexOf(name);
  return idx < 0 ? GROUP_ORDER.length + 1 : idx;
}

function stepOf(def, type) {
  if (def.step !== undefined && def.step !== null) return def.step;
  return type === 'int' ? 1 : 0.01;
}

function trimNum(value, step) {
  if (!Number.isFinite(value)) return '';
  const decimals = step && step < 1 ? String(step).split('.')[1]?.length || 2 : 0;
  return String(Number(value.toFixed(Math.min(6, decimals))));
}

/** 依赖是否满足：dependsOn 里列出的是「允许生效」的父参数取值。 */
function dependencyOk(def, values) {
  const dep = def.dependsOn;
  if (!dep || !dep.key) return true;
  const current = values ? values[dep.key] : undefined;
  const allowed = dep.values || [];
  return allowed.map(String).indexOf(String(current)) >= 0;
}

export function createPanel(ctx) {
  const host = ctx.host;
  let fields = new Map();
  let bar = null;
  let countEl = null;
  let searchInput = null;
  let emptyHint = null;
  let prefs = loadJSON(LS_KEY, null) || { collapsed: {}, advanced: {}, help: {}, device: {} };
  if (!prefs.collapsed) prefs.collapsed = {};
  if (!prefs.advanced) prefs.advanced = {};
  if (!prefs.device) prefs.device = {};
  const persistPrefs = () => saveJSON(LS_KEY, prefs);

  const roles = () => (ctx.getRoles && ctx.getRoles()) || {};
  const roleOrder = () => (ctx.getRoleOrder && ctx.getRoleOrder()) || ROLE_FALLBACK;

  /* ---------------- 单个控件 ---------------- */

  function numberControl(def, scope, raw, onError) {
    const id = `pf-${scope}-${def.key}`;
    const type = def.type || 'number';
    const step = stepOf(def, type);
    const min = typeof def.min === 'number' ? def.min : null;
    const max = typeof def.max === 'number' ? def.max : null;

    const num = el('input', {
      id,
      class: 'input mono num',
      type: 'number',
      value: raw === undefined || raw === null ? '' : String(raw),
      inputmode: 'decimal',
      step,
      min,
      max,
      autocomplete: 'off',
    });

    const commit = (value) => {
      let next = type === 'int' ? Math.round(value) : value;
      if (min !== null) next = Math.max(min, next);
      if (max !== null) next = Math.min(max, next);
      ctx.onEdit(scope, def.key, next);
      return next;
    };

    num.addEventListener('input', () => {
      const text = num.value.trim();
      if (!text) return;
      const value = Number(text);
      if (!Number.isFinite(value)) return;
      ctx.onEdit(scope, def.key, type === 'int' ? Math.round(value) : value);
    });
    num.addEventListener('change', () => {
      const text = num.value.trim();
      const value = Number(text);
      if (!text || !Number.isFinite(value)) {
        onError(`「${def.label || def.key}」需要数字`);
        num.value = raw === undefined || raw === null ? '' : String(raw);
        return;
      }
      const next = commit(value);
      num.value = String(next);
      if (range) range.value = String(next);
    });

    let range = null;
    if (def.slider === true && min !== null && max !== null) {
      range = el('input', {
        class: 'range',
        type: 'range',
        min,
        max,
        step,
        value: raw === undefined || raw === null ? min : raw,
        'aria-label': `${def.label || def.key} 滑块`,
        tabindex: '-1',
      });
      range.addEventListener('input', () => {
        const next = commit(Number(range.value));
        num.value = trimNum(next, step);
        ctx.onChangeLive && ctx.onChangeLive(scope, def.key);
      });
      return el('div', { class: 'ctl-slider' }, range, num);
    }
    return num;
  }

  function fieldControl(def, scope, values, onError) {
    const id = `pf-${scope}-${def.key}`;
    const type = def.type || 'text';
    const raw = has(values, def.key) ? values[def.key] : def.value !== undefined ? def.value : def.default;

    if (type === 'bool') {
      const input = el('input', { id, type: 'checkbox', role: 'switch' });
      input.checked = Boolean(raw);
      input.addEventListener('change', () => ctx.onEdit(scope, def.key, input.checked));
      return el('label', { class: 'switch', for: id }, input, el('span', { class: 'switch-track', 'aria-hidden': 'true' }));
    }

    if (type === 'enum') {
      const select = el('select', { id, class: 'input' });
      const options = Array.isArray(def.options) ? def.options : [];
      let matched = false;
      for (const opt of options) {
        const value = String(opt && opt.value);
        const label = (opt && (opt.label || opt.value)) || value;
        if (String(raw) === value) matched = true;
        select.append(el('option', { value, text: String(label) }));
      }
      if (!matched && raw !== undefined && raw !== null) {
        select.append(el('option', { value: String(raw), text: String(raw) }));
      }
      select.value = raw === undefined || raw === null ? '' : String(raw);
      select.addEventListener('change', () => ctx.onEdit(scope, def.key, select.value));
      return select;
    }

    if (type === 'float_list' || type === 'string_list') {
      const input = el('input', { id, class: 'input mono', type: 'text', value: listText(raw), spellcheck: 'false' });
      input.addEventListener('change', () => {
        const text = input.value.trim();
        if (type === 'string_list') {
          const items = text.split(/[,，;；]/).map((s) => s.trim()).filter((s) => s.length > 0);
          input.value = items.join(', ');
          ctx.onEdit(scope, def.key, items);
          return;
        }
        if (!text) {
          input.value = '';
          ctx.onEdit(scope, def.key, []);
          return;
        }
        const parsed = parseNumberList(text);
        if (parsed.error) {
          onError(`「${def.label || def.key}」中的 “${parsed.error}” 不是数字`);
          input.value = listText(raw);
          return;
        }
        input.value = parsed.values.join(', ');
        ctx.onEdit(scope, def.key, parsed.values);
      });
      return input;
    }

    if (type === 'number' || type === 'int') return numberControl(def, scope, raw, onError);

    const input = el('input', {
      id,
      class: 'input',
      type: 'text',
      value: raw === undefined || raw === null ? '' : String(raw),
      autocomplete: 'off',
    });
    input.addEventListener('input', () => ctx.onEdit(scope, def.key, input.value));
    return input;
  }

  /* ---------------- 一行参数 ---------------- */

  function fieldRow(def, scope, values, onError) {
    const key = `${scope}:${def.key}`;
    const control = fieldControl(def, scope, values, onError);
    const numeric = def.type === 'number' || def.type === 'int';
    const unit = numeric && def.unit ? el('span', { class: 'pfield-unit', text: def.unit }) : null;
    const active = dependencyOk(def, values);

    const helpId = `help-${scope}-${def.key}`;
    const helpOpen = Boolean(prefs.help && prefs.help[key]);
    const help = def.help
      ? el('p', { class: 'pfield-help', id: helpId, hidden: !helpOpen, text: def.help })
      : null;

    const depHint = !active && def.dependsOn
      ? el('span', {
        class: 'pfield-dep',
        text: `仅当「${labelOf(def.dependsOn.key)}」为 ${(def.dependsOn.values || []).join(' / ')} 时生效`,
      })
      : null;

    const labelChildren = [
      el('label', { class: 'pfield-label', for: `pf-${scope}-${def.key}`, text: def.label || def.key }),
      def.sweepable ? el('span', { class: 'pfield-tag', title: '可用于参数扫描' }, '扫') : null,
      def.optimizable ? el('span', {
        class: 'pfield-tag opt',
        title: '可加入自动优化',
        text: def.optimizeRank === 'recommended' ? '优' : '优·慎',
      }) : null,
      def.help
        ? el('button', {
          class: `pfield-help-btn${helpOpen ? ' on' : ''}`,
          type: 'button',
          title: def.help,
          'aria-label': `说明：${def.help}`,
          'aria-expanded': String(helpOpen),
          'aria-controls': helpId,
          text: '?',
          onclick: (event) => {
            event.preventDefault();
            const open = help.hidden;
            help.hidden = !open;
            event.currentTarget.classList.toggle('on', open);
            event.currentTarget.setAttribute('aria-expanded', String(open));
            prefs.help[key] = open;
            persistPrefs();
          },
        })
        : null,
    ];

    const hasSlider = def.slider === true && typeof def.min === 'number' && typeof def.max === 'number';
    const row = el(
      'div',
      {
        class: `pfield${hasSlider ? ' has-slider' : ''}${active ? '' : ' locked'}`,
        'data-key': key,
        'data-search': `${def.label || ''} ${def.key} ${def.help || ''}`.toLowerCase(),
      },
      el('div', { class: 'pfield-main' },
        el('div', { class: 'pfield-name' }, labelChildren, depHint),
        el('div', { class: 'pfield-ctl' }, control, unit)),
      help,
    );
    if (!active) {
      row.querySelectorAll('input, select, button.pfield-help-btn').forEach((node) => {
        if (node.classList.contains('pfield-help-btn')) return;
        node.disabled = true;
      });
    }
    fields.set(key, row);
    return row;
  }

  function labelOf(key) {
    const all = (ctx.getLabels && ctx.getLabels()) || {};
    return all[key] || key;
  }

  /* ---------------- 组内按角色分小节 ---------------- */

  function roleSection(role, defs, scopeOf, valuesOf) {
    if (!defs.length) return null;
    const meta = roles()[role] || { label: role, hint: '' };
    const collapsed = role === 'device' ? prefs.device[role] !== false : false;
    const body = el('div', { class: 'pgroup-role-body' });
    defs.forEach((def) => body.append(fieldRow(def, scopeOf(def), valuesOf(def), ctx.onError)));

    const head = el('button', {
      class: `prole-head${collapsed ? ' collapsed' : ''}`,
      type: 'button',
      'aria-expanded': String(!collapsed),
      onclick: () => {
        const next = body.hidden;
        body.hidden = next;
        head.classList.toggle('collapsed', next);
        head.setAttribute('aria-expanded', String(!next));
        prefs.device[role] = !next;
        persistPrefs();
      },
    },
    el('span', { class: `prole-dot ${role}`, 'aria-hidden': 'true' }),
    el('span', { class: 'prole-label', text: meta.label || role }),
    meta.hint ? el('span', { class: 'prole-hint', text: meta.hint }) : null,
    el('span', { class: 'prole-count', text: String(defs.length) }));

    body.hidden = collapsed;
    return el('div', { class: `prole prole-${role}` }, head, body);
  }

  /* ---------------- 分组 ---------------- */

  function groupSection(name, defs, scopeOf, valuesOf, extraTag) {
    if (!defs.length) return null;
    // 装置常量整组进自己的小节（含高级项）：换硬件才改，默认折叠，不和日常旋钮混排。
    // 其他角色的 advanced 才收到组末尾的「高级参数」里。
    const isDevice = (def) => (def.role || 'design') === 'device';
    const deviceDefs = defs.filter(isDevice);
    const others = defs.filter((def) => !isDevice(def));
    const advanced = others.filter((d) => d.advanced);
    const normal = others.filter((d) => !d.advanced);
    const body = el('div', { class: 'pgroup-body' });

    // 主区：按 role 分小节
    const buckets = new Map();
    for (const def of normal.concat(deviceDefs)) {
      const role = def.role || 'design';
      if (!buckets.has(role)) buckets.set(role, []);
      buckets.get(role).push(def);
    }
    const order = roleOrder();
    Array.from(buckets.keys())
      .sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .forEach((role) => body.append(roleSection(role, buckets.get(role), scopeOf, valuesOf)));

    if (advanced.length) {
      const advOpen = prefs.advanced[name] !== false;
      const advBody = el('div', { class: 'pgroup-advanced', hidden: !advOpen },
        advanced.map((def) => fieldRow(def, scopeOf(def), valuesOf(def), ctx.onError)));
      const advHead = el('button', {
        class: 'pfield-adv-toggle', type: 'button', 'aria-expanded': String(advOpen),
        onclick: (event) => {
          const open = advBody.hidden;
          advBody.hidden = !open;
          event.currentTarget.setAttribute('aria-expanded', String(open));
          event.currentTarget.querySelector('.adv-count').textContent = `高级参数（${advanced.length}）`;
          event.currentTarget.classList.toggle('open', open);
          prefs.advanced[name] = open;
          persistPrefs();
        },
      }, el('span', { class: 'adv-chev', 'aria-hidden': 'true' }),
      el('span', { class: 'adv-count', text: `高级参数（${advanced.length}）` }));
      advHead.classList.toggle('open', advOpen);
      body.append(advHead, advBody);
    }

    const collapsed = Boolean(prefs.collapsed[name]);
    const count = el('span', { class: 'pgroup-count', text: String(defs.length) });
    const head = el('button', {
      class: 'pgroup-head', type: 'button', 'aria-expanded': String(!collapsed),
      onclick: () => {
        const next = !body.hidden;
        body.hidden = next;
        section.classList.toggle('collapsed', next);
        head.setAttribute('aria-expanded', String(!next));
        prefs.collapsed[name] = next;
        persistPrefs();
      },
    }, el('span', { class: 'pgroup-chev', 'aria-hidden': 'true' }),
    el('span', { class: 'pgroup-title', text: name }),
    extraTag ? el('span', { class: 'pgroup-tag', text: extraTag }) : null,
    count);

    const section = el('section', { class: `pgroup${collapsed ? ' collapsed' : ''}`, 'data-group': name }, head, body);
    body.hidden = collapsed;
    return section;
  }

  /* ---------------- 配置体检 ---------------- */

  function healthCard() {
    const items = (ctx.getHealth && ctx.getHealth()) || [];
    const warns = items.filter((i) => i.level === 'warn');
    if (!warns.length) {
      const ok = items.find((i) => i.level === 'ok');
      return el('section', { class: 'card health-card ok' },
        el('div', { class: 'health-head' },
          el('span', { class: 'health-dot ok', 'aria-hidden': 'true' }),
          el('strong', { text: '参数体检通过' }),
          el('span', { class: 'health-sub', text: (ok && ok.detail) || '没有发现互相矛盾的设置。' })));
    }
    const rows = warns.slice(0, 3).map((item) => el('div', { class: 'health-item warn' },
      el('div', { class: 'health-item-head' },
        el('span', { class: 'health-dot warn', 'aria-hidden': 'true' }),
        el('strong', { text: item.title }),
        item.action
          ? el('button', {
            class: 'mini-btn health-fix', type: 'button', text: '修复',
            title: item.action.label || '应用建议',
            onclick: () => {
              if (item.action.preset) ctx.onPreset && ctx.onPreset(item.action.preset);
              else if (item.action.setting) ctx.onSet && ctx.onSet(item.action.setting.key, item.action.setting.value);
            },
          })
          : null),
      el('p', { class: 'health-detail clamp', title: item.detail, text: item.detail })));
    return el('section', { class: 'card health-card' },
      el('div', { class: 'health-head' },
        el('span', { class: 'health-dot warn', 'aria-hidden': 'true' }),
        el('strong', { text: `${warns.length} 项参数警告` })),
      el('div', { class: 'health-list' }, rows));
  }

  /* ---------------- 预设 ---------------- */

  function presetBar() {
    const presets = (ctx.getPresets && ctx.getPresets()) || [];
    if (!presets.length) return null;
    const chips = presets.map((preset) => el('button', {
      class: `preset-chip${preset.tone === 'accent' ? ' accent' : ''}`,
      type: 'button',
      title: preset.desc || '',
      onclick: () => ctx.onPreset && ctx.onPreset(preset.id),
    }, el('span', { class: 'preset-label', text: preset.label }),
    el('span', { class: 'preset-desc', text: preset.desc || '' })));
    const open = Boolean(prefs.presetOpen);
    const body = el('div', { class: 'preset-list', hidden: !open }, chips);
    return el('details', {
      class: 'card preset-card', open,
      ontoggle: (event) => {
        prefs.presetOpen = event.currentTarget.open;
        persistPrefs();
      },
    },
    el('summary', { class: 'preset-summary' },
      el('strong', { text: '预设构型' }),
      el('span', { class: 'health-sub', text: `普通状态别动；要重置时点这里（${presets.length}）` })),
    body);
  }

  /* ---------------- 设计包信息（压缩成两行） ---------------- */

  function packCard(pack) {
    if (!pack) {
      return el('section', { class: 'card pack-card' },
        el('h2', { class: 'pack-name', text: '没有可用设计包' }),
        el('p', { class: 'field-help', text: '检查 designs 目录后点顶部「重新扫描」。' }));
    }
    const ok = pack.ok !== false;
    const meta = el('dl', { class: 'pack-meta' },
      el('dt', { text: 'ID' }), el('dd', { class: 'mono', text: pack.id || '—' }),
      el('dt', { text: '版本' }), el('dd', { class: 'mono', text: pack.version || '—' }),
      el('dt', { text: '目标面' }), el('dd', { class: 'mono', text: pack.targetPlane || '—' }),
      el('dt', { text: '目录' }), el('dd', { class: 'mono path', title: pack.dir || '', text: pack.dir || '—' }));

    return el('section', { class: 'card pack-card' },
      el('div', { class: 'pack-head' },
        el('h2', { class: 'pack-name', text: pack.name || pack.id || '未命名设计包' }),
        el('span', { class: ok ? 'pill ok' : 'pill bad', text: ok ? '就绪' : '不可用' })),
      pack.description ? el('p', { class: 'pack-desc', text: pack.description }) : null,
      !ok && pack.error ? el('p', { class: 'pack-error mono', text: pack.error }) : null,
      el('details', { class: 'pack-more' }, el('summary', null, '包信息'), meta,
        pack.notes ? el('p', { class: 'field-help', text: pack.notes }) : null));
  }

  /* ---------------- 底部保存条 ---------------- */

  function buildBar() {
    countEl = el('p', { class: 'dirty-count', text: '0 项未保存' });
    const save = el('button', { class: 'btn primary sm', type: 'button', title: '提交改动到 POST /api/settings', text: '保存参数' });
    save.addEventListener('click', () => ctx.onSave());
    const reset = el('button', { class: 'btn ghost sm', type: 'button', title: '放弃未保存改动', text: '还原' });
    reset.addEventListener('click', () => ctx.onReset());
    bar = el('div', { class: 'side-actions', hidden: true }, countEl, el('div', { class: 'side-actions-row' }, save, reset));
    return bar;
  }

  /* ---------------- 搜索 ---------------- */

  function applyFilter() {
    const query = (searchInput && searchInput.value || '').trim().toLowerCase();
    const sections = Array.from(host.querySelectorAll('.pgroup'));
    let hits = 0;
    for (const section of sections) {
      const rows = Array.from(section.querySelectorAll('.pfield'));
      let visibleInGroup = 0;
      for (const row of rows) {
        const text = row.getAttribute('data-search') || '';
        const show = !query || text.indexOf(query) >= 0;
        row.hidden = !show;
        if (show) visibleInGroup += 1;
      }
      const show = visibleInGroup > 0 || !query;
      section.hidden = !show;
      if (query && show) {
        section.classList.remove('collapsed');
        const body = section.querySelector('.pgroup-body');
        if (body) body.hidden = false;
        const head = section.querySelector('.pgroup-head');
        if (head) head.setAttribute('aria-expanded', 'true');
        section.querySelectorAll('.prole').forEach((prole) => {
          prole.hidden = false;
          const rb = prole.querySelector('.pgroup-role-body');
          if (rb) rb.hidden = false;
          const rh = prole.querySelector('.prole-head');
          if (rh) rh.setAttribute('aria-expanded', 'true');
        });
      }
      hits += visibleInGroup;
    }
    if (emptyHint) emptyHint.hidden = !(query && hits === 0);
    return hits;
  }

  function buildToolbar() {
    searchInput = el('input', {
      class: 'panel-search', type: 'search', placeholder: '搜索参数…', 'aria-label': '搜索参数',
      autocomplete: 'off', spellcheck: 'false',
    });
    searchInput.addEventListener('input', () => applyFilter());
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        searchInput.value = '';
        applyFilter();
      }
    });
    const expand = el('button', {
      class: 'mini-btn', type: 'button', title: '展开全部分组', 'aria-label': '展开全部分组', text: '全展',
      onclick: () => {
        prefs.collapsed = {};
        prefs.device = {};
        persistPrefs();
        host.querySelectorAll('.pgroup').forEach((section) => {
          section.classList.remove('collapsed');
          const body = section.querySelector('.pgroup-body');
          if (body) body.hidden = false;
          const head = section.querySelector('.pgroup-head');
          if (head) head.setAttribute('aria-expanded', 'true');
        });
        host.querySelectorAll('.prole').forEach((prole) => {
          const body = prole.querySelector('.pgroup-role-body');
          if (body) body.hidden = false;
          const head = prole.querySelector('.prole-head');
          if (head) {
            head.classList.remove('collapsed');
            head.setAttribute('aria-expanded', 'true');
          }
        });
      },
    });
    const collapse = el('button', {
      class: 'mini-btn', type: 'button', title: '折叠全部分组', 'aria-label': '折叠全部分组', text: '全收',
      onclick: () => {
        host.querySelectorAll('.pgroup').forEach((section) => {
          const name = section.getAttribute('data-group');
          prefs.collapsed[name] = true;
          section.classList.add('collapsed');
          const body = section.querySelector('.pgroup-body');
          if (body) body.hidden = true;
          const head = section.querySelector('.pgroup-head');
          if (head) head.setAttribute('aria-expanded', 'false');
        });
        persistPrefs();
      },
    });
    return el('div', { class: 'panel-toolbar' }, el('div', { class: 'panel-search-wrap' }, searchInput), el('div', { class: 'panel-tool-actions' }, expand, collapse));
  }

  /* ---------------- 渲染 ---------------- */

  function render(model) {
    fields = new Map();
    host.replaceChildren();
    const schema = Array.isArray(model.schema) ? model.schema : [];
    const packParams = Array.isArray(model.packParams) ? model.packParams : [];
    const settings = model.settings || {};
    const packValues = model.packValues || {};

    const scroll = el('div', { class: 'side-scroll' },
      packCard(model.pack), healthCard(), presetBar(), buildToolbar());
    emptyHint = el('p', { class: 'panel-empty', hidden: true, text: '没有匹配的参数' });

    const buckets = new Map();
    for (const def of schema) {
      if (!def || !def.key) continue;
      const group = def.group || '其他参数';
      if (!buckets.has(group)) buckets.set(group, []);
      buckets.get(group).push(def);
    }
    const names = Array.from(buckets.keys()).sort((a, b) => groupIndex(a) - groupIndex(b));
    for (const name of names) {
      const defs = buckets.get(name);
      const isPackGroup = name === PACK_GROUP;
      const merged = isPackGroup ? defs.concat(packParams) : defs;
      const scopeOf = (def) => (isPackGroup && packParams.indexOf(def) >= 0 ? 'packValues' : 'settings');
      const section = groupSection(name, merged, scopeOf,
        (def) => (scopeOf(def) === 'packValues' ? packValues : settings),
        isPackGroup && packParams.length ? '设计包' : null);
      if (section) scroll.append(section);
    }
    if (packParams.length && !buckets.has(PACK_GROUP)) {
      scroll.append(groupSection(PACK_GROUP, packParams, () => 'packValues', () => packValues, '设计包'));
    }
    scroll.append(emptyHint);

    host.append(scroll, buildBar());
    refreshDirty();
    applyFilter();
  }

  function refreshDirty() {
    if (!bar) return;
    const count = ctx.getDirtyCount();
    const keys = ctx.getDirtyKeys ? ctx.getDirtyKeys() : new Set();
    bar.hidden = count === 0;
    if (countEl) countEl.textContent = `${count} 项未保存`;
    for (const [key, row] of fields) {
      row.classList.toggle('dirty', keys.has(key));
    }
  }

  function highlight(key) {
    const row = fields.get(`settings:${key}`) || fields.get(`packValues:${key}`);
    if (!row) return;
    const section = row.closest('.pgroup');
    if (section && section.classList.contains('collapsed')) {
      const name = section.getAttribute('data-group');
      delete prefs.collapsed[name];
      persistPrefs();
      section.classList.remove('collapsed');
      const body = section.querySelector('.pgroup-body');
      if (body) body.hidden = false;
    }
    const prole = row.closest('.prole');
    if (prole) {
      const body = prole.querySelector('.pgroup-role-body');
      if (body && body.hidden) {
        body.hidden = false;
        const head = prole.querySelector('.prole-head');
        if (head) head.classList.remove('collapsed');
      }
    }
    row.classList.add('flash');
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.setTimeout(() => row.classList.remove('flash'), 1600);
  }

  /** 只换体检卡，不重建整个面板（避免输入焦点丢失）。 */
  function refreshHealth(items) {
    const old = host.querySelector('.health-card');
    if (!old) return;
    const fresh = healthCard();
    if (fresh) old.replaceWith(fresh);
  }

  return { render, refreshDirty, highlight, refreshHealth };
}
