"""基本光斑设计包：高斯 / 环 / 平顶 / 涡旋。

用来快速验证整条链路与比较编码方式，也示范"不依赖 LP 求解"的自定义目标怎么写。
"""
import numpy as np

import cgh_sdk as sdk


def target_field(p, ctx):
    aperture = float(p["aperture_mm"]) * 1e-3
    g = ctx.grid(nx=720, ny=720, extent_m=aperture)
    x, y = g.x, g.y

    shape = str(p["shape"]).lower()
    if shape == "gauss":
        amp = sdk.gaussian(x, y, float(p["waist_mm"]) * 1e-3)
        field = amp.astype(complex)
    elif shape == "tophat":
        amp = sdk.disk(x, y, float(p["ring_radius_mm"]) * 1e-3, soft=aperture / 720)
        field = amp.astype(complex)
    elif shape == "ring":
        amp = sdk.ring(x, y, float(p["ring_radius_mm"]) * 1e-3,
                       float(p["ring_width_mm"]) * 1e-3)
        field = amp.astype(complex)
    elif shape == "vortex":
        amp = sdk.ring(x, y, float(p["ring_radius_mm"]) * 1e-3,
                       float(p["ring_width_mm"]) * 1e-3)
        field = amp * sdk.vortex(x, y, int(p["charge"]))
    else:
        raise ValueError(f"未知形状 {shape}；可选 gauss / tophat / ring / vortex")

    # 用软边圆窗限制口径，避免 720×720 网格的方形边界进入编码
    field = field * sdk.disk(x, y, aperture * 0.48, soft=aperture / 120)
    return {"field": field, "extent_m": (aperture, aperture)}
