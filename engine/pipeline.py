"""主流程：设计包 → 目标复场 → 编码 → 近/远场仿真 → 指标 → 图像。"""
from __future__ import annotations

import csv
import json
import time
import traceback
from pathlib import Path

import numpy as np
import scipy.ndimage as ndi

import bmpio
import encoding
import metrics as metrics_mod
import render
from optics import geometry_from_settings, map_field


def _intensity(field):
    mag = np.abs(field)
    return np.square(mag, out=mag)


def _carrier_pad(g):
    return np.exp(1j * 2 * np.pi * (g.carrier_frequency[0] * g.near_x[None, :] +
                                    g.carrier_frequency[1] * g.near_y[:, None]))


def _ideal_far_on_sensor(g, ideal_far):
    """离焦时把焦面理想强度重采样到实际传感器网格（保持位移/尺度误差可见）。"""
    b = g.far_abcd[1]
    if abs(b - g.far_focal) < 1e-12:
        return ideal_far
    n = int(g.far_fft_size)
    k = np.arange(n) - n // 2
    x_i = g.wavelength * g.far_focal * k / (n * g.dx)
    y_i = -g.wavelength * g.far_focal * k / (n * g.dy)
    dx_i = x_i[1] - x_i[0]
    dy_i = y_i[1] - y_i[0]
    cols = (g.far_x - x_i[0]) / dx_i
    rows = (g.far_y - y_i[0]) / dy_i
    RR, CC = np.meshgrid(rows, cols, indexing="ij")
    return ndi.map_coordinates(ideal_far, [RR, CC], order=1, mode="constant", cval=0.0)


