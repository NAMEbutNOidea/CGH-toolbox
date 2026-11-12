"""光斑指标：1/e² 半径、D4σ、质心与偏移、相关系数、归一化 RMSE、能量占比。"""
from __future__ import annotations

import numpy as np


def _crop(arr, x, y, center, half, plane_name):
    ix = np.where(np.abs(x - center[0]) <= half)[0]
    iy = np.where(np.abs(y - center[1]) <= half)[0]
    if ix.size < 5 or iy.size < 5:
        raise ValueError(
            f"{plane_name}评价窗口超出计算视场或采样过稀：请减小窗口半宽，或增大 pad_factor / far_fft_size。")
    return arr[np.ix_(iy, ix)], x[ix], y[iy]


def _crossing(distance, profile, peak):
    """从峰值向外找 I=peak/e² 的交点半径（线性内插）。"""
    level = peak / np.e ** 2
    if peak <= 0:
        return float("nan")
    if profile[-1] > level:
        return float("nan")  # 窗口内未降到 1/e²，窗口偏小
    for k in range(1, len(profile)):
        if profile[k] <= level < profile[k - 1]:
            lo, hi = profile[k - 1], profile[k]
            t = (lo - level) / (lo - hi) if lo != hi else 0.5
            return float(distance[k - 1] + t * (distance[k] - distance[k - 1]))
    return float("nan")


def spot_stats(intensity, x, y, center):
    """单窗口光斑形态统计。x/y 为 1D 物理坐标（米）。"""
    I = np.asarray(intensity, dtype=float)
    if not np.all(np.isfinite(I)):
        I = np.nan_to_num(I, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(I))
    bg = float(np.percentile(I, 5))
    Ib = np.clip(I - bg, 0, None)
    total = float(np.sum(Ib))
    X, Y = np.meshgrid(x, y)
    if total <= 0 or peak <= 0:
        return dict(r1e2_mm=None, r1e2_x_mm=None, r1e2_y_mm=None,
                    d4sigma_x_mm=None, d4sigma_y_mm=None,
                    centroid_x_mm=float(center[0] * 1e3), centroid_y_mm=float(center[1] * 1e3),
                    offset_x_mm=None, offset_y_mm=None, offset_mm=None, offset_px=None,
                    peak=peak, valid=False, note="窗口内没有有效强度")
    cx = float(np.sum(Ib * X) / total)
    cy = float(np.sum(Ib * Y) / total)
    sx = float(np.sqrt(np.sum(Ib * (X - cx) ** 2) / total))
    sy = float(np.sqrt(np.sum(Ib * (Y - cy) ** 2) / total))

    # 径向平均剖面 → 1/e² 半径
    r = np.hypot(X - cx, Y - cy)
    rmax = float(np.max(r))
    nbins = 96
    idx = np.minimum((r / rmax * nbins).astype(int), nbins - 1)
    sums = np.bincount(idx.ravel(), weights=I.ravel(), minlength=nbins)
    counts = np.bincount(idx.ravel(), minlength=nbins).astype(float)
    prof = np.divide(sums, counts, out=np.zeros(nbins), where=counts > 0)
    rc = (np.arange(nbins) + 0.5) / nbins * rmax
    r1e2 = _crossing(rc, prof, peak)

    # 轴向剖面 → 分轴 1/e² 半径
    jx = int(np.argmin(np.abs(y - cy)))
    jy = int(np.argmin(np.abs(x - cx)))
    dx_axis = np.abs(x - cx)
    dy_axis = np.abs(y - cy)
    order_x = np.argsort(dx_axis)
    order_y = np.argsort(dy_axis)
    r1e2_x = _crossing(dx_axis[order_x], I[jx, :][order_x], peak)
    r1e2_y = _crossing(dy_axis[order_y], I[:, jy][order_y], peak)

    off = np.hypot(cx - center[0], cy - center[1])
    r_ee = _encircled_energy(r, I, (0.865, 0.5, 0.9))
    return dict(
        r1e2_mm=None if not np.isfinite(r1e2) else r1e2 * 1e3,
        r1e2_x_mm=None if not np.isfinite(r1e2_x) else r1e2_x * 1e3,
        r1e2_y_mm=None if not np.isfinite(r1e2_y) else r1e2_y * 1e3,
        r_ee865_mm=r_ee[0],
        r_ee50_mm=r_ee[1],
        r_ee90_mm=r_ee[2],
        d4sigma_x_mm=4 * sx * 1e3,
        d4sigma_y_mm=4 * sy * 1e3,
        centroid_x_mm=cx * 1e3,
        centroid_y_mm=cy * 1e3,
        offset_x_mm=(cx - center[0]) * 1e3,
        offset_y_mm=(cy - center[1]) * 1e3,
        offset_mm=off * 1e3,
        offset_px=[(cx - center[0]) / float(np.abs(x[1] - x[0])),
                   (cy - center[1]) / float(np.abs(y[1] - y[0]))],
        peak=peak,
        valid=True,
        note="",
    )


