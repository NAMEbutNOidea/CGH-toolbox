"""LP 模式叠加设计包。

target_field(params, ctx) 返回相机平面（拆下 L2 的近场）上的目标复场，
场在 zone_size 口径内计算，再按 target_core_diameter 线性映射到物理尺寸。
"""
import numpy as np

import cgh_sdk as sdk


def target_field(p, ctx):
    names = [str(n).strip() for n in p["mode_names"] if str(n).strip()]
    weights = np.asarray(p["mode_weights"], dtype=float).ravel()
    phases = np.asarray(p["mode_phases"], dtype=float).ravel()

    if weights.size != len(names):
        raise ValueError(
            f"振幅权重有 {weights.size} 个，模式列表有 {len(names)} 个（{', '.join(names)}）；"
            "请让两者个数一致，多余的权重会被忽略。")
    if phases.size < len(names):
        phases = np.pad(phases, (0, len(names) - phases.size))
    phases = phases[:len(names)]

    core_radius = float(p["fiber_core_um"]) * 1e-6
    zone_size = float(p["zone_size_um"]) * 1e-6
    modes = sdk.lp_modes(core_radius=core_radius,
                         NA=float(p["fiber_na"]),
                         wavelength=float(p["mode_basis_nm"]) * 1e-9,
                         zone_size=zone_size,
                         n_grid=int(p["grid_n"]))

    missing = [n for n in names if n not in modes]
    if missing:
        raise ValueError(
            f"当前光纤参数不支持模式 {', '.join(missing)}；可用模式：{', '.join(modes)}。"
            "请增大 NA 或纤芯半径，或修改模式列表。")

    selected = {n: modes[n] for n in names}
    field = sdk.combo(selected, weights, phases, p["weight_type"])

    # 模式窗口 → 相机平面：纤芯直径映射到 target_core_diameter
    scale = ctx.target_core_diameter / (2 * core_radius)
    extent = zone_size * scale
    return {"field": field, "extent_m": (extent, extent)}
