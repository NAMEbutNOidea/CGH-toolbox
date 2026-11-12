/** 用 node --check 逐个检查前后端 JS 语法（不依赖任何 npm 包）。 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const targets = [];
for (const dir of ["web", "server", "scripts"]) {
  for (const name of readdirSync(dir)) {
    if (/\.(mjs|js)$/.test(name) && !name.startsWith("_")) targets.push(path.join(dir, name));
  }
}
targets.push("backend.mjs");

let bad = 0;
for (const file of targets) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    bad += 1;
    console.error(`✗ ${file}\n${String(err.stderr || err.message).split("\n").slice(0, 6).join("\n")}`);
  }
}
console.log(bad ? `\n${bad} 个文件语法有误` : `✓ ${targets.length} 个 JS 文件语法正常`);
process.exit(bad ? 1 : 0);
