"""设计包模板。

复制本目录为 designs/<你的包名>/，改 manifest.json 与下面的 target_field 即可。
整个流程只有这一步需要写代码：编码、传播、指标、出图都由引擎负责。

约定
----
* 坐标单位：米。`ctx.grid(nx, ny, extent_m)` 返回的 x/y 是 meshgrid，
  第 0 行对应 +y，第 0 列对应 −x（与相机图像、MATLAB 的 meshgrid 一致）。
* 返回值：{"field": 复数二维数组, "extent_m": (ex, ey)}，
  extent_m 是 field 覆盖的物理宽高；引擎会把它平移到一级位置并按三次插值重采样。
* 相位是物理量：只写"目标平面上的复场"，不要自己加载波、不要自己反传到 SLM。
"""
import numpy as np

import cgh_sdk as sdk


def target_field(p, ctx):
    waist = float(p["example_waist_mm"]) * 1e-3
    extent = 2.5e-3  # 目标覆盖 2.5 mm

    g = ctx.grid(nx=720, ny=720, extent_m=extent)
    amplitude = sdk.gaussian(g.x, g.y, waist)
    field = amplitude.astype(complex)

    return {"field": field, "extent_m": (extent, extent)}