def run(settings, pack_values, pack, quality="full", with_images=True,
        save_bmp=True, out_dir=None, progress=None, label=""):
    t0 = time.time()
    steps = []

    def step(msg, frac=None):
        steps.append(msg)
        if progress:
            progress(msg, frac)

    step("构建光路与网格", 0.05)
    g = geometry_from_settings(settings, quality)

    step("调用设计包生成目标复场", 0.15)
    field, extent = pack.build_field(pack_values, settings, g)

    step("反传补偿与相位编码", 0.35)
    bitmap, info, _ = encoding.encode(
        g, field, extent, settings["encoding_method"],
        progress=lambda m: step(m, 0.4),
        iterations=settings.get("encoding_iterations", 8),
        windows=dict(near=settings.get("near_plus_half_mm", 0.0) * 1e-3,
                     far=settings.get("far_plus_half_mm", 0.0) * 1e-3),
        iterative_plane=settings.get("encoding_iterative_plane", "both"))

    step("近场传播（角谱）", 0.55)
    phase = bitmap.astype(np.float64) * (2 * np.pi / 255.0)
    slm_field = (g.input_amplitude * np.exp(1j * phase)).astype(g.dtype)
    slm_power = float(np.sum(np.abs(slm_field) ** 2)) * g.dx * g.dy
    near_intensity, _ = g.propagate_near(slm_field)

    step("远场传播（Collins）", 0.68)
    far_intensity = g.propagate_far(slm_field)
    del slm_field

    step("生成理想参考光场", 0.78)
    carrier = _carrier_pad(g)
    ideal_near_complex = (map_field(field, extent, g.near_center, g.near_x, g.near_y)
                          * carrier).astype(g.dtype)
    del carrier
    ideal_near = _intensity(ideal_near_complex)

    step("计算指标", 0.86)
    near_metrics = metrics_mod.plane_metrics(
        near_intensity, ideal_near, g.near_x, g.near_y, g.near_center,
        settings["near_zero_half_mm"] * 1e-3, settings["near_plus_half_mm"] * 1e-3,
        "近场", slm_power)

    ideal_far = g.far_from_near_field(ideal_near_complex)
    del ideal_near_complex
    ideal_far = _ideal_far_on_sensor(g, ideal_far)
    far_metrics = metrics_mod.plane_metrics(
        far_intensity, ideal_far, g.far_x, g.far_y, g.far_center,
        settings["far_zero_half_mm"] * 1e-3, settings["far_plus_half_mm"] * 1e-3,
        "远场", slm_power)

    warnings = _warnings(settings, g, info, near_metrics, far_metrics)
    diagnosis = _diagnosis(settings, g, info, near_metrics, far_metrics, ideal_near)

    result = dict(
        packId=pack.id, packName=pack.name, label=label,
        quality=quality,
        settingsUsed=settings, packValuesUsed=pack_values,
        geometry=g.summary(),
        encoding=dict(
            method=info["method"],
            transmission_scale=info["transmission_scale"],
            weak_illumination_energy_fraction=info["weak_illumination_energy_fraction"],
            camera_window_energy_ratio=info["camera_window_energy_ratio"],
            zero_order_radius_mm=info.get("zero_order_radius_mm", 0.0),
            zero_order_illumination_fraction=info.get("zero_order_illumination_fraction", 0.0),
            iterations=info.get("iterations"),
            iteration_plane=info.get("iteration_plane"),
            iteration_correlation_initial=info.get("iteration_correlation_initial"),
            iteration_correlation_final=info.get("iteration_correlation_final"),
            iteration_far_correlation_final=info.get("iteration_far_correlation_final"),
        ),
        metrics=dict(near=near_metrics, far=far_metrics),
        warnings=warnings,
        diagnosis=diagnosis,
    )

    images = {}
    profiles = {}
    overlays_all = {}
    if with_images:
        step("生成预览图像", 0.9)
        overlays_all = _overlays(settings, g)
        near_x_mm, near_y_mm = g.near_x, g.near_y
        far_x_mm, far_y_mm = g.far_x, g.far_y
        images["near_overview"] = render.encode_image(near_intensity, near_x_mm, near_y_mm, 760)
        images["near_zero"] = render.encode_image(
            _roi(near_intensity, g.near_x, g.near_y, (0, 0), settings["near_zero_half_mm"] * 1e-3),
            *_roi_axes(g.near_x, g.near_y, (0, 0), settings["near_zero_half_mm"] * 1e-3), 640)
        images["near_plus"] = render.encode_image(
            _roi(near_intensity, g.near_x, g.near_y, g.near_center, settings["near_plus_half_mm"] * 1e-3),
            *_roi_axes(g.near_x, g.near_y, g.near_center, settings["near_plus_half_mm"] * 1e-3), 640)
        images["near_ideal"] = render.encode_image(
            _roi(ideal_near, g.near_x, g.near_y, g.near_center, settings["near_plus_half_mm"] * 1e-3),
            *_roi_axes(g.near_x, g.near_y, g.near_center, settings["near_plus_half_mm"] * 1e-3), 640)
        images["far_overview"] = render.encode_image(far_intensity, far_x_mm, far_y_mm, 760)
        images["far_zero"] = render.encode_image(
            _roi(far_intensity, g.far_x, g.far_y, (0, 0), settings["far_zero_half_mm"] * 1e-3),
            *_roi_axes(g.far_x, g.far_y, (0, 0), settings["far_zero_half_mm"] * 1e-3), 640)
        images["far_plus"] = render.encode_image(
            _roi(far_intensity, g.far_x, g.far_y, g.far_center, settings["far_plus_half_mm"] * 1e-3),
            *_roi_axes(g.far_x, g.far_y, g.far_center, settings["far_plus_half_mm"] * 1e-3), 640)
        images["far_ideal"] = render.encode_image(
            _roi(ideal_far, g.far_x, g.far_y, g.far_center, settings["far_plus_half_mm"] * 1e-3),
            *_roi_axes(g.far_x, g.far_y, g.far_center, settings["far_plus_half_mm"] * 1e-3), 640)
        images["phase"] = render.encode_phase(bitmap, 960)
        # 总览图另给一个「窗口内最大值」：相机面上零级/残余级次常比一级亮几十倍，
        # 按全图峰值归一化会把一级压成灰雾，按窗口归一化才看得清各级次本身。
        for key, intens, ax, ay in (("near_overview", near_intensity, g.near_x, g.near_y),
                                    ("far_overview", far_intensity, g.far_x, g.far_y)):
            boxes = (overlays_all or {}).get(key) or []
            win_vmax = _window_vmax(intens, ax, ay, boxes)
            if win_vmax > 0:
                images[key]["vmax_windows"] = win_vmax
        profiles["near_plus"] = render.profiles(near_intensity, g.near_x, g.near_y,
                                                g.near_center, settings["near_plus_half_mm"] * 1e-3)
        profiles["far_plus"] = render.profiles(far_intensity, g.far_x, g.far_y,
                                               g.far_center, settings["far_plus_half_mm"] * 1e-3)
        del ideal_near, ideal_far
    result["images"] = images
    result["overlays"] = overlays_all
    result["profiles"] = profiles

    # ---- 产物 ----
    run_id = time.strftime("%Y%m%d-%H%M%S")
    result["runId"] = run_id
    if out_dir is not None:
        run_dir = Path(out_dir) / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        artifacts = dict(dir=str(run_dir))
        if save_bmp and quality != "fast":
            bmp_path = bmpio.write_bmp8(run_dir / "CGH" / "manual_00001_CGH.bmp", bitmap)
            artifacts["bmp"] = f"/files/{run_id}/CGH/{bmp_path.name}"
        _write_csv(run_dir / "metrics.csv", near_metrics, far_metrics, settings, info)
        artifacts["csv"] = f"/files/{run_id}/metrics.csv"
        slim = dict(result)
        slim.pop("images", None)
        (run_dir / "result.json").write_text(json.dumps(slim, ensure_ascii=False, indent=2),
                                             encoding="utf-8")
        artifacts["json"] = f"/files/{run_id}/result.json"
        result["artifacts"] = artifacts

    result["pinned"] = _pinned(settings, near_metrics, far_metrics)
    result["elapsedMs"] = int((time.time() - t0) * 1000)
    result["steps"] = steps
    step("完成", 1.0)
    return result


