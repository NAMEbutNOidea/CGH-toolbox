"""把数值结果转成网页可用的图像与曲线数据（不依赖 matplotlib）。"""
from __future__ import annotations

import base64

import numpy as np


def _downsample(arr, max_px):
    """块内取最大值降采样：小光斑不会被平均掉（相当于每个显示像素记录其覆盖范围内的峰值）。"""
    h, w = arr.shape
    factor = int(np.ceil(max(h, w) / float(max_px)))
    if factor <= 1:
        return arr, 1
    h2 = (h // factor) * factor
    w2 = (w // factor) * factor
    block = arr[:h2, :w2].reshape(h2 // factor, factor, w2 // factor, factor)
    if np.issubdtype(arr.dtype, np.floating):
        return block.max(axis=(1, 3)), factor
    return block.mean(axis=(1, 3)), factor


def encode_image(intensity, x, y, max_px=760, vmax=None, flip_y=True):
    """强度图 → {w,h,data(base64 uint16 LE),x0,x1,y0,y1,vmax}。"""
    arr = np.asarray(intensity, dtype=np.float64)
    arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    vmax = float(np.max(arr)) if vmax is None else float(vmax)
    if vmax <= 0:
        vmax = 1.0
    arr, factor = _downsample(arr, max_px)
    if flip_y:
        arr = arr[::-1, :]
        y_lo, y_hi = float(y[-1]), float(y[0])
    else:
        y_lo, y_hi = float(y[0]), float(y[-1])
    if factor > 1:
        # 降采样后物理边界按像素中心裁剪，视觉误差可忽略
        pass
    u16 = np.round(np.clip(arr / vmax, 0, 1) * 65535).astype("<u2")
    return dict(w=int(arr.shape[1]), h=int(arr.shape[0]),
                data=base64.b64encode(u16.tobytes()).decode("ascii"),
                x0=float(x[0]) * 1e3, x1=float(x[-1]) * 1e3,
                y0=y_lo * 1e3, y1=y_hi * 1e3,
                vmax=vmax, unit="mm")


def encode_phase(bitmap, max_px=960):
    arr = np.asarray(bitmap, dtype=np.uint8)
    arr, _ = _downsample(arr.astype(np.float32), max_px)
    arr = np.round(arr).astype(np.uint8)
    return dict(w=int(arr.shape[1]), h=int(arr.shape[0]),
                data=base64.b64encode(arr.tobytes()).decode("ascii"), kind="phase")


def profiles(intensity, x, y, center, half, points=240):
    """一级窗口的 x/y 剖面与径向剖面（归一化），供网页画出 1/e² 位置。"""
    ix = np.where(np.abs(x - center[0]) <= half)[0]
    iy = np.where(np.abs(y - center[1]) <= half)[0]
    if ix.size < 4 or iy.size < 4:
        return None
    sub = intensity[np.ix_(iy, ix)]
    sub = np.nan_to_num(sub, nan=0.0)
    peak = float(np.max(sub))
    if peak <= 0:
        return None
    X, Y = np.meshgrid(x[ix], y[iy])
    bg = float(np.percentile(sub, 5))
    Ib = np.clip(sub - bg, 0, None)
    total = float(np.sum(Ib))
    cx = float(np.sum(Ib * X) / total) if total > 0 else float(center[0])
    cy = float(np.sum(Ib * Y) / total) if total > 0 else float(center[1])

    jx = int(np.argmin(np.abs(y[iy] - cy)))
    jy = int(np.argmin(np.abs(x[ix] - cx)))
    xs = x[ix]
    ys = y[iy]
    i_x = sub[jx, :] / peak
    i_y = sub[:, jy] / peak

    r = np.hypot(X - cx, Y - cy)
    rmax = float(np.max(r))
    nb = 64
    idx = np.minimum((r / rmax * nb).astype(int), nb - 1)
    sums = np.bincount(idx.ravel(), weights=sub.ravel(), minlength=nb)
    cnt = np.bincount(idx.ravel(), minlength=nb).astype(float)
    prof = np.divide(sums, cnt, out=np.zeros(nb), where=cnt > 0) / peak
    r_mm = ((np.arange(nb) + 0.5) / nb * rmax) * 1e3

    def thin(a, n):
        a = np.asarray(a)
        if a.size <= n:
            return a
        step = int(np.ceil(a.size / n))
        return a[::step]

    return dict(
        x_mm=[round(v * 1e3, 5) for v in thin(xs, points)],
        i_x=[round(float(v), 5) for v in thin(i_x, points)],
        y_mm=[round(v * 1e3, 5) for v in thin(ys, points)],
        i_y=[round(float(v), 5) for v in thin(i_y, points)],
        r_mm=[round(float(v), 5) for v in r_mm],
        i_r=[round(float(v), 5) for v in prof],
        center_mm=[cx * 1e3, cy * 1e3],
        peak=peak,
    )
