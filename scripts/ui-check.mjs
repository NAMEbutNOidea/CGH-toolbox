/**
 * 无头浏览器端到端自检（开发用，不参与运行）。
 *
 *   node scripts/ui-check.mjs                    # 打开首页、截图、截图环境自检
 *   node scripts/ui-check.mjs --run              # 额外点一次「开始计算」并截图结果
 *
 * 依赖：本机有 Chrome（默认路径见下）；用 CDP 驱动，不装任何 npm 包。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const URL_ = process.env.CGH_URL || "http://127.0.0.1:3100/";
const OUT = path.join(process.cwd(), ".ui-check");
const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error("找不到 Chrome/Edge，跳过 UI 自检");
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const port = 9333;
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--window-size=1500,1100",
  `--remote-debugging-port=${port}`,
  "--user-data-dir=" + path.join(OUT, "_profile"),
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error("无法连接 Chrome 调试端口");
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const waiting = new Map();
const events = [];

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    events.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description).join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    events.push("exception: " + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
});

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise((resolve) => ws.addEventListener("open", resolve));
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function shoot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log("截图 →", file);
}

await send("Page.navigate", { url: URL_ });
await sleep(4000);
await shoot("01-home");
console.log("面板分组:", await evaluate(
  "Array.from(document.querySelectorAll('#side-body .pgroup')).map(g=>g.getAttribute('data-group')+'('+g.querySelectorAll('.pfield').length+')').join(' | ')"));
console.log("滑块数:", await evaluate("document.querySelectorAll('#side-body .ctl-slider .range').length"));
for (const [i, y] of [[1, 420], [2, 900]]) {
  await evaluate(`document.querySelector('#side-body .side-scroll').scrollTop = ${y}`);
  await sleep(250);
  await shoot(`01-panel-${i}`);
}

const envOk = await evaluate("Boolean(document.querySelector('#badge-python'))");
console.log("环境徽标存在:", envOk);
console.log("徽标文字:", await evaluate("document.querySelector('#badge-python').textContent.trim()"));

// 打开环境自检
await evaluate("document.querySelector('#btn-env').click()");
await sleep(2500);
await shoot("02-env");
console.log("自检项数:", await evaluate("document.querySelectorAll('#env-list .env-item').length"));

await evaluate("document.querySelector('#env-close-btn').click()");
await sleep(300);

// 扫描页
await evaluate("document.querySelector('#tab-sweep').click()");
await sleep(700);
await shoot("03-sweep-tab");
console.log("扫描参数项:", await evaluate("document.querySelectorAll('#axis-list .axis, #axis-list li, #axis-list label').length"));

// 提示词弹窗
await evaluate("document.querySelector('#tab-sim').click()");
await evaluate("document.querySelector('#btn-prompt').click()");
await sleep(1500);
await shoot("04-prompt");
console.log("提示词长度:", await evaluate("(document.querySelector('#modal-body').textContent||'').length"));
console.log("模板切换项:", await evaluate(
  "Array.from(document.querySelectorAll('#prompt-tabs .prompt-tab')).map(b=>b.textContent+(b.classList.contains('active')?'*':'')).join(' | ')"));

// 滚到表格区，确认 markdown 表格渲染
await evaluate("document.querySelector('#modal .modal-body').scrollTop = 640");
await sleep(400);
await shoot("04c-prompt-table");
console.log("表格数:", await evaluate("document.querySelectorAll('#modal-body .prompt-table').length"),
  "| 首行表头:", await evaluate(
    "(Array.from(document.querySelectorAll('#modal-body .prompt-table th')).slice(0,2).map(t=>t.textContent).join(' / '))"));
await evaluate("document.querySelector('#modal .modal-body').scrollTop = 0");

// 切到「通用」模板，确认内容真的变了
const beforeTab = await evaluate("document.querySelector('#modal-body').textContent.slice(0,40)");
await evaluate(
  "Array.from(document.querySelectorAll('#prompt-tabs .prompt-tab')).find(b=>!b.classList.contains('active')).click()");
await sleep(1200);
const afterTab = await evaluate("document.querySelector('#modal-body').textContent.slice(0,40)");
await shoot("04b-prompt-generic");
console.log("切换后内容变化:", beforeTab !== afterTab, "|", afterTab.replace(/\s+/g, " "));
await evaluate("document.querySelector('#modal-close').click()");
await sleep(300);

if (process.argv.includes("--run")) {
  await evaluate("document.querySelector('#btn-run').click()");
  for (let i = 0; i < 75; i++) {
    await sleep(2000);
    const state = await evaluate(`(() => {
      const res = document.querySelector('#sim-results');
      const empty = document.querySelector('#sim-empty');
      const btn = document.querySelector('#btn-run');
      return {
        done: res && !res.hidden && document.querySelectorAll('#image-grid canvas').length > 0,
        busy: btn ? btn.disabled : true,
        emptyHidden: empty ? empty.hidden : null,
        cards: document.querySelectorAll('#image-grid canvas').length,
      };
    })()`);
    process.stdout.write(`  ui: cards=${state.cards} busy=${state.busy}\n`);
    if (state.done) break;
    if (!state.busy && state.cards === 0 && i > 3) break;
  }
  await sleep(800);
  await shoot("05-result");
  console.log("图像卡片数:", await evaluate("document.querySelectorAll('#image-grid canvas').length"));
  console.log("大数值卡片:", await evaluate("document.querySelectorAll('.bigcards .bigcard, .bigcards > *').length"));
  console.log("指标表行数:", await evaluate("document.querySelectorAll('#metrics-table tr').length"));
  console.log("总览窗口框:", await evaluate(
    "document.querySelectorAll('#image-grid .img-box').length"),
    "|", await evaluate(
    "Array.from(document.querySelectorAll('#image-grid .img-box-tag')).map(t=>t.textContent).join(',')"));
  console.log("诊断摘要:", await evaluate("document.querySelector('#diag-summary').textContent"));
  console.log("诊断条目:", await evaluate(
    "Array.from(document.querySelectorAll('#diag-body .diag-item')).map(li=>li.className.replace('diag-item ','')+':'+li.querySelector('strong').textContent).join(' | ')"));

  // 诊断建议按钮：只回填草稿
  const beforeWaist = await evaluate("document.querySelector('#pf-settings-input_waist_mm').value");
  await evaluate("(() => { const b = document.querySelector('#diag-body .diag-action'); if (b) b.click(); })()");
  await sleep(400);
  const afterWaist = await evaluate("document.querySelector('#pf-settings-input_waist_mm').value");
  console.log("诊断建议回填:", beforeWaist, "->", afterWaist,
    "| 已标记未保存:", await evaluate("Boolean(document.querySelector('.dirty, [data-dirty=\"1\"], #btn-save:not([disabled])'))"));

  // 滚到图像区，单独看窗口框
  await evaluate("document.querySelector('#image-grid').scrollIntoView({block:'start'}); window.scrollBy(0,-70)");
  await sleep(500);
  await shoot("05b-grid");

  // 点击近场总览 → 放大视图
  await evaluate("document.querySelectorAll('#image-grid .img-canvas-wrap')[0].click()");
  await sleep(700);
  await shoot("06-zoom");
  console.log("放大视图已开:", await evaluate("!document.querySelector('.zoom-modal').hidden"),
    "| 标注框:", await evaluate("document.querySelectorAll('.zoom-modal .img-box, .zoom-modal .zoom-chip').length"),
    "|", await evaluate("document.querySelector('#zoom-pct').textContent"));
  // 滚轮以 +1 为中心放大
  await evaluate(`(() => {
    const c = document.querySelector('#zoom-canvas');
    const r = c.getBoundingClientRect();
    for (let i = 0; i < 8; i++) {
      c.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, clientX: r.left + r.width * 0.62,
        clientY: r.top + r.height * 0.5, bubbles: true, cancelable: true }));
    }
  })()`);
  await sleep(400);
  await shoot("07-zoom-in");
  console.log("缩放后:", await evaluate("document.querySelector('#zoom-pct').textContent"),
    "| 读数:", await evaluate("document.querySelector('#zoom-readout').textContent"));
  // 拖拽平移
  await evaluate(`(() => {
    const c = document.querySelector('#zoom-canvas');
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: r.left + 400, clientY: r.top + 200, bubbles: true }));
    c.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: r.left + 250, clientY: r.top + 200, bubbles: true }));
    c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: r.left + 250, clientY: r.top + 200, bubbles: true }));
  })()`);
  await sleep(300);
  await shoot("08-zoom-pan");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await sleep(300);
  console.log("Esc 关闭:", await evaluate("document.querySelector('.zoom-modal').hidden"));
}

if (process.argv.includes("--optimize")) {
  await evaluate("document.querySelector('#tab-optimize').click()");
  await sleep(500);
  await shoot("09-opt-list");
  console.log("可优化参数行:", await evaluate("document.querySelectorAll('#opt-var-list .opt-var').length"),
    "| 默认勾选:", await evaluate(
      "Array.from(document.querySelectorAll('#opt-var-list .opt-var')).filter(a=>a.classList.contains('active')).map(a=>a.getAttribute('data-key')).join(',')"));
  console.log("排除项:", await evaluate("document.querySelectorAll('#opt-excluded-list li').length"),
    "| 估算:", await evaluate("document.querySelector('#opt-estimate').textContent"));
  await evaluate("document.querySelector('#opt-budget').value = '24'");
  await evaluate("document.querySelector('#btn-optimize').click()");
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const st = await evaluate(`(() => {
      const card = document.querySelector('#opt-result-card');
      const btn = document.querySelector('#btn-optimize');
      return { done: card && !card.hidden, busy: btn ? btn.disabled : true,
               text: document.querySelector('#opt-progress-text') ? document.querySelector('#opt-progress-text').textContent : '' };
    })()`);
    process.stdout.write(`  opt: ${st.text}\n`);
    if (st.done) break;
    if (!st.busy && i > 2) break;
  }
  await sleep(700);
  await shoot("10-opt-result");
  console.log("结果摘要:", await evaluate("document.querySelector('#opt-summary').textContent"));
  console.log("最优表行:", await evaluate("document.querySelectorAll('#opt-best-table tbody tr').length"),
    "| 变动行:", await evaluate("document.querySelectorAll('#opt-best-table tbody tr.changed').length"));
  console.log("评估点数:", await evaluate("document.querySelectorAll('#opt-chart .opt-dot').length"),
    "| 折线:", await evaluate("Boolean(document.querySelector('#opt-chart .opt-line'))"));
  console.log("历史行:", await evaluate("document.querySelectorAll('#opt-table tbody tr').length"),
    "|", await evaluate("document.querySelector('#opt-history-summary').textContent"));
  console.log("边界提示:", await evaluate(
    "(() => { const n = document.querySelector('#opt-bounds'); return n && !n.hidden ? n.textContent : '(无)'; })()"));
  // 应用最优参数 → 只回填草稿
  await evaluate("document.querySelector('#btn-opt-apply').click()");
  await sleep(500);
  console.log("应用后未保存提示:", await evaluate(
    "(document.querySelector('.side-actions') || {}).textContent || ''"));
}

if (events.length) {
  console.log("---- 页面事件 ----");
  events.slice(0, 40).forEach((e) => console.log(" ", e));
} else {
  console.log("页面无 console 报错 / 异常");
}

ws.close();
chrome.kill();
process.exit(0);
