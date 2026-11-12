import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./server/app.mjs";
import { PythonEngine, findPython } from "./server/python.mjs";

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CGH_PORT || 3100);
const URL_ = `http://127.0.0.1:${PORT}`;
const isWindows = process.platform === "win32";

function banner(lines) {
  const width = 62;
  console.log("=".repeat(width));
  for (const line of lines) console.log(line);
  console.log("=".repeat(width));
}

function fail(message, hints) {
  console.error(`\n[启动失败] ${message}\n`);
  for (const hint of hints || []) console.error(`  · ${hint}`);
  console.error("");
}

// ---------------------------------------------------------------------------
// 1. 找到 Python
// ---------------------------------------------------------------------------
const override = process.argv[2];
let found = findPython({ projectDir, override });

if (!found.ok) {
  banner(["CGH 工具箱 · 启动器", "未找到可用的 Python 解释器"]);
  fail("需要带 numpy 与 scipy 的 Python 3.9+", [
    "在项目根目录新建 .cgh-python.txt，第一行写解释器绝对路径",
    "例如 D:\\miniconda3\\envs\\myenv\\python.exe",
    `已尝试：${found.tried.slice(0, 6).join("、")}`,
    "也可以在启动时传参：启动后端.bat \"C:\\path\\to\\python.exe\"",
  ]);
  process.exit(1);
}

console.log(`[python] ${found.path}  (Python ${found.version || "?"})`);

// ---------------------------------------------------------------------------
// 2. 启引擎 + HTTP
// ---------------------------------------------------------------------------
const engine = new PythonEngine({
  pythonPath: found.path,
  projectDir,
  log: (line) => console.log(line),
});

const { server, envReport } = createApp({ projectDir, engine, port: PORT, log: (l) => console.log(l) });

await engine.start();
if (!engine.ready) {
  banner(["CGH 工具箱 · 启动器", `引擎启动失败：${engine.lastError}`]);
  fail("Python 引擎没有就绪", [
    "直接运行下面这条命令可以看到完整报错：",
    `  "${found.path}" -u engine/worker.py`,
    "常见原因：缺少 numpy/scipy（pip install numpy scipy）、Python 版本过低",
  ]);
  process.exit(1);
}

server.listen(PORT, "127.0.0.1", () => {
  banner([
    "CGH 工具箱 · 本地服务已启动",
    `网页地址：${URL_}`,
    `输出目录：${path.join(projectDir, "output")}`,
    "退出：在下方输入 q 后回车",
  ]);
  if (!process.env.CGH_NO_OPEN && isWindows) {
    try {
      spawn("cmd", ["/c", "start", "", URL_], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } catch {}
  }
  // 启动即做一次环境自检，把问题直接打在窗口里（网页里也能看到同一份结果）
  envReport()
    .then((report) => {
      const s = report.summary;
      const line = `[自检] 通过 ${s.pass} · 注意 ${s.warn} · 失败 ${s.fail}`;
      console.log(line);
      for (const item of report.checks) {
        if (item.status === "pass") continue;
        const tag = item.status === "warn" ? "注意" : "失败";
        console.log(`  [${tag}] ${item.label}：${String(item.detail).split("\n")[0]}`);
        if (item.fix && item.fix.title) console.log(`         解决方法：${item.fix.title}`);
        if (item.fix && item.fix.command) console.log(`         命令：${item.fix.command}`);
      }
      if (s.fail > 0) {
        console.log("  → 网页顶栏「环境自检」里有逐条说明；处理完点「重新自检」。");
      } else {
        console.log("  → 可以开始计算。设计包放在 designs/ 下，参数在 params/settings.json。");
      }
      console.log("");
    })
    .catch((error) => console.log(`[自检] 无法完成：${error.message}`));
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    fail(`端口 ${PORT} 已被占用`, [
      "关闭上一个后端窗口，或换端口启动：set CGH_PORT=3101 && 启动后端.bat",
      `也可以直接打开 http://127.0.0.1:${PORT} 检查是否已经在运行`,
    ]);
  } else {
    fail(`HTTP 服务错误：${error.message}`);
  }
  engine.stop();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// 3. 退出
// ---------------------------------------------------------------------------
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n正在关闭…");
  try {
    engine.stop();
  } catch {}
  server.close(() => {});
  setTimeout(() => process.exit(code), 120);
}

if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    const cmd = line.trim().toLowerCase();
    if (["q", "quit", "exit"].includes(cmd)) shutdown(0);
    else if (cmd) console.log("输入 q 后回车可退出。");
  });
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
if (isWindows) process.on("SIGBREAK", () => shutdown(0));