def _encircled_energy(r, I, fractions):
    """按半径排序积分，返回达到给定能量分数时的半径（mm）。对多瓣/环形光斑比 1/e² 更稳健。"""
    flat_r = r.ravel()
    flat_i = np.clip(I.ravel(), 0, None)
    order = np.argsort(flat_r)
    rs = flat_r[order]
    cum = np.cumsum(flat_i[order])
    total = cum[-1] if cum.size else 0.0
    out = []
    for frac in fractions:
        if total <= 0:
            out.append(None)
            continue
        idx = int(np.searchsorted(cum, frac * total))
        idx = min(idx, rs.size - 1)
        out.append(float(rs[idx]) * 1e3)
    return out


def _corr(a, b):
    a = a.ravel().astype(float)
    b = b.ravel().astype(float)
    ac = a - a.mean()
    bc = b - b.mean()
    den = np.sqrt(np.sum(ac ** 2) * np.sum(bc ** 2))
    return float(np.sum(ac * bc) / den) if den > 0 else None


def plane_metrics(intensity, ideal_plus, x, y, center, zero_half, plus_half,
                  plane_name, slm_power=None):
    zero_roi, zx, zy = _crop(intensity, x, y, (0.0, 0.0), zero_half, plane_name + "零级")
    plus_roi, px, py = _crop(intensity, x, y, center, plus_half, plane_name + "一级")
    zero = spot_stats(zero_roi, zx, zy, (0.0, 0.0))
    plus = spot_stats(plus_roi, px, py, center)

    corr = rmse = None
    if ideal_plus is not None:
        ideal_roi, _, _ = _crop(ideal_plus, x, y, center, plus_half, plane_name + "理想")
        corr = _corr(plus_roi, ideal_roi)
        a = plus_roi / max(float(np.max(plus_roi)), np.finfo(float).tiny)
        b = ideal_roi / max(float(np.max(ideal_roi)), np.finfo(float).tiny)
        rmse = float(np.sqrt(np.mean((a - b) ** 2)))
    plus.update(correlation=corr, normalized_rmse=rmse)

    total = float(np.sum(intensity))
    zero_energy = float(np.sum(zero_roi))
    plus_energy = float(np.sum(plus_roi))
    cross = dict(
        zero_energy_fraction=zero_energy / total if total > 0 else None,
        plus_energy_fraction=plus_energy / total if total > 0 else None,
        zero_plus_peak_ratio=(zero["peak"] / plus["peak"]) if plus["peak"] else None,
        roi_overlap=bool(np.all(np.abs(center) < zero_half + plus_half)),
        plus_center_mm=[center[0] * 1e3, center[1] * 1e3],
        total_power_relative_to_slm=None,
    )
    if slm_power:
        dx = abs(float(x[1] - x[0]))
        dy = abs(float(y[1] - y[0]))
        cross["total_power_relative_to_slm"] = total * dx * dy / slm_power
    return dict(zero=zero, plus=plus, combined=cross)


def flatten_metrics(metrics):
    """把 {near:{zero,plus,combined}, far:{...}} 压成 {near.r1e2_mm: ...} 便于扫描取分。"""
    out = {}
    for plane, blocks in metrics.items():
        for block, values in blocks.items():
            if not isinstance(values, dict):
                continue
            for key, value in values.items():
                if isinstance(value, (int, float)) and value is not None:
                    out[f"{plane}.{key}"] = float(value)
    return out


def score_of(flat, metric):
    if metric == "composite":
        far_corr = flat.get("far.correlation")
        near_corr = flat.get("near.correlation")
        far_rmse = flat.get("far.normalized_rmse")
        if far_corr is None:
            return None
        near_corr = near_corr if near_corr is not None else far_corr
        far_rmse = far_rmse if far_rmse is not None else 0.0
        return 0.5 * far_corr + 0.3 * near_corr + 0.2 * (1 - far_rmse)
    return flat.get(metric)
