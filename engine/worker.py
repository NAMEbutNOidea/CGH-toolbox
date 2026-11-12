"""CGH Toolbox 计算工作进程（JSON Lines over stdin/stdout）。

协议
----
请求：{"id": 3, "cmd": "run" | "sweep" | "optimize" | "state" | "env" | "save_settings"
              | "reload_packs" | "cancel" | "outputs" | "ping", ...}
响应：{"id": 3, "ok": true, "data": {...}}  /  {"id": 3, "ok": false, "error": "...", "detail": "..."}
进度：{"id": 3, "event": "progress", "progress": 0.35, "message": "..."}

stderr 只用于人类可读日志，不参与协议。
"""
from __future__ import annotations

import os

# 必须在 numpy 之前设置：该环境的 MKL 多线程层会让 numpy 在部分机器上直接退出
os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")
os.environ.setdefault("OMP_NUM_THREADS", str(max(1, (os.cpu_count() or 4))))

import ctypes
import itertools
import json
import platform
import sys
import threading
import time
import traceback
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent
ROOT = ENGINE_DIR.parent
sys.path.insert(0, str(ENGINE_DIR))

DESIGNS_DIR = ROOT / "designs"
OUTPUT_DIR = ROOT / "output"
PROMPT_PATH = ROOT / "prompts" / "design-pack-prompt.md"
PROMPT_DIR = ROOT / "prompts"

# 提示词模板：网页弹窗里的切换项。id 会作为 GET /api/prompt?kind=<id> 的参数。
PROMPT_TEMPLATES = [
    dict(id="matlab", label="MATLAB 脚本", file="matlab-to-pack-prompt.md",
         hint="原脚本是 .m 文件时选这个：含语法对照、单位换算、矩阵方向陷阱"),
    dict(id="pack", label="通用 / 其他语言", file="design-pack-prompt.md",
         hint="Python、伪代码或只想描述需求时用"),
]

_lock = threading.Lock()
_busy = threading.Event()
_cancel = threading.Event()
_counter = itertools.count(1)


