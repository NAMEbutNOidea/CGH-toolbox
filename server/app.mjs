import { createReadStream, existsSync, readFileSync, statSync, accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function createApp({ projectDir, engine, port, log = console.log }) {
  const webDir = path.join(projectDir, "web");
  const outputDir = path.join(projectDir, "output");
  const paramsDir = path.join(projectDir, "params");
  const designsDir = path.join(projectDir, "designs");
  const promptPath = path.join(projectDir, "prompts", "design-pack-prompt.md");

  const jobs = new Map();
  let jobSeq = 0;
  let chain = Promise.resolve();
  let currentJob = null;

  function enqueue(kind, cmd, payload) {
    const id = `j${++jobSeq}`;
    const job = {
      jobId: id,
      kind,
      status: "queued",
      progress: 0,
      message: "排队中",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      result: null,
      sweep: null,
      optimize: null,
      error: null,
    };
    jobs.set(id, job);
    // 只保留最近 24 个作业
    if (jobs.size > 24) {
      for (const [key, value] of jobs) {
        if (value.status === "done" || value.status === "error" || value.status === "cancelled") {
          jobs.delete(key);
          break;
        }
      }
    }
    chain = chain.then(async () => {
      if (job.status === "cancelled") return;
      job.status = "running";
      job.startedAt = new Date().toISOString();
      currentJob = job;
      try {
        const data = await engine.request(cmd, payload, {
          onProgress: (progress, message) => {
            job.progress = progress;
            job.message = message;
          },
        });
        if (kind === "sweep") job.sweep = data;
        else if (kind === "optimize") job.optimize = data;
        else job.result = data;
        job.status = "done";
        job.progress = 1;
        job.message = "完成";
      } catch (error) {
        job.status = /取消|cancel/i.test(error.message || "") ? "cancelled" : "error";
        job.error = { message: error.message || "计算失败", detail: error.detail || "" };
        job.message = job.status === "cancelled" ? "已取消" : "失败";
      } finally {
        job.finishedAt = new Date().toISOString();
        currentJob = null;
      }
    });
    return job;
  }

  // -------------------------------------------------------------------------
  // 环境自检
  // -------------------------------------------------------------------------
  function nodeChecks() {
    const checks = [];
    const major = Number(process.versions.node.split(".")[0]);
    checks.push({
      id: "node",
      label: "Node.js 运行时",
      status: major >= 18 ? "pass" : "fail",
      detail: `v${process.versions.node}`,
      fix:
        major >= 18
          ? null
          : {
              title: "升级 Node.js",
              steps: ["到 nodejs.org 下载 20 LTS 或更新版本", "安装后在新的终端窗口重新双击 启动后端.bat"],
              command: null,
            },
    });

    if (!existsSync(webDir)) {
      checks.push({
        id: "web",
        label: "前端文件",
        status: "fail",
        detail: `缺少目录 ${webDir}`,
        fix: { title: "恢复 web 目录", steps: ["确认仓库完整（git status / git checkout web）"], command: null },
      });
    } else {
      checks.push({ id: "web", label: "前端文件", status: "pass", detail: webDir, fix: null });
    }

    for (const [id, label, dir] of [
      ["output_dir", "输出目录可写", outputDir],
      ["params_dir", "参数文件可写", paramsDir],
      ["designs_dir", "设计包目录", designsDir],
    ]) {
      try {
        mkdirSync(dir, { recursive: true });
        if (id !== "designs_dir") {
          // 只写不删：验证可写即可，避免在目录里制造/删除临时文件
          writeFileSync(path.join(dir, ".cgh_write_probe"), `ok ${process.pid}`);
          checks.push({ id, label, status: "pass", detail: dir, fix: null });
        } else {
          accessSync(dir, constants.R_OK);
          checks.push({ id, label, status: "pass", detail: dir, fix: null });
        }
      } catch (error) {
        checks.push({
          id,
          label,
          status: "fail",
          detail: `${dir} 不可用：${error.message}`,
          fix: {
            title: "修复目录权限",
            steps: [
              "确认项目没有放在只读位置或受同步软件保护的目录",
              "以普通用户身份在项目根目录手动新建同名目录后重试",
            ],
            command: null,
          },
        });
      }
    }

    const promptFiles = ["matlab-to-pack-prompt.md", "design-pack-prompt.md"];
    const promptDir = path.join(projectDir, "prompts");
    const missingPrompts = promptFiles.filter((file) => !existsSync(path.join(promptDir, file)));
    if (missingPrompts.length === 0) {
      checks.push({
        id: "prompt",
        label: "整理提示词",
        status: "pass",
        detail: `prompts/ 下 ${promptFiles.length} 份模板齐全`,
        fix: null,
      });
    } else {
      checks.push({
        id: "prompt",
        label: "整理提示词",
        status: "warn",
        detail: `缺少 ${missingPrompts.join("、")}，网页里对应的提示词会为空`,
        fix: {
          title: "恢复提示词模板",
          steps: [`从仓库恢复 prompts/${missingPrompts[0]}`, "恢复后点「重新自检」"],
          command: null,
        },
      });
    }
    return checks;
  }

  function pythonFix() {
    return {
      title: "让网页找到带 numpy/scipy 的 Python",
      steps: [
        "在项目根目录新建文本文件 .cgh-python.txt，第一行写解释器的绝对路径",
        "例如：C:\\Users\\你的用户名\\.conda\\envs\\NAMEbutNOidea\\python.exe",
        "保存后重新双击 启动后端.bat；也可以设置环境变量 CGH_PYTHON 指向同一路径",
        "缺少 numpy/scipy 时，在 Anaconda Prompt 里执行下面这条命令安装",
      ],
      command: "pip install numpy scipy",
    };
  }

  async function envReport() {
    const checks = nodeChecks();
    const interpreter = {
      path: engine.pythonPath,
      ready: engine.ready,
      lastError: engine.lastError,
    };
    checks.push({
      id: "python_bin",
      label: "Python 可执行文件",
      status: engine.pythonPath ? "pass" : "fail",
      detail: engine.pythonPath || "未找到",
      fix: engine.pythonPath ? null : pythonFix(),
    });

    try {
      const py = await engine.request("env");
      for (const item of py.checks || []) checks.push(item);
      interpreter.version = py.python?.version || "";
    } catch (error) {
      checks.push({
        id: "engine",
        label: "计算引擎",
        status: "fail",
        detail: `无法启动引擎：${error.message}`,
        fix: {
          title: "手动确认引擎可用",
          steps: [
            "打开终端，执行下面这条命令，应能看到 [worker] python … 与 ready",
            "若报 ModuleNotFoundError，按提示安装缺失包",
          ],
          command: `"${engine.pythonPath || "python"}" -u engine/worker.py`,
        },
      });
    }

    const summary = { pass: 0, warn: 0, fail: 0 };
    const merged = [];
    const seen = new Set();
    for (const item of checks) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
      if (item.status === "pass") summary.pass++;
      else if (item.status === "warn") summary.warn++;
      else summary.fail++;
    }
    return {
      ok: summary.fail === 0,
      canRun: summary.fail === 0,
      checks: merged,
      summary,
      python: interpreter,
      node: { version: process.versions.node, platform: process.platform },
      port,
      paths: { projectDir, webDir, outputDir, paramsDir, designsDir, promptPath },
    };
  }

  // -------------------------------------------------------------------------
  // HTTP 工具
  // -------------------------------------------------------------------------
  function sendJson(res, status, payload, req) {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const accept = String(req.headers["accept-encoding"] || "");
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    };
    if (body.length > 1024 && accept.includes("gzip")) {
      const zipped = gzipSync(body, { level: 6 });
      headers["content-encoding"] = "gzip";
      headers["content-length"] = zipped.length;
      res.writeHead(status, headers);
      res.end(zipped);
      return;
    }
    headers["content-length"] = body.length;
    res.writeHead(status, headers);
    res.end(body);
  }

  function sendFile(req, res, filePath) {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      sendJson(res, 404, { ok: false, error: "文件不存在" }, req);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const stat = statSync(filePath);
    const noCache = [".html", ".js", ".mjs", ".css"].includes(ext);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": stat.size,
      "cache-control": noCache ? "no-store" : "max-age=60",
      "content-disposition": "inline",
    });
    createReadStream(filePath).pipe(res);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 64 * 1024 * 1024) {
          reject(new Error("请求体过大"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`请求体不是合法 JSON：${error.message}`));
        }
      });
      req.on("error", reject);
    });
  }

  function safeJoin(root, relative) {
    const target = path.resolve(root, "." + path.sep + relative);
    if (!target.startsWith(path.resolve(root))) return null;
    return target;
  }

  // -------------------------------------------------------------------------
  // 路由
  // -------------------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (pathname === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          version: "0.1.0",
          python: { ready: engine.ready, path: engine.pythonPath, version: "", note: engine.lastError },
          engine: { workers: 1, busy: Boolean(currentJob) },
          packsDir: designsDir,
          promptPath,
        }, req);
      }

      if (pathname === "/api/env") {
        return sendJson(res, 200, await envReport(), req);
      }

      if (pathname === "/api/state" && req.method === "GET") {
        const state = await engine.request("state");
        return sendJson(res, 200, { ok: true, ...state }, req);
      }

      if (pathname === "/api/settings" && req.method === "POST") {
        const body = await readBody(req);
        const data = await engine.request("save_settings", body);
        return sendJson(res, 200, { ok: true, ...data, clamped: data.warnings || [] }, req);
      }

      if (pathname === "/api/healthcheck" && req.method === "POST") {
        const body = await readBody(req);
        const data = await engine.request("health", body);
        return sendJson(res, 200, { ok: true, ...data }, req);
      }

      if (pathname === "/api/packs/reload" && req.method === "POST") {
        const data = await engine.request("reload_packs");
        return sendJson(res, 200, { ok: true, ...data }, req);
      }

      if (pathname === "/api/run" && req.method === "POST") {
        const body = await readBody(req);
        const job = enqueue("run", "run", body);
        return sendJson(res, 200, { ok: true, jobId: job.jobId }, req);
      }

      if (pathname === "/api/sweep" && req.method === "POST") {
        const body = await readBody(req);
        const job = enqueue("sweep", "sweep", body);
        return sendJson(res, 200, { ok: true, jobId: job.jobId }, req);
      }

      if (pathname === "/api/optimize" && req.method === "POST") {
        const body = await readBody(req);
        const job = enqueue("optimize", "optimize", body);
        return sendJson(res, 200, { ok: true, jobId: job.jobId }, req);
      }

      const jobMatch = pathname.match(/^\/api\/job\/([A-Za-z0-9]+)(\/cancel)?$/);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return sendJson(res, 404, { ok: false, error: "作业不存在或已过期" }, req);
        if (jobMatch[2]) {
          if (job.status === "queued" || job.status === "running") {
            job.status = "cancelled";
            job.message = "正在取消";
            try {
              await engine.request("cancel");
            } catch {}
          }
          return sendJson(res, 200, { ok: true }, req);
        }
        return sendJson(res, 200, { ok: true, ...job }, req);
      }

      if (pathname === "/api/prompt") {
        const kind = url.searchParams.get("kind") || "matlab";
        const data = await engine.request("prompt", { kind });
        return sendJson(res, 200, { ok: true, ...data }, req);
      }

      if (pathname === "/api/outputs") {
        const limit = Number(url.searchParams.get("limit") || 20);
        const data = await engine.request("outputs", { limit });
        return sendJson(res, 200, { ok: true, ...data }, req);
      }

      if (pathname.startsWith("/files/")) {
        const target = safeJoin(outputDir, pathname.slice("/files/".length));
        if (!target) return sendJson(res, 400, { ok: false, error: "非法路径" }, req);
        return sendFile(req, res, target);
      }

      if (pathname.startsWith("/api/")) {
        return sendJson(res, 404, { ok: false, error: `未知接口 ${pathname}` }, req);
      }

      // 静态站点
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const target = safeJoin(webDir, relative);
      if (!target) return sendJson(res, 400, { ok: false, error: "非法路径" }, req);
      if (!existsSync(target)) {
        // 未知路径回落到首页，便于单页应用
        return sendFile(req, res, path.join(webDir, "index.html"));
      }
      return sendFile(req, res, target);
    } catch (error) {
      log(`[http] ${req.method} ${pathname} → ${error.message}`);
      return sendJson(res, 500, { ok: false, error: error.message }, req);
    }
  });

  return { server, envReport, jobs };
}