def _roi(arr, x, y, center, half):
    ix = np.where(np.abs(x - center[0]) <= half)[0]
    iy = np.where(np.abs(y - center[1]) <= half)[0]
    if ix.size < 2 or iy.size < 2:
        return arr
    return arr[np.ix_(iy, ix)]


def _roi_axes(x, y, center, half):
    ix = np.where(np.abs(x - center[0]) <= half)[0]
    iy = np.where(np.abs(y - center[1]) <= half)[0]
    if ix.size < 2 or iy.size < 2:
        return x, y
    return x[ix], y[iy]


def _overlays(settings, g):
    """总览图上要框出来的窗口（单位 mm，坐标系与 encode_image 的 x0..x1 一致）。"""
    def box(kind, label, center, half):
        return dict(kind=kind, label=label,
                    cx=float(center[0]) * 1e3, cy=float(center[1]) * 1e3,
                    hx=float(half), hy=float(half))

    nz = settings["near_zero_half_mm"]
    np_ = settings["near_plus_half_mm"]
    fz = settings["far_zero_half_mm"]
    fp = settings["far_plus_half_mm"]
    return dict(
        near_overview=[
            box("minus", "-1 级", (-g.near_center[0], -g.near_center[1]), np_),
            box("zero", "0 级", (0.0, 0.0), nz),
            box("plus", "+1 级", g.near_center, np_),
        ],
        far_overview=[
            box("minus", "-1 级", (-g.far_center[0], -g.far_center[1]), fp),
            box("zero", "0 级", (0.0, 0.0), fz),
            box("plus", "+1 级", g.far_center, fp),
        ],
    )


def _window_vmax(intensity, x, y, boxes):
    """所有评价窗口内的最大强度（用于总览图的「窗口归一化」）。"""
    best = 0.0
    for box in boxes or []:
        ix = np.abs(x - box["cx"] * 1e-3) <= box["hx"] * 1e-3
        iy = np.abs(y - box["cy"] * 1e-3) <= box["hy"] * 1e-3
        if not ix.any() or not iy.any():
            continue
        best = max(best, float(np.max(intensity[np.ix_(iy, ix)])))
    return best


