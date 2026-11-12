"""复振幅编码：把 SLM 面所需复场写成 8 位相位图。

双相位族（把多余光推离零级，代价是占用 SLM 空间带宽）：
  double_phase_1px    单像素棋盘，多余光推到对角 (±fs/2, ±fs/2)，离零级最远
  double_phase_2px    两列条带（周期 4 px），沿 x 推一级，默认
  double_phase_2px_y  两行条带（周期 4 px），用于纵向分离 0/+1
  double_phase_4px    四列条带（周期 8 px），编码带宽最小、对 SLM 分辨率最宽容
其他解析编码：
  blazed_sinc        闪耀 sinc，一级效率高但零级明显
  type3_sine         正弦型（旧版），仅作历史对照
  phase_only         纯相位、不做振幅补偿，只作为下界对照
迭代编码：
  iterative_gs       Gerchberg-Saxton / IFTA：在 SLM 面与近场之间反复传播，
                     SLM 面施加纯相位约束、一级窗口内施加目标振幅约束

前两种与 MATLAB +datasetcgh/encode_field.m 逐行对应。
"""
from __future__ import annotations

import numpy as np
from scipy.interpolate import PchipInterpolator
from scipy.special import j1

from optics import fft2c, ifft2c, map_field

_LUT_CACHE = {}


def _type3_lut():
    if "type3" not in _LUT_CACHE:
        peak = 1.8411837813406593  # argmax J1
        depth = np.linspace(0, peak, 65537)
        amplitude = j1(depth) / j1(peak)
        _LUT_CACHE["type3"] = PchipInterpolator(amplitude, depth)
    return _LUT_CACHE["type3"]


def _blaze_lut():
    if "blaze" not in _LUT_CACHE:
        depth = np.linspace(0, 1, 65537)
        u = 1 - depth
        amp = np.ones_like(u)
        nz = u != 0
        amp[nz] = np.sin(np.pi * u[nz]) / (np.pi * u[nz])
        amp[0], amp[-1] = 0.0, 1.0
        _LUT_CACHE["blaze"] = PchipInterpolator(amp, depth)
    return _LUT_CACHE["blaze"]


def _strip_pattern(shape, method):
    """双相位族的 ±1 条带符号图；非双相位方法返回 None。

    周期 = strip_width × 2：相邻条带取 ±1，平均后就是所需的 A·exp(iθ)。
    条带越窄，多余光被推得越远（离零级越干净），但占用的空间带宽越大。
    """
    widths = {
        "double_phase_1px": ("both", 1),
        "double_phase_2px": ("x", 2),
        "double_phase_2px_y": ("y", 2),
        "double_phase_4px": ("x", 4),
    }
    spec = widths.get(method)
    if spec is None:
        return None
    axis, width = spec
    ny, nx = shape

    def sign(count):
        idx = np.arange(count, dtype=np.int64) // width
        return 1.0 - 2.0 * (idx % 2)

    if axis in ("x", "both"):
        sx = sign(nx)[None, :]
    if axis in ("y", "both"):
        sy = sign(ny)[:, None]
    if axis == "x":
        return np.broadcast_to(sx, shape).astype(np.float64)
    if axis == "y":
        return np.broadcast_to(sy, shape).astype(np.float64)
    return (sx * sy).astype(np.float64)


