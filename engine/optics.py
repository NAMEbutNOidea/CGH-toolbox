"""光路几何、网格与标量传播（对齐 MATLAB +datasetcgh/prepare_context.m 与 camera_context.m）。

单位统一为 SI（米、弧度）；对外输出时才换成 mm。
行方向约定与 MATLAB 一致：数组第 0 行对应最大的 y，随行号增加 y 减小。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy import fft as sfft
from scipy.interpolate import CubicSpline

WORKERS = -1  # 交给 scipy/MKL 用满核


def fft2c(a):
    return sfft.fftshift(sfft.fft2(sfft.ifftshift(a), workers=WORKERS, overwrite_x=True))


def ifft2c(a):
    return sfft.fftshift(sfft.ifft2(sfft.ifftshift(a), workers=WORKERS, overwrite_x=True))


def centered_fft(a, n):
    """把 field 放进 n×n 中央后做中心化 FFT（对齐 camera_planes.m 的 centered_fft）。"""
    out = np.zeros((n, n), dtype=a.dtype)
    r0 = (n - a.shape[0]) // 2
    c0 = (n - a.shape[1]) // 2
    out[r0:r0 + a.shape[0], c0:c0 + a.shape[1]] = a
    return fft2c(out)


def map_field(field, extent, shift, xq, yq):
    """把设计包复场按物理口径 extent 放到相机坐标网格上（中心平移到 shift）。

    约定与 MATLAB 一致：数组第 0 行对应 +y，第 0 列对应 −x（`y = -linspace(...)`）。
    extent=(ex, ey) 为场覆盖的物理宽高（米）。三次样条可分离插值，
    等价于 MATLAB `interp2(..., 'cubic', 0)`。
    """
    nr, nc = field.shape
    ex, ey = extent
    sx = np.linspace(-ex / 2, ex / 2, nc) + shift[0]
    sy = -np.linspace(-ey / 2, ey / 2, nr) + shift[1]  # 递减：第 0 行 = +y
    xq = np.asarray(xq, dtype=float)
    yq = np.asarray(yq, dtype=float)

    def interp_rows(data):
        spline = CubicSpline(sx, data, axis=1, extrapolate=False)
        out = spline(xq)
        return np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0)

    def interp_cols(data):
        spline = CubicSpline(sy[::-1], data[::-1, :], axis=0, extrapolate=False)
        out = spline(yq)
        return np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0)

    real = interp_cols(interp_rows(field.real))
    imag = interp_cols(interp_rows(field.imag))
    out = real + 1j * imag
    out[~np.isfinite(out)] = 0
    return out


@dataclass
class Geometry:
    # 输入（SI）
    wavelength: float
    nx: int
    ny: int
    dx: float
    dy: float
    input_waist: float
    near_distance: float
    far_focal: float
    slm_to_lens: float
    far_camera: float
    carrier_far_xy: tuple
    pad_factor: int
    far_fft_size: int
    amplitude_floor: float
    compensate: bool
    precision: str = "double"
    design_extent: float = 26e-3
    # 零级补光：SLM 中心半径内的相位压成平场，这部分光不参与一级、直接留在零级
    zero_order_radius: float = 0.0
    dtype: np.dtype = field(init=False)

    def __post_init__(self):
        self.dtype = np.complex64 if self.precision == "single" else np.complex128
        x = ((np.arange(self.nx) - (self.nx - 1) / 2) * self.dx)
        y = ((self.ny - 1) / 2 - np.arange(self.ny)) * self.dy  # 行 0 = +y
        self.x = x
        self.y = y
        self.X, self.Y = np.meshgrid(x, y)
        self.input_amplitude = np.exp(-(self.X ** 2 + self.Y ** 2) / self.input_waist ** 2)
        if self.zero_order_radius and self.zero_order_radius > 0:
            self.zero_order_mask = (self.X ** 2 + self.Y ** 2) <= self.zero_order_radius ** 2
        else:
            self.zero_order_mask = None

        # 载波与一级位置
        self.carrier_frequency = np.array(self.carrier_far_xy) / (self.wavelength * self.far_focal)
        direction = self.wavelength * self.carrier_frequency
        norm2 = float(np.sum(direction ** 2))
        if norm2 >= 1:
            raise ValueError("载波不满足传播条件（间距 × 波长 / 焦距 ≥ 1），请减小 0/+1 间距。")
        self.near_center = self.near_distance * direction / math.sqrt(1 - norm2)
        self.carrier = np.exp(1j * 2 * np.pi *
                              (self.carrier_frequency[0] * self.X + self.carrier_frequency[1] * self.Y))
        if abs(self.carrier_frequency[0]) >= 1 / (2 * self.dx) or \
                abs(self.carrier_frequency[1]) >= 1 / (2 * self.dy):
            raise ValueError("载波频率超过 SLM 的 Nyquist 频率：请减小 0/+1 间距或增大像素间距。")

        # 传播网格（补零）
        self.pad_nx = int(self.pad_factor) * self.nx
        self.pad_ny = int(self.pad_factor) * self.ny
        c0 = (self.pad_nx - self.nx) // 2
        r0 = (self.pad_ny - self.ny) // 2
        self.pad_cols = slice(c0, c0 + self.nx)
        self.pad_rows = slice(r0, r0 + self.ny)
        self.near_x = ((np.arange(self.pad_nx) - c0) - (self.nx - 1) / 2) * self.dx
        self.near_y = ((self.ny - 1) / 2 - (np.arange(self.pad_ny) - r0)) * self.dy

        # 远场 Collins 矩阵 P(d2)·L(f)·P(d1)
        d1, d2, f = self.slm_to_lens, self.far_camera, self.far_focal
        self.far_abcd = (1 - d2 / f, d1 + d2 - d1 * d2 / f, -1 / f, 1 - d1 / f)
        if self.far_abcd[1] <= 0:
            raise ValueError("当前几何下 Collins 矩阵 B 非正，FFT 采样器不适用（成像是另一类采样）。")
        self.far_center = self.wavelength * self.far_abcd[1] * self.carrier_frequency
        self.far_input_chirp = np.exp(
            1j * np.pi * self.far_abcd[0] / (self.wavelength * self.far_abcd[1]) *
            (self.X ** 2 + self.Y ** 2)).astype(self.dtype)

        n = int(self.far_fft_size)
        if n < max(self.pad_nx, self.pad_ny):
            raise ValueError(
                f"远场 FFT 尺寸 {n} 小于补零网格 {max(self.pad_nx, self.pad_ny)}，"
                "远场视场会丢光；请增大 far_fft_size 或减小 pad_factor。")
        self.far_x = (self.wavelength * self.far_abcd[1] *
                      (np.arange(n) - n // 2) / (n * self.dx))
        # SLM 行朝负 y 方向，傅里叶 y 必须取反
        self.far_y = -(self.wavelength * self.far_abcd[1] *
                       (np.arange(n) - n // 2) / (n * self.dy))
        self.far_ideal_scale = self.far_focal / self.far_abcd[1]

        self._backward_transfer: Optional[np.ndarray] = None
        self._forward_transfer: Optional[np.ndarray] = None

    # ---------------- 传递函数 ----------------
    def _transverse(self):
        n_x, n_y = self.pad_nx, self.pad_ny
        fx = (np.arange(n_x) - n_x // 2) / (n_x * self.dx)
        fy = (np.arange(n_y) - n_y // 2) / (n_y * self.dy)
        FX, FY = np.meshgrid(fx, fy)
        lam = self.wavelength
        return (lam * FX) ** 2 + (lam * FY) ** 2

    @property
    def backward_transfer(self):
        if self._backward_transfer is None:
            t = self._transverse()
            root = np.sqrt(np.maximum(0, 1 - t))
            delta = -t / (root + 1)
            h = np.exp(-1j * 2 * np.pi / self.wavelength * self.near_distance * delta)
            h[t >= 1] = 0
            self._backward_transfer = h.astype(self.dtype)
            del t, root, delta, h
        return self._backward_transfer

    @property
    def forward_transfer(self):
        if self._forward_transfer is None:
            t = self._transverse()
            root = np.sqrt(np.maximum(0, 1 - t))
            delta = -t / (1 + root)
            h = np.exp(1j * 2 * np.pi / self.wavelength * self.near_distance * delta)
            h[t >= 1] = 0
            self._forward_transfer = h.astype(self.dtype)
        return self._forward_transfer

    # ---------------- 传播 ----------------
    def padded(self, field):
        out = np.zeros((self.pad_ny, self.pad_nx), dtype=self.dtype)
        out[self.pad_rows, self.pad_cols] = field
        return out

    def propagate_near(self, slm_field):
        """SLM 面复场 → 近场平面强度（补零角谱）。"""
        padded = self.padded(slm_field)
        spectrum = fft2c(padded)
        padded = ifft2c(spectrum * self.forward_transfer)
        return np.abs(padded) ** 2, padded

    def propagate_far(self, slm_field):
        """Collins 模型：SLM 面复场 → 远场相机强度。"""
        factor = self.dx * self.dy / (self.wavelength * self.far_abcd[1])
        spectrum = centered_fft(slm_field * self.far_input_chirp, int(self.far_fft_size))
        return np.abs(factor * spectrum) ** 2

    def far_from_near_field(self, near_field):
        """理想远场：对近场复场做同尺寸中心化 FFT（对齐 camera_planes.m 的 idealFar）。"""
        factor = self.dx * self.dy / (self.wavelength * self.far_focal)
        spectrum = centered_fft(near_field, int(self.far_fft_size))
        return np.abs(factor * spectrum) ** 2

    # ---------------- 派生量 ----------------
    def summary(self):
        return dict(
            wavelength_nm=self.wavelength * 1e9,
            dx_um=self.dx * 1e6, dy_um=self.dy * 1e6,
            near_center_mm=[self.near_center[0] * 1e3, self.near_center[1] * 1e3],
            far_center_mm=[self.far_center[0] * 1e3, self.far_center[1] * 1e3],
            near_distance_mm=self.near_distance * 1e3,
            far_abcd=[float(v) for v in self.far_abcd],
            carrier_freq_per_mm=[self.carrier_frequency[0] / 1e3, self.carrier_frequency[1] / 1e3],
            near_span_mm=[self.pad_nx * self.dx * 1e3, self.pad_ny * self.dy * 1e3],
            far_span_mm=[int(self.far_fft_size) * self.wavelength * self.far_abcd[1] / self.dx / int(self.far_fft_size) * 1e3,
                         int(self.far_fft_size) * self.wavelength * self.far_abcd[1] / self.dy / int(self.far_fft_size) * 1e3],
        )


def geometry_from_settings(settings, quality="full"):
    scale = 0.5 if quality == "fast" else 1.0
    nx = max(128, int(round(settings["slm_nx"] * scale / 2)) * 2)
    ny = max(128, int(round(settings["slm_ny"] * scale / 2)) * 2)
    fft_size = int(settings["far_fft_size"] * scale)
    fft_size = max(1024, int(round(fft_size / 1024)) * 1024)
    precision = "single" if quality == "fast" else settings["precision"]
    return Geometry(
        wavelength=settings["wavelength_nm"] * 1e-9,
        nx=nx, ny=ny,
        dx=settings["slm_size_x_mm"] * 1e-3 / nx,
        dy=settings["slm_size_y_mm"] * 1e-3 / ny,
        input_waist=settings["input_waist_mm"] * 1e-3,
        near_distance=settings["near_distance_mm"] * 1e-3,
        far_focal=settings["far_focal_mm"] * 1e-3,
        slm_to_lens=settings["slm_to_lens_mm"] * 1e-3,
        far_camera=settings["far_camera_mm"] * 1e-3,
        carrier_far_xy=(settings["carrier_far_x_mm"] * 1e-3, settings["carrier_far_y_mm"] * 1e-3),
        pad_factor=int(settings["pad_factor"]),
        far_fft_size=fft_size,
        amplitude_floor=settings["amplitude_floor"],
        compensate=bool(settings["compensate_propagation"]),
        precision=precision,
        design_extent=settings["design_extent_mm"] * 1e-3,
        zero_order_radius=float(settings.get("zero_order_radius_mm") or 0.0) * 1e-3,
    )