def emit(payload):
    with _lock:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def log(*args):
    print(*args, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# 环境自检
# ---------------------------------------------------------------------------
def _mem_available_gb():
    try:
        if platform.system() == "Windows":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return stat.ullAvailPhys / 1024 ** 3
    except Exception:
        pass
    try:
        info = os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        return info / 1024 ** 3
    except Exception:
        return None


def _write_probe(directory: Path):
    """写一个固定名字的探针文件来判断目录可写。

    刻意不删除：删文件在部分环境下会被安全策略拦截（而且每次自检都删一遍没有必要）。
    同名覆盖既验证了写权限，也不会在目录里堆文件。
    """
    directory.mkdir(parents=True, exist_ok=True)
    probe = directory / ".cgh_write_probe"
    probe.write_text(f"ok {os.getpid()}", encoding="utf-8")
    return True


def _pack_reason(error_text):
    """从设计包报错里抽一句人能看懂的原因（traceback 的最后一条有效行）。"""
    lines = [line.strip() for line in (error_text or "").splitlines() if line.strip()]
    for line in reversed(lines):
        if any(k in line for k in ("Error", "error", "错误", "缺少", "必须")):
            return line[:180]
    return lines[-1][:180] if lines else "未知错误"


def check_env():
    checks = []

    def add(cid, label, status, detail, fix=None):
        checks.append(dict(id=cid, label=label, status=status, detail=detail, fix=fix))

    add("python_runtime", "Python 运行时", "pass",
        f"{platform.python_version()} · {sys.executable}")

    try:
        import numpy
        import scipy
        add("numpy", "numpy / scipy", "pass",
            f"numpy {numpy.__version__} · scipy {scipy.__version__}")
    except Exception as exc:
        add("numpy", "numpy / scipy", "fail", f"导入失败：{exc}",
            dict(title="安装科学计算依赖",
                 steps=["打开 Anaconda Prompt（或已激活的目标环境）",
                        "执行下面这条命令安装 numpy 与 scipy",
                        "回到本页点“重新自检”"],
                 command="pip install numpy scipy"))
        return _finish(checks)

    try:
        import numpy as np
        from scipy import fft as sfft
        t0 = time.time()
        arr = np.random.rand(1024, 1024) + 0j
        sfft.fft2(arr, workers=-1, overwrite_x=True)
        dt = (time.time() - t0) * 1e3
        add("fft", "FFT 计算", "pass" if dt < 800 else "warn",
            f"1024² FFT 耗时 {dt:.0f} ms（MKL 线程层：{os.environ.get('MKL_THREADING_LAYER')}）",
            None if dt < 800 else dict(title="FFT 偏慢", steps=[
                "确认 numpy/scipy 来自 Anaconda 或 pip 官方源，未混用多个 Python 环境",
                "关闭占用 CPU 的其他程序后重试"], command=None))
    except Exception as exc:
        add("fft", "FFT 计算", "fail", f"FFT 自检异常：{exc}",
            dict(title="重装 scipy", steps=["执行下面的命令"], command="pip install --force-reinstall scipy"))

    mem = _mem_available_gb()
    if mem is None:
        add("memory", "可用内存", "warn", "无法读取可用内存")
    else:
        status = "pass" if mem > 2.0 else ("warn" if mem > 1.0 else "fail")
        fix = None
        if status != "pass":
            fix = dict(title="内存不足", steps=[
                "关闭浏览器多余标签页与其他大内存程序",
                "在“计算与显示”里把 far_fft_size 调到 2048、pad_factor 调到 1",
                "精度改为单精度"], command=None)
        add("memory", "可用内存", status, f"约 {mem:.1f} GB 可用（整幅 4096² 远场约需 1.2 GB）", fix)

    for name, path in (("output_dir", OUTPUT_DIR), ("params_dir", ROOT / "params")):
        try:
            _write_probe(path)
            add(name, "目录可写", "pass", str(path))
        except Exception as exc:
            add(name, "目录可写", "fail", f"{path} 不可写：{exc}",
                dict(title="修复目录权限", steps=[
                    "确认项目没有被放在只读位置（例如系统目录或只读网盘）",
                    "关闭可能占用该目录的编辑器/同步软件后重试",
                    "或以管理员身份运行启动脚本"], command=None))

    try:
        import packs
        scanned = packs.scan_packs(DESIGNS_DIR)
        bad = [p for p in scanned if not p.ok]
        active = (_store().load() or {}).get("activePack", "")
        active_bad = any(p.id == active for p in bad)
        if bad:
            detail = (f"发现 {len(scanned)} 个，异常 {len(bad)} 个：" +
                      "；".join(f"{p.id}（{_pack_reason(p.error)}）" for p in bad))
            if active_bad:
                detail += "。当前选中的设计包不可用"
            fix = dict(title="设计包无法加载", command=None, steps=[
                "点顶栏“环境自检”看完整报错，或直接打开 designs/<包名>/design.py 检查报错行",
                "确认文件是 UTF-8 编码、只 import 了 numpy / scipy / cgh_sdk",
                "点顶栏“整理脚本提示词”，把原始脚本交给 AI 重新整理后再放进 designs/",
            ])
            add("packs", "设计包", "fail" if active_bad else "warn", detail, fix)
        else:
            detail = f"发现 {len(scanned)} 个设计包：" + ", ".join(p.id for p in scanned)
            add("packs", "设计包", "pass" if scanned else "fail", detail,
                None if scanned else dict(title="没有可用的设计包", command=None, steps=[
                    "确认 designs/ 下至少有一个包目录（含 manifest.json 与 design.py）",
                    "可先复制 designs/_template 为 designs/my_pack 再改内容",
                ]))
    except Exception as exc:
        add("packs", "设计包", "fail", f"扫描失败：{exc}",
            dict(title="扫描设计包出错", command=None, steps=["查看后端窗口里的 Python 报错行"]))
    except Exception as exc:
        add("packs", "设计包", "fail", f"扫描失败：{exc}")

    try:
        import importlib.util
        has_mpl = importlib.util.find_spec("matplotlib") is not None
        add("image_io", "图像型目标支持", "pass" if has_mpl else "warn",
            "matplotlib 可用（cgh_sdk.image_field 可读 PNG/BMP）" if has_mpl
            else "未安装 matplotlib：使用图片作为目标光场时会失败",
            None if has_mpl else dict(title="可选：安装 matplotlib", steps=[
                "仅在需要读取图片掩模时才要装"], command="pip install matplotlib"))
    except Exception:
        pass

    return _finish(checks)


def _finish(checks):
    summary = dict(ok=sum(1 for c in checks if c["status"] == "pass"),
                   warn=sum(1 for c in checks if c["status"] == "warn"),
                   fail=sum(1 for c in checks if c["status"] == "fail"))
    return dict(checks=checks, summary=summary,
                python=dict(version=platform.python_version(), path=sys.executable))


# ---------------------------------------------------------------------------
# 状态 / 设置
# ---------------------------------------------------------------------------
def _store():
    import settings as settings_mod
    return settings_mod.Store(ROOT)


def build_state():
    import settings as settings_mod
    import packs
    store = _store()
    state = store.load()
    pack_list = packs.scan_packs(DESIGNS_DIR)
    active = state["activePack"]
    pack = next((p for p in pack_list if p.id == active), None)
    if pack is None and pack_list:
        pack = pack_list[0]
        active = pack.id
    pack_values, pack_warnings = ({}, [])
    if pack is not None:
        pack_values, pack_warnings = store.load_pack_values(active, pack.params)

    schema = settings_mod.schema()
    for item in schema:
        if item.get("options") == "METRICS":
            item["options"] = settings_mod.METRIC_OPTIONS
        item["value"] = state["settings"].get(item["key"], item["default"])
    derived = _derived(state["settings"], state["settings"])
    return dict(
        settings=state["settings"],
        settingsSchema=schema,
        derived=derived,
        roles=settings_mod.ROLES,
        roleOrder=settings_mod.ROLE_ORDER,
        health=settings_mod.health(state["settings"], pack_values),
        presets=settings_mod.PRESETS,
        activePack=active,
        packs=[p.info() for p in pack_list],
        packValues=pack_values,
        scoreMetric=state["scoreMetric"],
        scoreMetrics=settings_mod.SCORE_METRICS,
        metricsOptions=settings_mod.METRIC_OPTIONS,
        optimizeParams=settings_mod.optimizable_schema(),
        optimizeObjectives=settings_mod.OPTIMIZE_OBJECTIVES,
        optimizeExcluded=settings_mod.OPTIMIZE_EXCLUDED_GROUPS,
        optimizeMaxEvals=settings_mod.OPTIMIZE_DEFAULT_MAX_EVALS,
        lastRuns=_recent_outputs(8),
        warnings=list(state["warnings"]) + list(pack_warnings),
    )


def _derived(settings, _):
    import optics
    try:
        g = optics.geometry_from_settings(settings, "full")
        summary = g.summary()
        summary["near_plus_center_mm"] = summary["near_center_mm"]
        summary["far_plus_center_mm"] = summary["far_center_mm"]
        return summary
    except Exception as exc:
        return dict(error=str(exc))


def _recent_outputs(limit):
    if not OUTPUT_DIR.exists():
        return []
    items = []
    for child in sorted(OUTPUT_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not child.is_dir() or child.name.startswith("_") or child.name.startswith("."):
            continue
        meta = child / "result.json"
        label, pack_id, summary = child.name, "", {}
        if meta.exists():
            try:
                data = json.loads(meta.read_text(encoding="utf-8"))
                label = data.get("label") or child.name
                pack_id = data.get("packId", "")
                far = data.get("metrics", {}).get("far", {}).get("plus", {})
                summary = {k: far.get(k) for k in ("r1e2_mm", "correlation")}
            except Exception:
                pass
        items.append(dict(runId=child.name, label=label, packId=pack_id,
                          createdAt=time.strftime("%Y-%m-%d %H:%M:%S",
                                                  time.localtime(child.stat().st_mtime)),
                          metricsSummary=summary,
                          files=sorted(p.name for p in child.iterdir() if p.is_file())))
        if len(items) >= limit:
            break
    return items


def preview_health(payload):
    """按「草稿参数」（未保存）算一次体检，供面板即时反馈。"""
    import settings as settings_mod

    state = _store().load()
    merged = dict(state["settings"])
    merged.update(payload.get("settings") or {})
    values, warnings = settings_mod.coerce(merged)
    return dict(health=settings_mod.health(values), warnings=list(warnings))


def save_settings(payload):
    import settings as settings_mod
    import packs
    store = _store()
    state = store.load()
    settings_patch = payload.get("settings") or {}
    pack_values_patch = payload.get("packValues") or {}
    active_pack = payload.get("activePack") or state["activePack"]
    store.save(settings=settings_patch, active_pack=active_pack,
               score_metric=payload.get("scoreMetric"))
    pack = next((p for p in packs.scan_packs(DESIGNS_DIR) if p.id == active_pack), None)
    pack_values = {}
    pack_warnings = []
    if pack is not None and pack_values_patch:
        pack_values, pack_warnings = store.save_pack_values(active_pack, pack_values_patch, pack.params)
    elif pack is not None:
        pack_values = store.load_pack_values(active_pack, pack.params)[0]
    state = store.load()
    return dict(settings=state["settings"], packValues=pack_values,
                activePack=state["activePack"], scoreMetric=state["scoreMetric"],
                warnings=list(state["warnings"]) + list(pack_warnings))


# ---------------------------------------------------------------------------
# 计算作业
# ---------------------------------------------------------------------------
def _resolve(payload):
    import packs
    store = _store()
    state = store.load()
    pack_id = payload.get("packId") or state["activePack"]
    pack = next((p for p in packs.scan_packs(DESIGNS_DIR) if p.id == pack_id), None)
    if pack is None:
        raise ValueError(f"找不到设计包 {pack_id}")
    if not pack.ok:
        raise RuntimeError(pack.error)
    settings, warn1 = _merge_settings(state["settings"], payload.get("settings"))
    pack_values, warn2 = _merge_pack(state, pack, payload.get("packValues"))
    return pack, settings, pack_values, warn1 + warn2


def _merge_settings(base, patch):
    from settings import coerce
    merged = dict(base)
    merged.update(patch or {})
    return coerce(merged)


def _merge_pack(state, pack, patch):
    from settings import coerce
    base, _ = _store().load_pack_values(pack.id, pack.params)
    merged = dict(base)
    merged.update(patch or {})
    return coerce(merged, extra_schema=pack.params)


def do_run(req_id, payload):
    import pipeline
    _cancel.clear()
    pack, settings, pack_values, warn = _resolve(payload)
    quality = payload.get("quality") or "full"
    with_images = payload.get("withImages", True)
    save_bmp = payload.get("saveBmp", settings.get("save_bmp", True))

    def progress(message, frac=None):
        if _cancel.is_set():
            raise _Cancelled()
        emit(dict(id=req_id, event="progress",
                  progress=0.0 if frac is None else float(frac), message=message))

    result = pipeline.run(settings, pack_values, pack, quality=quality,
                          with_images=with_images, save_bmp=save_bmp,
                          out_dir=OUTPUT_DIR, progress=progress,
                          label=payload.get("label") or "")
    result["warnings"] = list(warn) + list(result.get("warnings") or [])
    return result


def do_sweep(req_id, payload):
    import itertools

    import metrics as metrics_mod

    _cancel.clear()
    pack, settings, pack_values, warn = _resolve(payload)
    axes = payload.get("axes") or []
    if not axes:
        raise ValueError("没有选择要扫描的参数")
    score_metric = payload.get("scoreMetric") or "composite"
    quality = payload.get("quality") or "fast"

    keys, value_lists, columns = [], [], []
    for axis in axes:
        key = axis["key"]
        values = axis.get("values")
        if not values:
            raise ValueError(f"参数 {key} 没有给出扫描取值")
        keys.append(key)
        value_lists.append(list(values))
        label = axis.get("label") or key
        columns.append(dict(key=key, label=label, unit=axis.get("unit", "")))

    combos = list(itertools.product(*value_lists))
    total = len(combos)
    emit(dict(id=req_id, event="progress", progress=0.0,
              message=f"共 {total} 组，开始扫描"))

    import pipeline
    rows = []
    for index, combo in enumerate(combos):
        if _cancel.is_set():
            raise _Cancelled()
        params = dict(zip(keys, combo))
        local_settings = dict(settings)
        local_pack = dict(pack_values)
        for key, value in params.items():
            if key in local_settings:
                local_settings[key] = value
            else:
                local_pack[key] = value
        started = time.time()
        try:
            result = pipeline.run(local_settings, local_pack, pack, quality=quality,
                                  with_images=False, save_bmp=False, out_dir=None,
                                  progress=lambda m, f=None: None)
            flat = metrics_mod.flatten_metrics(result["metrics"])
            score = metrics_mod.score_of(flat, score_metric)
            rows.append(dict(params=params, score=score, ok=True, note="",
                             elapsedMs=int((time.time() - started) * 1000),
                             metrics={k: flat.get(k) for k in (
                                 "far.r1e2_mm", "near.r1e2_mm", "far.correlation",
                                 "near.correlation", "far.normalized_rmse",
                                 "near.normalized_rmse", "far.plus_energy_fraction",
                                 "near.plus_energy_fraction",
                                 "far.zero_plus_peak_ratio", "far.offset_mm")}))
        except _Cancelled:
            raise
        except Exception as exc:
            rows.append(dict(params=params, score=None, ok=False,
                             note=str(exc).splitlines()[0][:200], metrics={}))
        emit(dict(id=req_id, event="progress", progress=(index + 1) / total,
                  message=f"已完成 {index + 1}/{total}"))

    direction = payload.get("direction") or "max"

    def sort_key(row):
        score = row["score"]
        if score is None:
            return (1, 0)
        return (0, -score if direction == "max" else score)

    rows.sort(key=sort_key)
    best = next((r for r in rows if r["ok"] and r["score"] is not None), None)
    return dict(total=total, completed=len(rows), columns=columns, rows=rows,
                best=best, scoreMetric=score_metric, quality=quality,
                direction=direction, warnings=warn)


class _Cancelled(Exception):
    pass


# ---------------------------------------------------------------------------
# 优化：以「一级 vs 理想一级」的相似系数为目标，坐标模式搜索（实现在 optimize.py）
# ---------------------------------------------------------------------------
def do_optimize(req_id, payload):
    import optimize as optimize_mod

    _cancel.clear()
    pack, settings, pack_values, warn = _resolve(payload)

    def progress(message, frac=None):
        emit(dict(id=req_id, event="progress",
                  progress=0.0 if frac is None else float(frac), message=message))

    try:
        result = optimize_mod.run(settings, pack_values, pack, payload,
                                  progress=progress, cancel=_cancel.is_set)
    except optimize_mod.Cancelled:
        raise _Cancelled()
    result["warnings"] = list(warn) + list(result.get("warnings") or [])
    return result



# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------
def handle(req):
    cmd = req.get("cmd")
    if cmd == "ping":
        return dict(pong=True, busy=_busy.is_set())
    if cmd == "env":
        return check_env()
    if cmd == "state":
        return build_state()
    if cmd == "save_settings":
        return save_settings(req.get("payload") or {})
    if cmd == "health":
        return preview_health(req.get("payload") or {})
    if cmd == "reload_packs":
        import packs
        return dict(packs=[p.info() for p in packs.scan_packs(DESIGNS_DIR)])
    if cmd == "outputs":
        payload = req.get("payload") or {}
        return dict(items=_recent_outputs(int(payload.get("limit") or 20)))
    if cmd == "prompt":
        payload = req.get("payload") or {}
        kind = str(payload.get("kind") or "matlab")
        entry = next((t for t in PROMPT_TEMPLATES if t["id"] == kind), PROMPT_TEMPLATES[0])
        path = PROMPT_DIR / entry["file"]
        text = path.read_text(encoding="utf-8") if path.exists() else ""
        return dict(
            markdown=text,
            path=str(path),
            kind=entry["id"],
            label=entry["label"],
            templates=[dict(id=t["id"], label=t["label"], hint=t["hint"],
                            available=(PROMPT_DIR / t["file"]).exists())
                       for t in PROMPT_TEMPLATES],
        )
    if cmd == "cancel":
        _cancel.set()
        return dict(cancelled=True)
    raise ValueError(f"未知命令 {cmd}")


def warmup():
    """在主线程里预导入所有重模块。

    不能在计算线程里首次 import：Windows 下主线程阻塞在 stdin 读取时，
    子线程的 numpy 导入会死锁（现象是任务一直停在“排队中”）。
    """
    import numpy  # noqa: F401
    import scipy.fft  # noqa: F401
    import scipy.interpolate  # noqa: F401
    import scipy.ndimage  # noqa: F401
    import scipy.optimize  # noqa: F401
    import scipy.special  # noqa: F401
    import bmpio  # noqa: F401
    import cgh_sdk  # noqa: F401
    import encoding  # noqa: F401
    import lpmodes  # noqa: F401
    import metrics  # noqa: F401
    import optics  # noqa: F401
    import optimize  # noqa: F401
    import packs  # noqa: F401
    import pipeline  # noqa: F401
    import render  # noqa: F401
    # 迭代编码可能跑几十秒：把取消标志暴露给 encoding，让它每个迭代检查一次
    try:
        import encoding
        encoding.CANCEL_HOOK = _cancel.is_set
    except Exception:
        pass
    import settings  # noqa: F401


def main():
    log(f"[worker] python {platform.python_version()} · {sys.executable}")
    warmup()
    log("[worker] 依赖已就绪")
    emit(dict(event="ready", id=0))
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        req_id = req.get("id")
        cmd = req.get("cmd")
        if cmd in ("run", "sweep", "optimize"):
            if _busy.is_set():
                emit(dict(id=req_id, ok=False, error="上一个计算还没结束，请稍等或点取消"))
                continue
            _busy.set()

            def target(req=req, req_id=req_id, cmd=cmd):
                try:
                    body = req.get("payload") or {}
                    if cmd == "run":
                        data = do_run(req_id, body)
                    elif cmd == "sweep":
                        data = do_sweep(req_id, body)
                    else:
                        data = do_optimize(req_id, body)
                    emit(dict(id=req_id, ok=True, data=data))
                except _Cancelled:
                    emit(dict(id=req_id, ok=False, error="已取消"))
                except MemoryError:
                    emit(dict(id=req_id, ok=False,
                              error="内存不足：请把 far_fft_size 降到 2048、pad_factor 降到 1，"
                                    "或把 precision 改成 single 后重试"))
                except Exception as exc:
                    emit(dict(id=req_id, ok=False, error=_short(exc),
                              detail=traceback.format_exc(limit=8)))
                finally:
                    _busy.clear()
                    _cancel.clear()

            threading.Thread(target=target, daemon=True).start()
            continue
        try:
            data = handle(req)
            emit(dict(id=req_id, ok=True, data=data))
        except Exception as exc:
            emit(dict(id=req_id, ok=False, error=_short(exc), detail=traceback.format_exc(limit=8)))


def _short(exc):
    text = str(exc).strip() or exc.__class__.__name__
    return text.splitlines()[0][:500]


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
