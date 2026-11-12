"""自动优化器：以「一级 vs 理想一级」的相似系数为目标，带缓存的坐标模式搜索。

为什么重写（2026-11）
--------------------
旧版有三个硬伤，实测 30 次评估里能浪费掉 6 次以上：

1. 没有缓存：枚举变量每轮都从旧值重新遍历全部选项，同样的组合被算 3 遍；
2. 探测点取「区间两端」：对 0.2–12 mm 这种宽区间，两端都是物理上无意义的组合，
   既浪费时间又会给出误导性的「改进」方向；
3. 用全局最优覆盖当前解：某变量改进后跳到另一个组合，导致在两组之间来回振荡。

新版：
  · 所有评估走 memo，重复组合直接复用（记 cached，不耗预算、不重复算 FFT）；
  · 粗扫阶段每个数值变量取 5 个点（当前值 ±25%/±50% 区间），枚举全试一次；
  · 精修阶段对每个变量在当前状态附近 ±step 试探，接受则就地更新（局部爬山），
    step 逐轮减半直到最小步长；
  · 选优用「按基线归一化的相对改进」（merit），避免已经饱和的平面吃掉全部权重；
  · 结束时可选 full 档复核，报告 fast 估计与 full 实测的差。
"""
from __future__ import annotations

import time

import metrics as metrics_mod
import pipeline
import settings as settings_mod

# 粗扫时每个数值变量取几个点（含基线本身）
_COARSE_POINTS = 5


class Cancelled(Exception):
    """用户点了取消（worker 会把它翻译成自己的 _Cancelled）。"""


def _energy(flat):
    near = flat.get("near.plus_energy_fraction")
    far = flat.get("far.plus_energy_fraction")
    vals = [v for v in (near, far) if isinstance(v, (int, float))]
    return sum(vals) / len(vals) if vals else None


def _display_score(flat, objective):
    """给人看的分数：仍然是真实的相似系数（或能量占比），不掺归一化。"""
    near = flat.get("near.correlation")
    far = flat.get("far.correlation")
    if objective == "energy":
        return _energy(flat)
    if objective == "near.correlation":
        return near
    if objective == "far.correlation":
        return far
    if near is None or far is None:
        return near if far is None else far
    return 0.5 * (near + far)


def _merit(flat, objective, base):
    """给优化器看的分数：相对基线的归一化改进，基线 = 0。

    远场相似系数常年在 0.98 以上，(1-corr) 只剩 0.02 的余量；若直接平均，
    近场 0.85→0.91 的 0.06 改进会被远场 0.98→0.97 的 0.01 退化稀释成「几乎没变化」。
    按各自剩余误差归一后，两个平面的改进才等价可比。
    """
    near = flat.get("near.correlation")
    far = flat.get("far.correlation")
    if objective == "energy":
        e, e0 = _energy(flat), base.get("energy")
        if e is None or e0 is None:
            return None
        return (e - e0) / max(0.02, 1.0 - e0)
    if objective == "near.correlation":
        if near is None or base.get("near") is None:
            return None
        return (near - base["near"]) / max(0.02, 1.0 - base["near"])
    if objective == "far.correlation":
        if far is None or base.get("far") is None:
            return None
        return (far - base["far"]) / max(0.02, 1.0 - base["far"])
    if near is None or far is None or base.get("near") is None or base.get("far") is None:
        return None
    en = max(0.02, 1.0 - base["near"])
    ef = max(0.02, 1.0 - base["far"])
    return 0.5 * ((near - base["near"]) / en + (far - base["far"]) / ef)


