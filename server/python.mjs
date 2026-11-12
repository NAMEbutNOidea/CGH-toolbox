import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

/**
 * Python 计算引擎的托管进程。
 * 与 engine/worker.py 之间的协议见该文件顶部说明（JSON Lines）。
 */
export class PythonEngine {
  constructor({ pythonPath, projectDir, log = console.log }) {
    this.pythonPath = pythonPath;
    this.projectDir = projectDir;
    this.log = log;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.lastError = "";
    this.starting = null;
  }

  async start() {
    if (this.ready) return true;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve) => {
      if (!this.pythonPath) {
        this.lastError = "未找到可用的 Python 解释器";
        this.starting = null;
        resolve(false);
        return;
      }
      const workerPath = path.join(this.projectDir, "engine", "worker.py");
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        this.starting = null;
        resolve(ok);
      };

      this.child = spawn(this.pythonPath, ["-u", workerPath], {
        cwd: this.projectDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        windowsHide: true,
      });

      this.child.on("error", (error) => {
        this.lastError = `启动 Python 失败：${error.message}`;
        this.log(`[python] ${this.lastError}`);
        finish(false);
      });

      this.child.on("exit", (code) => {
        this.ready = false;
        const detail = `Python 工作进程退出（code ${code}）`;
        this.lastError = detail;
        for (const [, entry] of this.pending) entry.reject(new Error(detail));
        this.pending.clear();
        this.log(`[python] ${detail}`);
        finish(false);
      });

      const out = createInterface({ input: this.child.stdout });
      out.on("line", (line) => this._onLine(line, finish));

      const err = createInterface({ input: this.child.stderr });
      err.on("line", (line) => {
        this.log(`[engine] ${line}`);
        if (/Traceback|Error|错误/.test(line)) this.lastError = line.slice(0, 300);
      });

      setTimeout(() => {
        if (!this.ready) {
          this.lastError = this.lastError || "Python 工作进程启动超时（10 秒内未就绪）";
          finish(false);
        }
      }, 10000);
    });
    return this.starting;
  }

  _onLine(line, finishStart) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`[engine] ${line}`);
      return;
    }
    if (msg.event === "ready") {
      this.ready = true;
      this.lastError = "";
      this.log("[python] 引擎就绪");
      finishStart(true);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.event === "progress") {
      entry.onProgress?.(msg.progress ?? 0, msg.message ?? "");
      return;
    }
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.data);
    else {
      const error = new Error(msg.error || "计算失败");
      error.detail = msg.detail || "";
      entry.reject(error);
    }
  }

  async request(cmd, payload = {}, { onProgress } = {}) {
    if (!this.ready) {
      const ok = await this.start();
      if (!ok) throw new Error(this.lastError || "Python 引擎未就绪");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, cmd, payload })}\n`);
      } catch (error) {
        this.pending.delete(id);
        reject(new Error(`与 Python 引擎通信失败：${error.message}`));
      }
    });
  }

  stop() {
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.stdin.end();
      } catch {}
      try {
        this.child.kill();
      } catch {}
    }
    this.child = null;
    this.ready = false;
  }
}

const INTERPRETER_NAMES =
  process.platform === "win32" ? ["python.exe", "python3.exe", "python"] : ["python3", "python"];

/** 依次探测：显式指定 → 环境变量 → conda 环境变量 → .cgh-python.txt → ~/.conda/envs/* → PATH。 */
export function findPython({ projectDir, override }) {
  const tried = [];
  const candidates = [];
  if (override) candidates.push(override);
  if (process.env.CGH_PYTHON) candidates.push(process.env.CGH_PYTHON);
  if (process.env.CONDA_PREFIX) {
    candidates.push(path.join(process.env.CONDA_PREFIX, process.platform === "win32" ? "python.exe" : "bin/python"));
  }
  const hintFile = path.join(projectDir, ".cgh-python.txt");
  if (existsSync(hintFile)) {
    try {
      const line = readFileSync(hintFile, "utf8").split(/\r?\n/)[0].trim();
      if (line) candidates.push(line);
    } catch {}
  }
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) {
    const envRoot = path.join(home, ".conda", "envs");
    if (existsSync(envRoot)) {
      try {
        for (const name of readdirSync(envRoot)) {
          candidates.push(path.join(envRoot, name, process.platform === "win32" ? "python.exe" : "bin/python"));
        }
      } catch {}
    }
  }
  for (const name of INTERPRETER_NAMES) candidates.push(name);

  for (const candidate of candidates) {
    if (!candidate) continue;
    tried.push(candidate);
    const probe = spawnSync(candidate, ["-c", "import sys,numpy,scipy;print(sys.version.split()[0])"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
    });
    if (probe.status === 0) {
      return { path: candidate, version: (probe.stdout || "").trim().split("\n").pop(), tried, ok: true };
    }
  }
  return { path: "", version: "", tried, ok: false };
}
