"""LP 模式求解（弱导近似），移植 MATLAB +datasetcgh/prime_mode_cal.m。"""
from __future__ import annotations

import numpy as np
from scipy.optimize import brentq
from scipy.special import jv, kve

_ROOTS_CACHE = {}


def _fzero(f, guess, span=1.2, grow=1.6, tries=12):
    """在 guess 附近找 f 的零点（先扫描找括号，再 brentq）。"""
    a, b = guess - span, guess + span
    fa, fb = f(a), f(b)
    for _ in range(tries):
        if np.isfinite(fa) and np.isfinite(fb) and fa * fb < 0:
            return brentq(f, a, b, xtol=1e-12, rtol=1e-14, maxiter=200)
        span *= grow
        a, b = guess - span, guess + span
        fa, fb = f(a), f(b)
    raise RuntimeError("Bessel 零点求解失败")


def besselj_roots(max_l, max_n):
    key = (max_l, max_n)
    if key in _ROOTS_CACHE:
        return _ROOTS_CACHE[key]
    roots = np.zeros((max_l, max_n))
    for l in range(max_l):
        f = lambda x, l=l: jv(l, x)
        if l == 0:
            roots[0, 0] = _fzero(f, 2.4)
            roots[0, 1] = _fzero(f, 5.5)
        else:
            roots[l, 0] = 0.0
            roots[l, 1] = _fzero(f, l + 1.9 * l ** (1 / 3) + 1)
        for n in range(2, max_n):
            roots[l, n] = _fzero(f, roots[l, n - 1] + 4)
    _ROOTS_CACHE[key] = roots
    return roots


def _characteristic(u, l, V):
    if u <= 0 or u >= V:
        return np.nan
    w = np.sqrt(V ** 2 - u ** 2)
    return u * jv(l + 1, u) / jv(l, u) - w * kve(l + 1, w) / kve(l, w)


def _find_root(l, lower, upper, V):
    scan = np.linspace(lower, upper, 300)
    vals = np.array([_characteristic(u, l, V) for u in scan])
    for k in range(len(scan) - 1):
        a, b = vals[k], vals[k + 1]
        if not (np.isfinite(a) and np.isfinite(b)):
            continue
        if a * b < 0:
            try:
                return brentq(lambda x: _characteristic(x, l, V), scan[k], scan[k + 1],
                              xtol=1e-12, maxiter=200)
            except ValueError:
                continue
    return np.nan


def mode_label(l, m, parity):
    return "LP%d%d%s" % (l, m, "e" if parity == 1 else "o")


def compute_lpmodes(core_radius, NA, wavelength, zone_size, n_grid=600,
                    max_l=6, max_m=6):
    """返回 [(label, field)]，field 为 zone_size×zone_size 网格上的归一化实场。"""
    V = 2 * np.pi / wavelength * core_radius * NA
    roots = besselj_roots(max_l, max_m + 1)
    x = np.linspace(-0.5 * zone_size, 0.5 * zone_size, n_grid)
    y = -x
    XX, YY = np.meshgrid(x, y)
    r = np.hypot(XX, YY)
    phi = np.arctan2(YY, XX)
    in_core = r <= core_radius

    modes = []
    for l in range(max_l):
        for m in range(1, max_m + 1):
            if l == 0:
                upper, lower = roots[0, m - 1], roots[1, m - 1]
            elif l == 1:
                upper, lower = roots[1, m], roots[0, m - 1]
            else:
                upper, lower = roots[l, m], roots[l - 1, m]
            if lower >= V or upper <= 0:
                continue
            lower = max(lower + 1e-7, 1e-7)
            upper = min(upper - 1e-7, V - 1e-7)
            if lower >= upper:
                continue
            u = _find_root(l, lower, upper, V)
            if not np.isfinite(u):
                continue
            w = np.sqrt(V ** 2 - u ** 2)
            radial_core = jv(l, u * r / core_radius)
            # kve 为指数缩放版，比值形式避免 kv 溢出
            ratio = (kve(l, w * r / core_radius) / kve(l, w)) * np.exp(w - w * r / core_radius)
            radial = np.where(in_core, radial_core, jv(l, u) * ratio)
            radial = np.nan_to_num(radial, nan=0.0, posinf=0.0, neginf=0.0)

            even = _normalize(radial * np.cos(l * phi))
            modes.append((mode_label(l, m, 1), even))
            if l != 0:
                odd = _normalize(radial * np.sin(l * phi))
                modes.append((mode_label(l, m, 2), odd))
    return modes


def _normalize(field):
    field = np.nan_to_num(field, nan=0.0, posinf=0.0, neginf=0.0)
    energy = float(np.sum(np.abs(field) ** 2))
    if energy > 0:
        field = field / np.sqrt(energy)
    return field
