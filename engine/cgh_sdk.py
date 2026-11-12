"""设计包用的函数库（SDK）。

设计包里 `import cgh_sdk as sdk` 即可使用这些函数，不必重复实现常用光场。
所有坐标单位为米，网格约定：`y` 随行号增加而减小（与相机图像一致，第 0 行在最上方）。
返回的复场形状为 (ny, nx)，只需保证有限值，不需要自行归一化。
"""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np

import lpmodes as _lpmodes


# ---------------------------------------------------------------------------
# 网格
# ---------------------------------------------------------------------------
def grid(nx=600, ny=None, extent_m=25e-3):
    """生成等间距网格。extent_m 为标量（正方形）或 (ex, ey)。"""
    ny = nx if ny is None else ny
    if np.isscalar(extent_m):
        ex = ey = float(extent_m)
    else:
        ex, ey = (float(extent_m[0]), float(extent_m[1]))
    x1 = np.linspace(-ex / 2, ex / 2, int(nx))
    y1 = -np.linspace(-ey / 2, ey / 2, int(ny))
    X, Y = np.meshgrid(x1, y1)
    return SimpleNamespace(x=X, y=Y, x1=x1, y1=y1, nx=int(nx), ny=int(ny), extent_m=(ex, ey))


def radial(x, y):
    return np.hypot(x, y)


# ---------------------------------------------------------------------------
# 常用振幅形状
# ---------------------------------------------------------------------------
def gaussian(x, y, w):
    """振幅高斯：exp(-r²/w²)，w 为强度 1/e² 半径。"""
    return np.exp(-(x ** 2 + y ** 2) / w ** 2)


def supergaussian(x, y, w, order=4):
    return np.exp(-((x ** 2 + y ** 2) / w ** 2) ** (order / 2))


def disk(x, y, radius, soft=0.0):
    """硬边圆孔；soft>0 时用 tanh 软化边缘（单位：米）。"""
    r = np.hypot(x, y)
    if soft <= 0:
        return (r <= radius).astype(float)
    return 0.5 * (1 - np.tanh((r - radius) / soft))


def ring(x, y, radius, width):
    r = np.hypot(x, y)
    return np.exp(-((r - radius) / width) ** 2)


def rect(x, y, half_x, half_y):
    return ((np.abs(x) <= half_x) & (np.abs(y) <= half_y)).astype(float)


# ---------------------------------------------------------------------------
# 相位
# ---------------------------------------------------------------------------
def vortex(x, y, charge=1):
    return np.exp(1j * charge * np.arctan2(y, x))


def tilt(x, y, fx, fy):
    """线性相位（空间频率，单位 1/m）。"""
    return np.exp(1j * 2 * np.pi * (fx * x + fy * y))


def lens(x, y, focal, wavelength):
    return np.exp(-1j * np.pi / (wavelength * focal) * (x ** 2 + y ** 2))


def normalize(field):
    """按峰值幅度归一到 1（不改变相位分布）。"""
    peak = float(np.max(np.abs(field)))
    return field / peak if peak > 0 else field


def normalize_energy(field):
    energy = float(np.sum(np.abs(field) ** 2))
    return field / np.sqrt(energy) if energy > 0 else field


# ---------------------------------------------------------------------------
# LP 模式
# ---------------------------------------------------------------------------
def lp_modes(core_radius=5e-6, NA=0.10, wavelength=632.8e-9, zone_size=100e-6,
             n_grid=600, max_l=6, max_m=6):
    """返回 OrderedDict 风格的 {label: field}，可直接按名字取用。"""
    return dict(_lpmodes.compute_lpmodes(core_radius, NA, wavelength, zone_size,
                                         n_grid, max_l, max_m))


def combo(modes, weights, phases=None, weight_type="amplitude"):
    """按标签表相干叠加：E = Σ aₖ·exp(iφₖ)·ψₖ。

    modes 为 {label: field}；weights/phases 为与标签顺序对应的列表；
    weight_type='power' 时权重先开平方再归一化。
    """
    if isinstance(modes, dict):
        labels = list(modes.keys())
        fields = [modes[k] for k in labels]
    else:
        labels = [m[0] for m in modes]
        fields = [m[1] for m in modes]
    weights = np.asarray(weights, dtype=float).ravel()
    if weights.size != len(fields):
        raise ValueError(f"权重个数 {weights.size} 与模式个数 {len(fields)} 不一致（模式：{labels}）")
    if phases is None:
        phases = np.zeros_like(weights)
    phases = np.asarray(phases, dtype=float).ravel()
    if weight_type == "power":
        power = np.clip(weights, 0, None)
        if power.sum() <= 0:
            raise ValueError("功率权重全为 0")
        amps = np.sqrt(power / power.sum())
    else:
        if not np.any(weights):
            raise ValueError("振幅权重全为 0")
        amps = weights / np.sqrt(np.sum(weights ** 2))
    field = np.zeros_like(fields[0], dtype=complex)
    for a, ph, f in zip(amps, phases, fields):
        field += a * np.exp(1j * ph) * f
    return field


def sample_into(field, extent_m, target_grid):
    """把 field（覆盖 extent_m 口径）双线性采到 target_grid 上（供自定义口径用）。"""
    from optics import map_field
    return map_field(field, extent_m, (0.0, 0.0), target_grid.x1, target_grid.y1)


# ---------------------------------------------------------------------------
# 图像型目标
# ---------------------------------------------------------------------------
def image_field(path, extent_m=None, invert=False, channel="gray", blur_m=None,
                pixel_m=None):
    """读取 PNG/BMP 灰度图作为振幅掩模。

    extent_m 给定时把图像映射到该物理口径；blur_m 为高斯模糊尺度；
    pixel_m 指定像素对应的物理尺寸（与 extent_m 二选一）。
    """
    img = _read_image(path)
    amp = img.astype(float)
    if invert:
        amp = 1.0 - amp
    amp = amp - amp.min()
    peak = amp.max()
    if peak > 0:
        amp = amp / peak
    if pixel_m:
        extent_m = (amp.shape[1] * pixel_m, amp.shape[0] * pixel_m)
    if blur_m:
        from scipy.ndimage import gaussian_filter
        sigma = blur_m / (extent_m[0] / (amp.shape[1] - 1))
        amp = gaussian_filter(amp, sigma)
    return amp, extent_m


def _read_image(path):
    try:
        from matplotlib.image import imread
        data = imread(path)
    except Exception as exc:  # pragma: no cover - 依赖环境
        raise RuntimeError(f"无法读取图像 {path}：{exc}") from exc
    data = np.asarray(data)
    if data.ndim == 3:
        data = data[..., :3].mean(axis=2)
    if data.dtype.kind in "ui":
        data = data.astype(float) / max(np.iinfo(data.dtype).max, 1)
    return data