def _ifta_phase(g, phase0, near_target, far_target, iterations, windows, plane, progress=None):
    """Gerchberg-Saxton / IFTA：交替投影求「一级窗口内振幅接近目标」的纯相位。

    每个迭代：SLM 面（纯相位约束）--前传--> 近场 --必要时约束近场一级窗口-->
    以近场复场做一次 FFT 到焦面 --必要时约束远场一级窗口--> 回到近场 --反传--> SLM 面取相位。

    plane: near / far / both，决定在哪几个平面施加振幅约束。
    返回 (phase, 诊断 dict)。相关度是「窗口内实际振幅 vs 目标振幅」的皮尔逊相关，
    与指标表里的 intensity 相关系数同源（只是作用在振幅而非强度上）。
    """
    if iterations <= 0 or near_target is None:
        return phase0, dict(iterations=0, corr_initial=None, corr_final=None,
                            corr_trace=[], far_corr_final=None, plane=plane)

    ny, nx = near_target.shape
    near_mask = _window_mask(g.near_x, g.near_y, g.near_center, windows.get("near"))
    far_mask = None
    far_n = int(g.far_fft_size)
    far_factor = g.dx * g.dy / (g.wavelength * g.far_focal)
    far_row0 = (far_n - ny) // 2
    far_col0 = (far_n - nx) // 2
    if plane in ("far", "both") and far_target is not None:
        far_mask = _window_mask(g.far_x, g.far_y, g.far_center, windows.get("far"))
        if far_target.shape != (far_n, far_n):
            far_mask = None

    def _stats(field, target, mask):
        sel = field[mask]
        sel_t = target[mask]
        energy = float(np.sum((sel_t - sel_t.mean()) ** 2))
        gain = float(np.sum(sel * sel_t) / max(float(np.sum(sel_t * sel_t)), 1e-300))
        return _pearson(sel, sel_t, sel_t - sel_t.mean(), max(energy, 1e-300)), gain

    phase = phase0.astype(np.float64).copy()
    buf = np.zeros((g.pad_ny, g.pad_nx), dtype=g.dtype)
    pad_far = None
    trace = []
    far_trace = []
    corr_initial = None

    for step in range(int(iterations)):
        if _cancelled():
            break
        buf[:] = 0
        buf[g.pad_rows, g.pad_cols] = (g.input_amplitude * np.exp(1j * phase)).astype(g.dtype)
        spectrum = fft2c(buf)
        near = ifft2c(spectrum * g.forward_transfer)
        del spectrum

        # 约束前的近场相关 = 上一轮迭代真正达到的水平（约束后必然等于目标，参考价值不大）
        corr_before, _ = _stats(np.abs(near), near_target, near_mask)
        if corr_initial is None:
            corr_initial = corr_before

        # 「交替」按迭代轮次轮换约束平面（一次迭代只约束一个平面，标准多平面 IFTA）
        use_near = plane == "near" or (plane == "both" and step % 2 == 0)
        use_far = far_mask is not None and (plane == "far" or (plane == "both" and step % 2 == 1))

        if use_near and near_mask is not None:
            _, gain = _stats(np.abs(near), near_target, near_mask)
            near[near_mask] = (gain * near_target[near_mask]
                               * np.exp(1j * np.angle(near[near_mask]))).astype(g.dtype)

        far_corr = None
        if use_far:
            if pad_far is None:
                pad_far = np.zeros((far_n, far_n), dtype=g.dtype)
            pad_far[:] = 0
            pad_far[far_row0:far_row0 + ny, far_col0:far_col0 + nx] = near
            far_field = fft2c(pad_far) * far_factor
            far_corr, gain = _stats(np.abs(far_field), far_target, far_mask)
            far_field[far_mask] = (gain * far_target[far_mask]
                                   * np.exp(1j * np.angle(far_field[far_mask])))
            pad_far[:] = ifft2c(far_field / far_factor)
            del far_field
            near = pad_far[far_row0:far_row0 + ny, far_col0:far_col0 + nx].copy()

        trace.append(corr_before)
        if far_corr is not None:
            far_trace.append(far_corr)
        if progress:
            extra = "" if far_corr is None else f"，远场 {far_corr:.4f}"
            progress(f"迭代编码 {step + 1}/{iterations}（近场 {corr_before:.4f}{extra}）")

        spectrum = fft2c(near)
        del near
        back = ifft2c(spectrum * g.backward_transfer)
        del spectrum
        phase = np.angle(back[g.pad_rows, g.pad_cols]).astype(np.float64)
        del back

    del buf
    if pad_far is not None:
        del pad_far
    return phase, dict(iterations=int(len(trace)), corr_initial=corr_initial,
                       corr_final=trace[-1] if trace else None, corr_trace=trace,
                       far_corr_initial=far_trace[0] if far_trace else None,
                       far_corr_final=far_trace[-1] if far_trace else None, plane=plane)