def _bandwidth(ideal, x, y, center, half):
    """理想一级的结构频谱：返回 90% 能量所在的频率半径（1/m）与超出量估计。

    只看窗口内去掉整体包络后的结构成分，用来回答「目标最小结构有多大」。
    """
    ix = np.where(np.abs(x - center[0]) <= half)[0]
    iy = np.where(np.abs(y - center[1]) <= half)[0]
    if ix.size < 16 or iy.size < 16:
        return dict(f90=None, beyond=None, cutoff=None)
    sub = np.nan_to_num(np.asarray(ideal[np.ix_(iy, ix)], dtype=np.float64))
    sub = sub - float(sub.mean())
    dx = abs(float(x[1] - x[0])) or 1e-12
    dy = abs(float(y[1] - y[0])) or 1e-12
    power = np.abs(np.fft.fftshift(np.fft.fft2(sub))) ** 2
    fx = np.fft.fftshift(np.fft.fftfreq(sub.shape[1], dx))
    fy = np.fft.fftshift(np.fft.fftfreq(sub.shape[0], dy))
    FX, FY = np.meshgrid(fx, fy)
    fr = np.hypot(FX, FY)
    # 去掉窗口尺度的整体包络，只看结构细节
    mask = fr > 1.0 / (4.0 * half)
    if not np.any(mask) or float(power[mask].sum()) <= 0:
        return dict(f90=None, beyond=None, cutoff=None)
    order = np.argsort(fr[mask])
    f_sorted = fr[mask][order]
    p_sorted = power[mask][order]
    cumulative = np.cumsum(p_sorted)
    idx = int(np.searchsorted(cumulative, 0.9 * cumulative[-1]))
    idx = min(idx, f_sorted.size - 1)
    return dict(f90=float(f_sorted[idx]), beyond=None, cutoff=None)


def _diagnosis(settings, g, info, near, far, ideal_near):
    """解释「一级 vs 理想一级」的差距来自哪里。

    只用可核验的量：照明覆盖率、衍射极限、目标最小结构，外加编码链路自身效率。
    """
    waist = max(float(settings["input_waist_mm"]) * 1e-3, 1e-9)
    wavelength = float(settings["wavelength_nm"]) * 1e-9
    z_near = float(settings["near_distance_mm"]) * 1e-3
    # 有效照明孔径 2w 在 z 处的可分辨尺度，与 MATLAB 记录同口径：λz/w
    limit_m = wavelength * z_near / waist
    half = float(settings["near_plus_half_mm"]) * 1e-3
    bw = _bandwidth(ideal_near, g.near_x, g.near_y, g.near_center, half)
    f90 = bw["f90"]
    # 目标最小结构：90% 能量频率对应的半周期
    feature_m = 0.5 / f90 if f90 else None
    ratio = (limit_m / feature_m) if feature_m else None

    weak = float(info["weak_illumination_energy_fraction"])
    items = []

    if weak > 0.2:
        items.append(dict(
            level="warn" if weak > 0.5 else "info",
            title=("所需复场大部分没被照到" if weak > 0.5 else "所需复场有一部分没被照到"),
            detail=(f"反传得到的 SLM 复场有 {weak * 100:.1f}% 的能量落在入射光照亮区之外"
                    f"（腰斑 {settings['input_waist_mm']} mm），这部分根本送不到相机面；"
                    "实际起作用的只有中间一小块口径，等价于给系统加了光圈。"),
            action=dict(kind="set", key="input_waist_mm", value=1.2,
                        label="用 1.2 mm 试算（只验证编码链路）"),
        ))

    if ratio is not None and ratio > 0.8:
        items.append(dict(
            level="info",
            title="目标结构接近或小于分辨极限",
            detail=(f"照明 2w = {waist * 2e3:.2f} mm、相机面 {z_near * 1e3:.1f} mm，"
                    f"可分辨尺度 λz/w ≈ {limit_m * 1e3:.2f} mm；"
                    f"理想一级的最小结构（90% 能量频率的半周期）≈ {feature_m * 1e3:.2f} mm，"
                    f"只有可分辨尺度的 {1 / ratio:.1f} 倍，"
                    "细环、条纹这类结构会被抹平——这不是编码或数值错误。"),
            action=None,
        ))

    if not items:
        items.append(dict(
            level="ok",
            title="照明与分辨率都不构成限制",
            detail=("照度与带宽都够用。若仍与理想一级差别明显，问题多半在编码方式或尺度参数"
                    "（0/+1 间距、振幅下限、补零倍数），可换编码方式对比。"),
            action=None,
        ))

    return dict(
        diffraction_limit_mm=limit_m * 1e3,
        target_feature_mm=None if feature_m is None else feature_m * 1e3,
        target_f90_per_mm=None if f90 is None else f90 / 1e3,
        structure_ratio=ratio,
        weak_illumination_fraction=weak,
        near_correlation=near["plus"].get("correlation"),
        far_correlation=far["plus"].get("correlation"),
        items=items,
        summary=(f"可分辨尺度 {limit_m * 1e3:.2f} mm"
                 + (f" · 目标最小结构 {feature_m * 1e3:.2f} mm" if feature_m else "")
                 + f" · 弱照明 {weak * 100:.0f}%"),
    )


