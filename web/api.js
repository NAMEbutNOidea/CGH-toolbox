/**
 * 后端 HTTP 封装 + 任务轮询。
 * 接口契约唯一权威：docs/API.md
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export class ApiError extends Error {
  constructor(message, detail, status) {
    super(message);
    this.name = 'ApiError';
    this.detail = detail || '';
    this.status = status || 0;
  }
}

async function readBody(res) {
  let text = '';
  try {
    text = await res.text();
  } catch (err) {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

async function request(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError('无法连接到本地后端（http://127.0.0.1:3100）', String((err && err.message) || err), 0);
  }
  const data = await readBody(res);
  if (!res.ok || !data || data.ok === false) {
    const msg = (data && typeof data.error === 'string' && data.error) || `请求失败：HTTP ${res.status}`;
    throw new ApiError(msg, (data && data.detail) || '', res.status);
  }
  return data;
}

function get(path) {
  return request(path, { method: 'GET', headers: { Accept: 'application/json' } });
}

function post(path, body) {
  return request(path, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body || {}),
  });
}

export const api = {
  health: () => get('/api/health'),
  env: () => get('/api/env'),
  state: () => get('/api/state'),
  saveSettings: (payload) => post('/api/settings', payload),
  healthcheck: (payload) => post('/api/healthcheck', payload),
  reloadPacks: () => post('/api/packs/reload', {}),
  run: (payload) => post('/api/run', payload),
  sweep: (payload) => post('/api/sweep', payload),
  optimize: (payload) => post('/api/optimize', payload),
  job: (jobId) => get(`/api/job/${encodeURIComponent(jobId)}`),
  cancel: (jobId) => post(`/api/job/${encodeURIComponent(jobId)}/cancel`, {}),
  prompt: (kind) => get(`/api/prompt${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),
};

const TERMINAL = new Set(['done', 'error', 'cancelled']);

/**
 * 每 500ms 轮询一次 /api/job/{id}。网络错误最多容忍 6 次。
 * @returns {{stop: () => void}}
 */
export function pollJob(jobId, handlers) {
  const opts = handlers || {};
  let stopped = false;
  let timer = 0;
  let failures = 0;

  const finish = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = 0;
  };

  const tick = async () => {
    timer = 0;
    if (stopped) return;
    let job;
    try {
      job = await api.job(jobId);
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= 6) {
        finish();
        if (opts.onError) {
          opts.onError({ error: { message: err.message, detail: err.detail || '' } });
        }
        return;
      }
      timer = setTimeout(tick, 500);
      return;
    }
    if (stopped) return;
    if (opts.onUpdate) opts.onUpdate(job);
    if (TERMINAL.has(job.status)) {
      finish();
      if (job.status === 'done' && opts.onDone) opts.onDone(job);
      else if (job.status === 'error' && opts.onError) opts.onError(job);
      else if (job.status === 'cancelled' && opts.onCancelled) opts.onCancelled(job);
      return;
    }
    timer = setTimeout(tick, 500);
  };

  timer = setTimeout(tick, 120);

  return {
    stop() {
      finish();
    },
    get stopped() {
      return stopped;
    },
  };
}