def _window_mask(x, y, center, half):
    if not half or half <= 0:
        return None
    ix = np.abs(np.asarray(x) - center[0]) <= half
    iy = np.abs(np.asarray(y) - center[1]) <= half
    if not ix.any() or not iy.any():
        return None
    return np.ix_(iy, ix)


def _pearson(values, target, target_norm, target_energy):
    v = np.asarray(values, dtype=np.float64)
    v_norm = v - v.mean()
    denom = float(np.sqrt(np.sum(v_norm ** 2) * target_energy))
    if denom <= 0:
        return float("nan")
    return float(np.sum(v_norm * target_norm) / denom)


def _cancelled():
    """迭代编码可能跑几十秒：允许 worker 的取消标志提前打断（独立运行时恒为 False）。"""
    hook = globals().get("CANCEL_HOOK")
    return bool(hook and hook())


def encode(g, target_field, extent, method="double_phase_2px", progress=None,
           iterations=8, windows=None, iterative_plane="both"):
    """返回 (bitmap uint8, info dict, 诊断量)。"""
    if progress:
        progress("反传/映射目标复场到 SLM 面")

    if g.compensate:
        # 完整相机平面目标 → 加载体 → 反传到 SLM 面，再截取孔径
        shifted = map_field(target_field, extent, g.near_center, g.near_x, g.near_y)
        carrier_phase = np.exp(
            1j * 2 * np.pi * (g.carrier_frequency[0] * g.near_x[None, :] +
                              g.carrier_frequency[1] * g.near_y[:, None]))
        padded = (shifted * carrier_phase).astype(g.dtype)
        del shifted, carrier_phase
        spectrum = fft2c(padded)
        del padded
        padded = ifft2c(spectrum * g.backward_transfer)
        del spectrum
        required = np.array(padded[g.pad_rows, g.pad_cols], dtype=g.dtype)
        del padded
        # 诊断：目标是否被相机窗口截断
        centered = map_field(target_field, extent, (0.0, 0.0), g.near_x, g.near_y)
        energy_full = float(np.sum(np.abs(centered) ** 2))
        del centered
        window_ratio = _shifted_energy(target_field, extent, g) / max(energy_full, 1e-300)
    else:
        required = map_field(target_field, extent, (0.0, 0.0), g.x, g.y) * g.carrier
        window_ratio = 1.0

    if progress:
        progress("补偿入射振幅并归一化")
    floor = np.maximum(g.input_amplitude, g.amplitude_floor * float(np.max(g.input_amplitude)))
    transmission = required / floor
    del required
    peak = float(np.max(np.abs(transmission)))
    if not np.isfinite(peak) or peak <= 0:
        raise ValueError("目标在 SLM 孔径内为空（编码后传输率为 0），请检查设计包是否产生有效光场。")
    transmission /= peak
    amplitude = np.clip(np.abs(transmission), 0, 1)
    theta = np.angle(transmission)

    if progress:
        progress(f"相位编码（{method}）")
    method = (method or "double_phase_2px").lower()
    ifta = None
    strips = _strip_pattern(transmission.shape, method)
    if strips is not None:
        target_phase = theta.copy()
        empty = amplitude == 0
        if np.any(empty):
            target_phase[empty] = np.angle(g.carrier[empty])
        phase = np.mod(target_phase + np.arccos(np.clip(amplitude, 0, 1)) * strips, 2 * np.pi)
        del target_phase
    elif method == "blazed_sinc":
        depth = _blaze_lut()(amplitude)
        phase = depth * np.mod(theta + np.pi * (1 - depth), 2 * np.pi)
    elif method == "type3_sine":
        depth = _type3_lut()(amplitude)
        phase = depth * np.sin(theta)
        phase = np.mod(phase - float(np.min(phase)), 2 * np.pi)
    elif method == "phase_only":
        # 不做振幅补偿：相位照抄，振幅信息全部丢弃，只作为「不编码振幅」的下界对照
        phase = np.mod(theta, 2 * np.pi)
    elif method == "iterative_gs":
        # 迭代编码：以解析相位为初值，在 SLM 面（纯相位）与一级窗口（目标振幅）之间交替投影
        carrier_pad = np.exp(
            1j * 2 * np.pi * (g.carrier_frequency[0] * g.near_x[None, :] +
                              g.carrier_frequency[1] * g.near_y[:, None]))
        ideal_near = (map_field(target_field, extent, g.near_center, g.near_x, g.near_y)
                      * carrier_pad).astype(g.dtype)
        del carrier_pad
        near_target = np.abs(ideal_near)
        far_target = np.sqrt(g.far_from_near_field(ideal_near))
        del ideal_near
        phase, ifta = _ifta_phase(g, np.mod(theta, 2 * np.pi), near_target, far_target,
                                  int(iterations or 0), windows or {},
                                  (iterative_plane or "both").lower(), progress)
        del near_target, far_target
    else:
        raise ValueError(f"未知编码方式：{method}")

    # 零级补光：中心圆内把相位压成平场（活塞），这部分光不再被衍射到一级，直接留在零级。
    # 平场的相位取「已编码场的孔径均值」的相位，保证与原有零级同相叠加，
    # 于是零级强度随半径单调上升（否则可能相位相反、越补越暗）。
    zero_fraction = 0.0
    mask = getattr(g, "zero_order_mask", None)
    if mask is not None:
        illum2 = g.input_amplitude.astype(np.float64) ** 2
        total_illum = float(illum2.sum())
        if total_illum > 0:
            zero_fraction = float(illum2[mask].sum() / total_illum)
        amp = g.input_amplitude.astype(np.float64)
        re = float(np.sum(amp * np.cos(phase)))
        im = float(np.sum(amp * np.sin(phase)))
        piston = float(np.arctan2(im, re)) if (re or im) else 0.0
        phase = np.where(mask, piston, phase)

    bitmap = np.round(255 * phase / (2 * np.pi)).astype(np.uint8)
    info = dict(
        method=method,
        transmission_scale=peak,
        weak_illumination_energy_fraction=_weak_fraction(g, transmission),
        camera_window_energy_ratio=window_ratio,
        zero_order_radius_mm=float(getattr(g, "zero_order_radius", 0.0) or 0.0) * 1e3,
        zero_order_illumination_fraction=zero_fraction,
    )
    if ifta is not None:
        info["iterations"] = ifta["iterations"]
        info["iteration_plane"] = ifta.get("plane")
        info["iteration_correlation_initial"] = ifta["corr_initial"]
        info["iteration_correlation_final"] = ifta["corr_final"]
        info["iteration_far_correlation_final"] = ifta.get("far_corr_final")
    return bitmap, info, dict(amplitude=amplitude, phase=phase)


def _shifted_energy(target_field, extent, g):
    shifted = map_field(target_field, extent, g.near_center, g.near_x, g.near_y)
    energy = float(np.sum(np.abs(shifted) ** 2))
    del shifted
    return energy


def _weak_fraction(g, transmission):
    """弱照明区承载的所需复场能量占比（诊断用，MATLAB 的 inputFloorEnergyFraction）。"""
    # transmission 已被除以 peak，但比例关系不变
    weak = g.input_amplitude < g.amplitude_floor
    total = float(np.sum(np.abs(transmission) ** 2))
    if total <= 0:
        return 0.0
    return float(np.sum(np.abs(transmission[weak]) ** 2) / total)