def _warnings(settings, g, info, near, far):
    out = []
    weak = info["weak_illumination_energy_fraction"]
    if weak > 0.20:
        out.append(f"弱照明区承载了所需复场的 {weak*100:.1f}%：入射腰斑（{settings['input_waist_mm']} mm）"
                   "相对目标口径偏小，这部分能量送不出去。可增大入射腰斑或缩小目标芯径。")
    if info["camera_window_energy_ratio"] < 0.98:
        out.append(f"相机窗口只覆盖目标能量的 {info['camera_window_energy_ratio']*100:.1f}%："
                   "目标被视场截断，请减小 0/+1 间距或增大 pad_factor。")
    if abs(abs(g.far_abcd[1]) - g.far_focal) > 0.01 * g.far_focal:
        out.append(f"远场处于离焦状态（B={g.far_abcd[1]*1e3:.2f} mm vs 焦距 {g.far_focal*1e3:.2f} mm）；"
                   "理想对照仍在焦面，相关系数会随之下降。")
    for name, block in (("近场", near), ("远场", far)):
        r = block["plus"].get("r1e2_mm")
        if r is None:
            out.append(f"{name}一级的 1/e² 半径未测到（窗口内未降到峰值 1/e² 或窗口过小）。")
        c = block["combined"]
        if c.get("roi_overlap"):
            out.append(f"{name}零级与一级评价窗口重叠，能量占比不可直接相加。")
    return out


def _pinned(settings, near, far):
    table = {"near": near, "far": far}
    out = []
    for key_name in ("pinned_metric_a", "pinned_metric_b"):
        key = settings.get(key_name)
        if not key or "." not in key:
            continue
        plane, field = key.split(".", 1)
        block = table.get(plane, {})
        value, label = None, key
        for sub in ("plus", "combined", "zero"):
            if field in block.get(sub, {}):
                value = block[sub][field]
                break
        if value is None:
            value = metrics_mod.flatten_metrics(
                {plane: block}).get(key)
        out.append(dict(key=key, label=_metric_label(key), value=value,
                        unit=_metric_unit(key), digits=4))
    return out


_METRIC_LABELS = {
    "r1e2_mm": "一级 1/e² 半径", "r1e2_x_mm": "一级 1/e² 半径 X",
    "r1e2_y_mm": "一级 1/e² 半径 Y", "offset_mm": "质心偏移（合）",
    "offset_x_mm": "质心偏移 X", "offset_y_mm": "质心偏移 Y",
    "correlation": "强度相关系数", "normalized_rmse": "归一化 RMSE",
    "plus_energy_fraction": "一级能量占比", "zero_energy_fraction": "零级能量占比",
    "zero_plus_peak_ratio": "零/一级峰值比", "d4sigma_x_mm": "D4σ（X）",
    "d4sigma_y_mm": "D4σ（Y）", "r_ee865_mm": "86.5% 包络能量半径",
    "r_ee50_mm": "50% 包络能量半径", "r_ee90_mm": "90% 包络能量半径",
}


def _metric_label(key):
    plane, field = key.split(".", 1)
    return f"{'近场' if plane == 'near' else '远场'} {_METRIC_LABELS.get(field, field)}"


def _metric_unit(key):
    field = key.split(".", 1)[1]
    return "mm" if field.endswith("_mm") else ""


def _write_csv(path, near, far, settings, info):
    rows = [
        ("入射 1/e² 半径 (mm)", settings["input_waist_mm"]),
        ("编码方式", settings["encoding_method"]),
        ("透射率归一化峰值", info["transmission_scale"]),
        ("弱照明能量占比", info["weak_illumination_energy_fraction"]),
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.writer(fh)
        writer.writerow(["plane", "window", "metric", "value"])
        for line, value in rows:
            writer.writerow(["global", "", line, value])
        for plane_name, block in (("near", near), ("far", far)):
            for window in ("zero", "plus", "combined"):
                for key, value in block[window].items():
                    if isinstance(value, (list, bool)) or value is None:
                        continue
                    writer.writerow([plane_name, window, key, value])