def run(settings, pack_values, pack, payload, progress=None, cancel=None):
    objective = payload.get("objective") or "both"
    known = [o["value"] for o in settings_mod.OPTIMIZE_OBJECTIVES]
    if objective not in known:
        raise ValueError(f"未知的优化目标：{objective}")
    quality = payload.get("quality") or "fast"
    budget = int(payload.get("maxEvals") or settings_mod.OPTIMIZE_DEFAULT_MAX_EVALS)
    budget = max(6, min(budget, 400))
    verify = payload.get("verify", True) and quality != "full"

    catalog = {item["key"]: item for item in settings_mod.optimizable_schema()}
    requested = payload.get("variables") or []
    if not requested:
        raise ValueError("没有勾选要优化的参数")
    variables = []
    for key in requested:
        spec = catalog.get(key)
        if spec is None:
            raise ValueError(f"参数 {key} 不在可优化清单里")
        if not spec["optimizable"]:
            raise ValueError(f"「{spec['label']}」被标记为不适合优化：{spec['note']}")
        if spec["type"] not in ("number", "int", "enum"):
            raise ValueError(f"「{spec['label']}」类型不支持优化")
        variables.append(spec)
    # 推荐变量先动：编码方式是收益最大的一步，先定它再调连续量
    rank_weight = {"recommended": 0, "optional": 1, "caution": 2}
    variables.sort(key=lambda s: (rank_weight.get(s["rank"], 3), s["key"]))

    bounds = {}
    overrides = payload.get("ranges") or {}
    for spec in variables:
        key = spec["key"]
        if spec["type"] == "enum":
            bounds[key] = dict(kind="enum", options=[str(o["value"]) for o in spec["options"]])
            continue
        lo, hi = spec.get("min"), spec.get("max")
        override = overrides.get(key) or {}
        if isinstance(override.get("min"), (int, float)):
            lo = float(override["min"])
        if isinstance(override.get("max"), (int, float)):
            hi = float(override["max"])
        if lo is None or hi is None:
            raise ValueError(f"「{spec['label']}」缺少可用的搜索区间")
        if hi <= lo:
            raise ValueError(f"「{spec['label']}」的区间上限必须大于下限")
        bounds[key] = dict(kind="number", min=float(lo), max=float(hi),
                           integer=spec["type"] == "int",
                           quantum=float(spec.get("step") or 0) or None)

    def clamp(key, value):
        b = bounds[key]
        if b["kind"] == "enum":
            return value if value in b["options"] else b["options"][0]
        value = min(max(float(value), b["min"]), b["max"])
        if b["integer"]:
            return int(round(value))
        q = b["quantum"]
        if q:
            steps = round((value - b["min"]) / q)
            value = b["min"] + steps * q
            value = min(max(value, b["min"]), b["max"])
        return float(f"{value:.10g}")

    base_values = {}
    for spec in variables:
        key = spec["key"]
        value = settings.get(key, spec["default"])
        base_values[key] = str(value) if bounds[key]["kind"] == "enum" else float(value)

    history = []
    cache = {}
    hits = [0]
    state = dict(base_values)
    state_merit = [None]
    best_holder = dict(values=dict(state), score=None, merit=None, energy=None,
                       near=None, far=None)
    energy_floor = [None]
    base_row = [None]

    def key_of(values):
        return tuple((k, repr(v)) for k, v in sorted(values.items()))

    def emit_progress(text):
        if progress:
            progress(text, min(0.999, len(history) / max(1, budget)))

    def evaluate(values, tag="", is_base=False):
        if cancel and cancel():
            raise Cancelled()
        ck = key_of(values)
        if ck in cache:
            hits[0] += 1
            return cache[ck]
        if len(history) >= budget:
            return None
        started = time.time()
        local = dict(settings)
        local.update(values)
        flat = None
        failure = ""
        try:
            result = pipeline.run(local, pack_values, pack, quality=quality,
                                  with_images=False, save_bmp=False, out_dir=None,
                                  progress=lambda m, f=None: None)
            flat = metrics_mod.flatten_metrics(result["metrics"])
        except MemoryError:
            raise
        except Exception as exc:  # 单个候选不可行（例如载波超 Nyquist）不该中断整轮
            failure = str(exc).splitlines()[0][:180]
        if flat is None:
            row = dict(n=len(history) + 1, tag=tag, values=dict(values), score=None,
                       merit=None, correlation=None, near=None, far=None, energy=None,
                       energyOk=False, nearR1e2=None, farR1e2=None,
                       elapsedMs=int((time.time() - started) * 1000), ok=False, note=failure)
            history.append(row)
            cache[ck] = row
            emit_progress(f"第 {len(history)}/{budget} 次 · 该组合不可行（{failure[:40]}）")
            return row

        energy = _energy(flat)
        score = _display_score(flat, objective)
        # 基线本身定义为 merit = 0（归一化改进的零点）
        raw_merit = 0.0 if is_base else _merit(flat, objective, base_row[0] or {})
        # 能量保底：低于基线能量的 60% 视作「靠变暗刷分」，按比例软惩罚而不是一刀减 0.2
        factor = 1.0
        if energy is not None and energy_floor[0]:
            factor = min(1.0, (energy / energy_floor[0]) ** 0.5)
        merit = None if raw_merit is None else raw_merit * factor
        row = dict(
            n=len(history) + 1, tag=tag, values=dict(values),
            score=None if score is None else float(score),
            merit=None if merit is None else float(merit),
            correlation=None if score is None else float(score),
            near=flat.get("near.correlation"), far=flat.get("far.correlation"),
            energy=energy, energyOk=factor >= 0.999,
            nearR1e2=flat.get("near.r1e2_mm"), farR1e2=flat.get("far.r1e2_mm"),
            elapsedMs=int((time.time() - started) * 1000), ok=True, note="",
        )
        history.append(row)
        cache[ck] = row
        if merit is not None and (best_holder["merit"] is None or merit > best_holder["merit"] + 1e-9):
            best_holder.update(values=dict(values), score=row["score"], merit=merit,
                               energy=energy, near=row["near"], far=row["far"])
        shown = "—" if best_holder["score"] is None else f"{best_holder['score']:.4f}"
        emit_progress(f"第 {len(history)}/{budget} 次 · 当前最好相似系数 {shown}"
                      f"（本次 近 {row['near'] or 0:.3f} / 远 {row['far'] or 0:.3f}）")
        return row

    def improved(row, reference):
        return (row is not None and row["merit"] is not None
                and (reference is None or row["merit"] > reference + 1e-9))

    # ---------------- 阶段 0：基线 ----------------
    base_row[0] = dict(near=None, far=None, energy=None)
    first = evaluate(state, "基线", is_base=True)
    if first is None or first["ok"] is False:
        raise RuntimeError("基线参数无法计算：" + (first.get("note") if first else "预算不足"))
    base_row[0] = dict(near=first["near"], far=first["far"], energy=first["energy"],
                       score=first["score"], merit=first["merit"], values=dict(state))
    # 基线的 merit 定义成 0（上式已经保证），把它钉死，避免浮点误差导致「基线比基线好」
    first["merit"] = 0.0
    best_holder.update(values=dict(state), score=first["score"], merit=0.0,
                       energy=first["energy"], near=first["near"], far=first["far"])
    state_merit[0] = 0.0
    if first["energy"]:
        energy_floor[0] = first["energy"] * settings_mod.OPTIMIZE_ENERGY_FLOOR_RATIO

    numeric = [s for s in variables if bounds[s["key"]]["kind"] == "number"]
    enums = [s for s in variables if bounds[s["key"]]["kind"] == "enum"]

    # ---------------- 阶段 1：粗扫（每个变量就地定下） ----------------
    for spec in variables:
        key = spec["key"]
        b = bounds[key]
        if b["kind"] == "enum":
            candidates = [v for v in b["options"] if v != state[key]]
        else:
            span = b["max"] - b["min"]
            offsets = (-0.5, -0.25, 0.25, 0.5) if len(variables) <= 3 else (-0.35, 0.35)
            candidates = []
            for frac in offsets:
                value = clamp(key, state[key] + frac * span)
                if value != state[key] and value not in candidates:
                    candidates.append(value)
        for value in candidates:
            if len(history) >= budget:
                break
            trial = dict(state)
            trial[key] = value
            row = evaluate(trial, f"{spec['label']}={value}")
            if improved(row, state_merit[0]):
                state = dict(row["values"])
                state_merit[0] = row["merit"]
        if len(history) >= budget:
            break

    # ---------------- 阶段 2：精修（局部爬山 + 步长减半） ----------------
    steps = {}
    for spec in numeric:
        key = spec["key"]
        b = bounds[key]
        steps[key] = (b["max"] - b["min"]) / 8.0

    rounds = 0
    while len(history) < budget and rounds < 40:
        rounds += 1
        moved = False
        for spec in numeric:
            if len(history) >= budget:
                break
            key = spec["key"]
            b = bounds[key]
            step = steps.get(key, 0.0)
            if step <= 0:
                continue
            for sign in (1.0, -1.0):
                if len(history) >= budget:
                    break
                candidate = dict(state)
                candidate[key] = clamp(key, float(state[key]) + sign * step)
                if candidate[key] == state[key]:
                    continue
                row = evaluate(candidate, f"{spec['label']} {'+' if sign > 0 else '-'}{step:.4g}")
                if improved(row, state_merit[0]):
                    state = dict(row["values"])
                    state_merit[0] = row["merit"]
                    moved = True
                    break
        # 枚举变量在精修阶段也重试一次：其他变量变了，最优编码方式可能跟着变
        for spec in enums:
            if len(history) >= budget:
                break
            key = spec["key"]
            for value in bounds[key]["options"]:
                if len(history) >= budget or value == state[key]:
                    continue
                candidate = dict(state)
                candidate[key] = value
                row = evaluate(candidate, f"{spec['label']}={value}")
                if improved(row, state_merit[0]):
                    state = dict(row["values"])
                    state_merit[0] = row["merit"]
                    moved = True
        if not moved:
            shrunk = False
            for key in steps:
                b = bounds[key]
                min_step = max(b["quantum"] or 0.0, (b["max"] - b["min"]) / 512.0)
                if steps[key] > min_step * 1.001:
                    steps[key] /= 2
                    shrunk = True
            if not shrunk:
                break

    # ---------------- 收尾：贴边界提示 + full 复核 ----------------
    at_bounds = []
    for spec in variables:
        b = bounds[spec["key"]]
        if b["kind"] != "number":
            continue
        value = best_holder["values"].get(spec["key"])
        if value is None:
            continue
        tol = max(b["quantum"] or 0.0, (b["max"] - b["min"]) * 0.01)
        if abs(value - b["min"]) <= tol or abs(value - b["max"]) <= tol:
            at_bounds.append(spec["key"])

    saturated = []
    for label, value in (("近场", first["near"]), ("远场", first["far"])):
        if isinstance(value, (int, float)) and value >= settings_mod.OPTIMIZE_SATURATION:
            saturated.append(label)

    verify_data = None
    if verify:
        def flat_of(values):
            local = dict(settings)
            local.update(values)
            try:
                r = pipeline.run(local, pack_values, pack, quality="full",
                                 with_images=False, save_bmp=False, out_dir=None,
                                 progress=lambda m, f=None: None)
            except Exception:
                return None
            return metrics_mod.flatten_metrics(r["metrics"])

        b0 = flat_of(base_values)
        b1 = flat_of(best_holder["values"])
        if b0 and b1:
            verify_data = dict(
                base=dict(near=b0.get("near.correlation"), far=b0.get("far.correlation"),
                          energy=_energy(b0),
                          score=_display_score(b0, objective)),
                best=dict(near=b1.get("near.correlation"), far=b1.get("far.correlation"),
                          energy=_energy(b1),
                          score=_display_score(b1, objective)),
            )
            verify_data["delta"] = (None if verify_data["best"]["score"] is None
                                    or verify_data["base"]["score"] is None
                                    else verify_data["best"]["score"] - verify_data["base"]["score"])

    base_score = first["score"]
    best_score = best_holder["score"]
    return dict(
        objective=objective,
        quality=quality,
        variables=[dict(key=s["key"], label=s["label"], unit=s.get("unit") or "",
                        role=s.get("role"), type=s["type"], kind=bounds[s["key"]]["kind"],
                        min=bounds[s["key"]].get("min"), max=bounds[s["key"]].get("max"),
                        options=([dict(value=str(o["value"]), label=o.get("label") or str(o["value"]))
                                  for o in (s.get("options") or [])]
                                 if s["type"] == "enum" else None))
                   for s in variables],
        budget=budget,
        evaluated=len(history),
        cached=hits[0],
        base=dict(values=dict(base_values), score=base_score, merit=0.0,
                  energy=first["energy"], near=first["near"], far=first["far"]),
        best=dict(values=dict(best_holder["values"]), score=best_score,
                  merit=best_holder["merit"], correlation=best_score,
                  energy=best_holder["energy"], near=best_holder["near"],
                  far=best_holder["far"]),
        improved=bool(best_holder["merit"] is not None and best_holder["merit"] > 1e-6),
        atBounds=at_bounds,
        delta=(None if best_score is None or base_score is None else best_score - base_score),
        deltaMerit=best_holder["merit"],
        energyFloor=energy_floor[0],
        saturated=saturated,
        verify=verify_data,
        history=history,
    )
