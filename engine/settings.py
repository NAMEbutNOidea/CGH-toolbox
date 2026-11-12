"""参数 schema 与默认值。

本文件是参数的唯一权威定义：网页参数面板、校验、扫描、优化都从这里读取。
新增参数只需在 SCHEMA 中加一条，并在 pipeline 里消费它。

组织方式（2026-11 重构）
------------------------
每个参数都带一个 role，用来回答「这个值我到底该不该动」：

  device      装置常量：换硬件才改（波长、SLM 像素、各段距离、焦距）
  calibration 标定项：一次校准的实测值（入射腰斑、目标芯径映射），改动等于改标定
  design      设计旋钮：日常真正要调的（编码方式、0/+1 间距、零级补光）
  measure     评价定义：四个窗口半宽，改了指标就不可比
  numeric     数值/输出：补零、FFT 尺寸、精度、保存 BMP
  display     显示：gamma、配色、卡片指标

面板按「组 → 角色」两级展示，装置常量默认折叠在上层，避免一堆不该动的值淹没旋钮。
dependsOn 用来表达「只在某个取值下生效」，前端会把不满足条件的控件灰掉并给提示。
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path

GROUP_ORDER = [
    "SLM 与照明",
    "光路几何",
    "载波与级次",
    "编码",
    "评价窗口",
    "计算与输出",
    "显示与标注",
]

# ---------------------------------------------------------------------------
# 角色（前端按这个顺序在组内分小节）
# ---------------------------------------------------------------------------
ROLE_ORDER = ["design", "calibration", "device", "measure", "numeric", "output", "display"]

ROLES = {
    "design": dict(label="设计旋钮", hint="日常调这些", tone="accent"),
    "calibration": dict(label="标定项", hint="实测校准值，慎动"),
    "device": dict(label="装置常量", hint="换硬件才改"),
    "measure": dict(label="评价定义", hint="改了就不可比"),
    "numeric": dict(label="数值", hint="精度/速度"),
    "output": dict(label="输出", hint="产物文件"),
    "display": dict(label="显示", hint="仅网页"),
}

# ---------------------------------------------------------------------------
# 参数定义
# ---------------------------------------------------------------------------
SCHEMA = [
    # ================= SLM 与照明 =================
    dict(key="input_waist_mm", label="入射 1/e² 半径", group="SLM 与照明", role="calibration",
         type="number", default=0.41, unit="mm", min=0.05, max=5.0, step=0.01,
         sweepable=True, slider=True, optimizable=True, optimizeRank="caution",
         optimizeNote="实测 60× 物镜为 0.41 mm。它几乎决定「所需复场有多少能被照到」，"
                      "但换扩束镜才能改；以优化为名把它改成 1.2 只会让数字好看、装置没变。",
         sweep=dict(min=0.2, max=1.4, step=0.1),
         help="SLM 面入射高斯光的强度 1/e² 半径。实测值为 0.41 mm；换物镜后必须重测回填。"),
    dict(key="wavelength_nm", label="激光波长", group="SLM 与照明", role="device", type="number",
         default=640.0, unit="nm", min=400, max=1200, step=1, sweepable=True,
         optimizable=False, optimizeNote="激光器决定，改了等于换一台装置。",
         sweep=dict(min=532, max=700, step=2),
         help="实验激光波长，用于载波、反传补偿与相机传播；与 LP 基底的参考波长相互独立。"),
    dict(key="slm_nx", label="SLM 横向像素", group="SLM 与照明", role="device", type="int",
         default=1920, unit="px", min=256, max=4096, step=1, advanced=True, lockable=True,
         help="HDSLM64R 为 1920；改小可用于快速试算，但像素间距随之变化。"),
    dict(key="slm_ny", label="SLM 纵向像素", group="SLM 与照明", role="device", type="int",
         default=1080, unit="px", min=256, max=4096, step=1, advanced=True, lockable=True,
         help="HDSLM64R 为 1080。"),
    dict(key="slm_size_x_mm", label="SLM 有效宽", group="SLM 与照明", role="device", type="number",
         default=12.266667, unit="mm", min=2, max=40, step=0.001, advanced=True, lockable=True,
         help="有效显示区宽度；除以横向像素得到像素间距 dx（约 6.389 µm）。"),
    dict(key="slm_size_y_mm", label="SLM 有效高", group="SLM 与照明", role="device", type="number",
         default=6.9, unit="mm", min=2, max=40, step=0.001, advanced=True, lockable=True,
         help="有效显示区高度。"),

    # ================= 光路几何 =================
    dict(key="near_distance_mm", label="SLM→近场 CMOS", group="光路几何", role="device",
         type="number", default=400.06, unit="mm", min=50, max=1200, step=0.01,
         sweepable=True, optimizable=False, lockable=True,
         optimizeNote="导轨上的实际距离，已用卷尺量过；把它当自由变量等于让优化器改装置。",
         sweep=dict(min=300, max=500, step=10),
         help="拆下 L2 时 SLM 到相机的距离（已量到感光面，不再加法兰距）。"),
    dict(key="far_focal_mm", label="L2 焦距", group="光路几何", role="device", type="number",
         default=200.0, unit="mm", min=20, max=600, step=0.5, sweepable=True, lockable=True,
         sweep=dict(min=150, max=250, step=10), help="远场成像透镜 L2 的焦距。"),
    dict(key="slm_to_lens_mm", label="SLM→L2", group="光路几何", role="device", type="number",
         default=200.03, unit="mm", min=10, max=800, step=0.01, advanced=True, lockable=True,
         help="插入 L2 时 SLM 到透镜主面的距离。"),
    dict(key="far_camera_mm", label="L2→远场 CMOS", group="光路几何", role="device", type="number",
         default=200.03, unit="mm", min=10, max=800, step=0.01, advanced=True, lockable=True,
         help="L2 主面到远场相机的距离；等于焦距时为焦面，偏离即离焦。"),
    dict(key="target_core_diameter_mm", label="目标芯径映射", group="光路几何", role="calibration",
         type="number", default=2.5, unit="mm", min=0.2, max=12, step=0.05,
         sweepable=True, optimizable=True, optimizeRank="caution",
         optimizeNote="它本质是「光纤芯径 → 相机面尺寸」的放大率标定。优化它等于让算法吸收装调误差，"
                      "能把相似系数拉高几个点，但那是把误差藏进标定里；除非你确实要用它标定，否则别勾。",
         sweep=dict(min=1.0, max=4.0, step=0.25),
         help="把设计包光场的基准口径映射到相机平面的物理尺寸，决定光斑大小。"
              "lp_modes 里它就是「纤芯直径 → 相机面」的比例尺。"),
    dict(key="compensate_propagation", label="传播补偿（反传到 SLM）", group="光路几何", role="design",
         type="bool", default=True,
         help="开启时先把目标复场反传到 SLM 面再编码，焦面/近场均更准；关闭则直接在 SLM 面定义目标。"),

    # ================= 载波与级次 =================
    dict(key="carrier_far_x_mm", label="0/+1 间距（远场 x）", group="载波与级次", role="design",
         type="number", default=2.4, unit="mm", min=0.0, max=6.0, step=0.05, sweepable=True,
         optimizable=True, optimizeRank="recommended",
         optimizeNote="真实可调的光学设计量：太近零级会漏进一级窗口，太远会超出相机视场。"
                      "建议区间就取 1.8–3.2 mm，不必扫到 0。",
         sweep=dict(min=1.0, max=4.0, step=0.2),
         help="由载波空间频率决定的一级在远场相对零级的横向间距；近场对应间距 = 该值×(近场距离/焦距)。"),
    dict(key="carrier_far_y_mm", label="0/+1 间距（远场 y）", group="载波与级次", role="design",
         type="number", default=0.0, unit="mm", min=-6.0, max=6.0, step=0.05, sweepable=True,
         optimizable=True, optimizeRank="optional",
         optimizeNote="可用来让一级避开零级残余条纹；但斜向分离会同时改变两个方向的窗口位置，注意视场。",
         sweep=dict(min=-2.0, max=2.0, step=0.5),
         help="纵向间距；非零可让一级避开零级衍射条纹，但需同时检查相机视场。"),

    # ================= 编码 =================
    dict(key="encoding_method", label="编码方式", group="编码", role="design", type="enum",
         default="double_phase_2px", sweepable=True,
         optimizable=True, optimizeRank="recommended",
         optimizeNote="离散量，只会试有限几个值，代价最低、收益直接：直接决定零级强弱与一级效率。"
                      "实测近场相似系数 0.999（2px 双相位）vs 0.85（旧版正弦），差别比任何微调都大。",
         options=[
             dict(value="double_phase_2px", label="2 像素条带双相位（x）— 默认"),
             dict(value="double_phase_2px_y", label="2 像素条带双相位（y）"),
             dict(value="double_phase_1px", label="单像素棋盘双相位"),
             dict(value="double_phase_4px", label="4 像素条带双相位"),
             dict(value="blazed_sinc", label="闪耀 sinc"),
             dict(value="type3_sine", label="正弦型（旧版，仅对照）"),
             dict(value="phase_only", label="纯相位（不编码振幅）"),
             dict(value="iterative_gs", label="迭代编码（GS/IFTA）"),
         ],
         help="双相位族把多余光推离零级：1 像素棋盘推得最远（对角）、2 像素条带次之、4 像素条带最近；"
              "blazed_sinc 一级效率高但零级明显；type3_sine 为历史对照（一级能量只有 10% 量级）；"
              "phase_only 丢掉振幅只留相位，只作下界对照；"
              "iterative_gs 用 GS/IFTA 在 SLM 面（纯相位）与一级窗口（目标振幅）之间反复投影。"),

    dict(key="encoding_iterations", label="迭代编码次数", group="编码", role="design", type="int",
         default=8, unit="次", min=0, max=60, step=1, advanced=True,
         optimizable=False,
         dependsOn=dict(key="encoding_method", values=["iterative_gs"]),
         optimizeNote="它只对「迭代编码（GS/IFTA）」生效，且与耗时成正比；作为对照量固定即可。",
         help="仅 encoding_method=iterative_gs 时生效。每次迭代 = 1 次前传 + 1 次反传（补零网格上的 2 次 FFT）。"
              "0 表示退化为纯相位初值。"),
    dict(key="encoding_iterative_plane", label="迭代约束平面", group="编码", role="design", type="enum",
         default="both", advanced=True,
         optimizable=False,
         dependsOn=dict(key="encoding_method", values=["iterative_gs"]),
         optimizeNote="near 只把近场一级压准（远场会明显变差），far 反之，both 两个平面交替约束。",
         options=[
             dict(value="both", label="近场 + 远场交替"),
             dict(value="near", label="只约束近场一级"),
             dict(value="far", label="只约束远场一级"),
         ],
         help="仅 iterative_gs 生效。IFTA 只优化你约束的那个平面：约束近场，远场焦斑会变形；反之亦然。"),
    dict(key="zero_order_radius_mm", label="零级补光半径", group="编码", role="design", type="number",
         default=0.0, unit="mm", min=0.0, max=2.0, step=0.02, sweepable=True, slider=True,
         optimizable=False,
         optimizeNote="它按定义就是「牺牲一级换零级」，以一级相似系数为目标必然把它压到 0；"
                      "要调零级请直接拖滑块或做参数扫描。",
         help="把 SLM 中心这个半径内的相位压成平场（与原有零级同相），这部分光不再参与一级编码、"
              "直接留在零级：半径越大零级越亮、一级越弱。0 = 关闭。"
              "实验上要「零级也亮」时才开；平时开它等于主动扣掉一级。"),
    dict(key="amplitude_floor", label="入射振幅下限", group="编码", role="numeric", type="number",
         default=0.08, unit="", min=0.0, max=0.9, step=0.01, advanced=True,
         optimizable=True, optimizeRank="optional",
         optimizeNote="只改弱照明区的权重，收益通常很小；但成本也低，弱照明占比高时可以带上。",
         help="补偿入射振幅时避免除以近零值；数值越大越保守（弱照明区被压平）。"),

    # ================= 评价窗口 =================
    dict(key="near_zero_half_mm", label="近场零级窗口半宽", group="评价窗口", role="measure",
         type="number", default=0.85, unit="mm", min=0.05, max=6, step=0.05,
         help="近场零级 ROI 的半宽，用于统计零级能量与峰值。"),
    dict(key="near_plus_half_mm", label="近场一级窗口半宽", group="评价窗口", role="measure",
         type="number", default=1.65, unit="mm", min=0.05, max=8, step=0.05,
         optimizable=False,
         optimizeNote="这是评价函数的定义域；动窗口就是在改评分标准，优化结果不可比。",
         help="近场一级 ROI 半宽；应能完整包含目标光斑（芯径 2.5 mm 时约需 1.5 mm）。"
              "小于芯径半径时相关系数会被窗口截断人为压低。"),
    dict(key="far_zero_half_mm", label="远场零级窗口半宽", group="评价窗口", role="measure",
         type="number", default=0.30, unit="mm", min=0.02, max=4, step=0.02,
         help="远场零级 ROI 半宽。"),
    dict(key="far_plus_half_mm", label="远场一级窗口半宽", group="评价窗口", role="measure",
         type="number", default=0.30, unit="mm", min=0.02, max=4, step=0.02,
         optimizable=False,
         optimizeNote="同近场：属于评价标准本身，不能参与优化。",
         help="远场一级 ROI 半宽。焦斑 1/e² 半径约 0.02 mm 时，0.3 mm 已足够。"),

    # ================= 计算与输出 =================
    dict(key="pad_factor", label="传播补零倍数", group="计算与输出", role="numeric", type="int",
         default=2, unit="×", min=1, max=4, step=1, advanced=True, sweepable=True,
         optimizable=False, optimizeNote="纯数值精度（抑制周期边界），不是物理量；改了只会制造虚假提升。",
         sweep=dict(values=[1, 2, 3]),
         help="角谱传播的补零倍数；越大越能容纳衍射扩散，内存与耗时按平方增长。"),
    dict(key="far_fft_size", label="远场 FFT 尺寸", group="计算与输出", role="numeric", type="int",
         default=4096, unit="px", min=1024, max=8192, step=1024, advanced=True, sweepable=True,
         optimizable=False, optimizeNote="同上：只影响采样密度与耗时，不是可优化的物理自由度。",
         sweep=dict(values=[2048, 4096, 8192]),
         help="远场 Collins 传播的 FFT 点数，决定远场采样间隔与可显示视场。"),
    dict(key="precision", label="计算精度", group="计算与输出", role="numeric", type="enum",
         default="double", advanced=True,
         options=[dict(value="double", label="双精度"), dict(value="single", label="单精度（快、省内存）")],
         help="单精度约省一半内存、快约 40%，长距离弱光细节可能略差。"),
    dict(key="design_extent_mm", label="设计包建议口径", group="计算与输出", role="numeric",
         type="number", default=26.0, unit="mm", min=2, max=60, step=0.5, advanced=True,
         help="传给设计包的 ctx.extent_m 建议值。多数设计包（如 lp_modes、basic_shapes）会自己返回更合适的口径，"
              "此值对它们不生效；只有自己没声明 extent 的包才用它。"),
    dict(key="save_bmp", label="保存 8 位相位 BMP", group="计算与输出", role="output", type="bool",
         default=True, help="生成可直接加载到 SLM 的 1920×1080 8 位灰度相位图。"),

    # ================= 显示与标注 =================
    dict(key="display_gamma", label="显示 gamma", group="显示与标注", role="display", type="number",
         default=0.7, unit="", min=0.2, max=2.0, step=0.05, advanced=True,
         help="仅影响网页显示亮度，不改变任何计算与指标。"),
    dict(key="colormap", label="配色", group="显示与标注", role="display", type="enum",
         default="gray", advanced=True,
         options=[dict(value="gray", label="灰度"), dict(value="jet", label="jet 伪彩")],
         help="仅用于预览显示。"),
    dict(key="pinned_metric_a", label="应填数值 A", group="显示与标注", role="display", type="enum",
         slider=False, default="far.r1e2_mm", options="METRICS",
         help="网页大号数值卡片 A 显示的指标。"),
    dict(key="pinned_metric_b", label="应填数值 B", group="显示与标注", role="display", type="enum",
         default="near.r1e2_mm", options="METRICS",
         help="网页大号数值卡片 B 显示的指标。"),
]

# 可被"应填数值"卡片引用的指标（网页下拉也用它）
METRIC_OPTIONS = [
    dict(value="far.r1e2_mm", label="远场 1/e² 半径（一级）", unit="mm"),
    dict(value="near.r1e2_mm", label="近场 1/e² 半径（一级）", unit="mm"),
    dict(value="far.r_ee865_mm", label="远场 86.5% 包络能量半径", unit="mm"),
    dict(value="near.r_ee865_mm", label="近场 86.5% 包络能量半径", unit="mm"),
    dict(value="far.r_ee50_mm", label="远场 50% 包络能量半径", unit="mm"),
    dict(value="near.r_ee50_mm", label="近场 50% 包络能量半径", unit="mm"),
    dict(value="far.r1e2_x_mm", label="远场 1/e² 半径 X", unit="mm"),
    dict(value="far.r1e2_y_mm", label="远场 1/e² 半径 Y", unit="mm"),
    dict(value="near.r1e2_x_mm", label="近场 1/e² 半径 X", unit="mm"),
    dict(value="near.r1e2_y_mm", label="近场 1/e² 半径 Y", unit="mm"),
    dict(value="far.offset_mm", label="远场质心偏移（合）", unit="mm"),
    dict(value="near.offset_mm", label="近场质心偏移（合）", unit="mm"),
    dict(value="far.offset_x_mm", label="远场质心偏移 X", unit="mm"),
    dict(value="near.offset_y_mm", label="近场质心偏移 Y", unit="mm"),
    dict(value="far.correlation", label="远场强度相关系数", unit=""),
    dict(value="near.correlation", label="近场强度相关系数", unit=""),
    dict(value="far.normalized_rmse", label="远场归一化 RMSE", unit=""),
    dict(value="near.normalized_rmse", label="近场归一化 RMSE", unit=""),
    dict(value="far.plus_energy_fraction", label="远场一级能量占比", unit=""),
    dict(value="near.plus_energy_fraction", label="近场一级能量占比", unit=""),
    dict(value="far.zero_plus_peak_ratio", label="远场 零级/一级 峰值比", unit=""),
    dict(value="far.d4sigma_x_mm", label="远场 D4σ（X）", unit="mm"),
    dict(value="near.d4sigma_x_mm", label="近场 D4σ（X）", unit="mm"),
]

DEFAULT_SCORE_METRIC = "composite"
SCORE_METRICS = [
    dict(value="composite", label="综合（形态+误差）", direction="max"),
    dict(value="far.correlation", label="远场相关系数", direction="max"),
    dict(value="near.correlation", label="近场相关系数", direction="max"),
    dict(value="far.normalized_rmse", label="远场归一化 RMSE", direction="min"),
    dict(value="near.normalized_rmse", label="近场归一化 RMSE", direction="min"),
    dict(value="far.plus_energy_fraction", label="远场一级能量占比", direction="max"),
    dict(value="near.plus_energy_fraction", label="近场一级能量占比", direction="max"),
    dict(value="far.zero_plus_peak_ratio", label="远场零级/一级峰值比", direction="min"),
    dict(value="far.r1e2_mm", label="远场 1/e² 半径", direction="max"),
]

# ---------------------------------------------------------------------------
# 优化：以「一级 vs 理想一级」的相似系数为目标
# ---------------------------------------------------------------------------
OPTIMIZE_OBJECTIVES = [
    dict(value="both", label="近场 + 远场一级（综合）", direction="max",
         help="两个平面各自算「一级 vs 理想一级」的强度相关系数。选优时按基线归一化，"
              "避免已经饱和的远场（0.98+）压过还有空间的近场。"),
    dict(value="near.correlation", label="只看近场一级相关系数", direction="max",
         help="只优化近场相机面。近场空间结构多，通常还有明显提升空间。"),
    dict(value="far.correlation", label="只看远场一级相关系数", direction="max",
         help="只优化远场焦面。焦斑通常已 0.97+，继续优化的余地很小。"),
    dict(value="energy", label="一级能量占比（近/远平均）", direction="max",
         help="相似系数饱和时的替代目标：直接把光往一级里塞，同时抑制零级与高阶级次。"),
]

# 一级能量占比相对初始值的保底倍数：低于它视作「靠变暗刷分」，评分要扣分
OPTIMIZE_ENERGY_FLOOR_RATIO = 0.6
OPTIMIZE_DEFAULT_MAX_EVALS = 40

# 相似系数高于它就算饱和，继续优化只会挪动小数点后第三位
OPTIMIZE_SATURATION = 0.97

# 明确列出「不适合当自由变量」的参数及原因（前端原样展示，避免误勾）
OPTIMIZE_EXCLUDED_GROUPS = [
    dict(title="评价窗口（近场/远场 一级·零级半宽）",
         reason="它们是评价函数的定义域。放宽窗口必然让相关系数变高，属于改评分标准而不是改结果。"),
    dict(title="数值精度（补零倍数、远场 FFT 尺寸、计算精度）",
         reason="只影响采样密度与边界处理，不是物理自由度；优化器会挑一个「看起来更好」的数值档位，"
                "换台机器就不成立。"),
    dict(title="硬件常量（波长、SLM 像素与有效尺寸、各段距离、L2 焦距）",
         reason="这些是装置本身，改了等于换一套光路。若怀疑标定有误，请单独用参数扫描核对，再固定下来。"),
    dict(title="零级补光半径",
         reason="它按定义是「牺牲一级换零级」的旋钮。以一级相似系数为目标，最优解恒为 0，优化没有意义。"),
    dict(title="设计包参数（模式权重、相对相位等）",
         reason="它们定义「理想一级」本身。目标跟着变量一起变，相似系数会退化成一个自证循环，必然接近 1。"),
]

# ---------------------------------------------------------------------------
# 预设：一键回到「已知自洽」的构型
# ---------------------------------------------------------------------------
PRESETS = [
    dict(id="bench", label="实验基线（推荐）", tone="accent",
         desc="实测 60× 物镜腰斑 0.41 mm、2 像素条带双相位、零级补光关闭。"
              "这是与 MATLAB 记录对齐的构型，也是任何对比的起点。",
         values=dict(input_waist_mm=0.41, encoding_method="double_phase_2px",
                     zero_order_radius_mm=0.0, carrier_far_x_mm=2.4, carrier_far_y_mm=0.0,
                     target_core_diameter_mm=2.5, amplitude_floor=0.08,
                     compensate_propagation=True)),
    dict(id="near_first", label="近场优先（大腰斑试算）",
         desc="把腰斑放大到 1.2 mm，只用于验证编码链路 / 让近场覆盖更满；"
              "这不是实测装置，别拿它的远场数字当实验结果。",
         values=dict(input_waist_mm=1.2, encoding_method="double_phase_2px",
                     zero_order_radius_mm=0.0, target_core_diameter_mm=2.5)),
    dict(id="encode_compare", label="编码方式对比",
         desc="在实验基线上依次换编码方式，用参数扫描比较一级能量与零级抑制；"
              "重点看 2px 双相位 vs 迭代编码 vs 闪耀 sinc。",
         values=dict(input_waist_mm=0.41, zero_order_radius_mm=0.0,
                     target_core_diameter_mm=2.5, carrier_far_x_mm=2.4)),
    dict(id="fast", label="快速试算（低精度）",
         desc="补零 1×、远场 FFT 2048、单精度。形态看个大概，绝对数值不要引用。",
         values=dict(input_waist_mm=0.41, encoding_method="double_phase_2px",
                     zero_order_radius_mm=0.0, pad_factor=1, far_fft_size=2048,
                     precision="single")),
]

PRESET_BY_ID = {p["id"]: p for p in PRESETS}


def optimizable_schema():
    """前端「优化」页要展示的参数清单：既能变的（含推荐等级），也含明确排除的与原因。"""
    out = []
    for item in SCHEMA:
        if "optimizable" not in item:
            continue
        out.append(dict(
            key=item["key"], label=item["label"], group=item["group"], type=item["type"],
            role=item.get("role", "design"),
            unit=item.get("unit", ""), min=item.get("min"), max=item.get("max"),
            step=item.get("step"), options=copy.deepcopy(item.get("options") or []),
            default=item["default"], optimizable=bool(item["optimizable"]),
            rank=item.get("optimizeRank") or "optional",
            note=item.get("optimizeNote") or "",
        ))
    return out


_BY_KEY = {item["key"]: item for item in SCHEMA}

# options="METRICS" 的两项在 METRIC_OPTIONS 定义后展开（避免前向引用）
for _item in SCHEMA:
    if _item.get("options") == "METRICS":
        _item["options"] = [dict(o) for o in METRIC_OPTIONS]
        _item["optionsSource"] = "metrics"


def schema():
    """返回给前端的完整 schema（深拷贝，附带 value 默认值占位）。"""
    return copy.deepcopy(SCHEMA)


def defaults():
    return {item["key"]: item["default"] for item in SCHEMA}


def _clamp_number(key, value, spec):
    warnings = []
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{spec['label']}（{key}）需要数字，收到 {value!r}")
    if not math.isfinite(value):
        raise ValueError(f"{spec['label']}（{key}）不能是 NaN/Inf")
    lo, hi = spec.get("min"), spec.get("max")
    if lo is not None and value < lo:
        value = lo
        warnings.append(f"{spec['label']} 低于下限，已设为 {lo}")
    if hi is not None and value > hi:
        value = hi
        warnings.append(f"{spec['label']} 高于上限，已设为 {hi}")
    if spec["type"] == "int":
        value = int(round(value))
    return value, warnings


def coerce(settings, extra_schema=None):
    """把任意 dict 归一到合法取值，返回 (values, warnings)。未提供的键用默认值。"""
    spec_list = list(SCHEMA) + list(extra_schema or [])
    values = defaults()
    for item in (extra_schema or []):
        values[item["key"]] = item.get("default")
    warnings = []
    for key, raw in (settings or {}).items():
        spec = _BY_KEY.get(key) or next((s for s in (extra_schema or []) if s["key"] == key), None)
        if spec is None:
            continue
        if spec["type"] in ("number", "int"):
            values[key], warn = _clamp_number(key, raw, spec)
            warnings.extend(warn)
        elif spec["type"] == "bool":
            values[key] = bool(raw)
        elif spec["type"] == "enum":
            allowed = [opt["value"] for opt in spec.get("options") or []]
            if allowed and raw not in allowed:
                warnings.append(f"{spec['label']} 取值 {raw!r} 不在可选项内，已回到默认值")
                values[key] = spec["default"]
            else:
                values[key] = raw
        elif spec["type"] == "text":
            values[key] = str(raw)
        elif spec["type"] == "float_list":
            values[key] = [float(x) for x in (raw if isinstance(raw, (list, tuple))
                                              else str(raw).replace("，", ",").split(",")) ]
        elif spec["type"] == "string_list":
            seq = raw if isinstance(raw, (list, tuple)) else str(raw).replace("，", ",").split(",")
            values[key] = [str(x).strip() for x in seq if str(x).strip()]
        else:
            values[key] = raw
    _cross_validate(values, warnings)
    return values, warnings


def _cross_validate(values, warnings):
    dx = values["slm_size_x_mm"] * 1e-3 / max(values["slm_nx"], 1)
    lam = values["wavelength_nm"] * 1e-9
    f = values["far_focal_mm"] * 1e-3
    fy = values["carrier_far_y_mm"] * 1e-3 / (lam * f) if f > 0 else 0.0
    fx = values["carrier_far_x_mm"] * 1e-3 / (lam * f) if f > 0 else 0.0
    if abs(fx) >= 1 / (2 * dx) or abs(fy) >= 1 / (2 * dx):
        warnings.append("载波频率接近或超过 SLM 的 Nyquist 频率，一级会被截断；请减小 0/+1 间距。")
    if values["far_fft_size"] < values["pad_factor"] * max(values["slm_nx"], values["slm_ny"]) * 0.5:
        warnings.append("远场 FFT 尺寸偏小，远场视场可能装不下窗口；建议不低于 4096。")


# ---------------------------------------------------------------------------
# 配置体检：把「参数自相矛盾」在点运行之前就说清楚
# ---------------------------------------------------------------------------
_HEALTH_PRESET_ACTIONS = {
    "type3_sine": dict(preset="bench", label="换成实验基线（2 像素双相位）"),
    "zero_order": dict(preset="bench", label="关闭零级补光（回实验基线）"),
    "waist": dict(preset="bench", label="回填实测腰斑 0.41 mm"),
    "window": None,
}


def health(values, pack_values=None):
    """静态检查参数组合是否自洽（不跑仿真）。返回 [dict(level,title,detail,action)]。"""
    items = []
    method = values.get("encoding_method")
    zero_r = float(values.get("zero_order_radius_mm") or 0.0)
    waist = float(values.get("input_waist_mm") or 0.0)
    core = float(values.get("target_core_diameter_mm") or 0.0)
    plus_half = float(values.get("near_plus_half_mm") or 0.0)

    if method == "type3_sine":
        items.append(dict(
            level="warn", key="encoding",
            title="编码方式是旧版正弦型",
            detail="type3_sine 只为历史对照保留：实测一级能量占比只有 11% 量级，"
                   "近场相似系数 0.85，而 2 像素双相位是 0.999 / 38%。"
                   "如果你不是刻意做对照，这里就是「优化怎么都调不上去」的主因。",
            action=_HEALTH_PRESET_ACTIONS["type3_sine"]))

    if zero_r > 0:
        items.append(dict(
            level="warn" if zero_r >= 0.15 else "info", key="zero_order",
            title=f"零级补光已开启（半径 {zero_r:g} mm）",
            detail="它是按定义「牺牲一级换零级」的旋钮：把中心这部分光的相位压平、留在零级。"
                   "半径 0.2 mm 时一级能量会掉一大截，零级/一级峰值比反而升到 10 倍以上。"
                   "要干净的 +1 级请设 0；只有在需要零级也亮时再开。",
            action=_HEALTH_PRESET_ACTIONS["zero_order"]))

    if waist > 0 and abs(waist - 0.41) > 0.06:
        items.append(dict(
            level="info", key="waist",
            title=f"入射腰斑 {waist:g} mm ≠ 实测 0.41 mm",
            detail="腰斑几乎决定「所需复场有多少能被照到」，也是远场相似系数的主要限制。"
                   "把它改大能让近场数字变好看，但那只是在验证编码链路，不代表装置真的变了。",
            action=_HEALTH_PRESET_ACTIONS["waist"]))

    if core > 0 and plus_half > 0 and plus_half * 2 < core * 1.15:
        items.append(dict(
            level="warn", key="window",
            title="近场一级窗口装不下目标光斑",
            detail=f"芯径映射 {core:g} mm，一级窗口只有 {plus_half * 2:g} mm 宽。"
                   "窗口切掉光斑后，相关系数会被结构性压低，再怎么优化也上不去。",
            action=dict(setting=dict(key="near_plus_half_mm", value=round(core * 0.75, 2)),
                        label=f"把窗口半宽改为 {round(core * 0.75, 2):g} mm")))

    if (method != "iterative_gs"
            and (int(values.get("encoding_iterations") or 0) != 8
                 or values.get("encoding_iterative_plane", "both") != "both")):
        items.append(dict(
            level="info", key="iterations",
            title="「迭代编码次数 / 约束平面」当前不生效",
            detail=f"这两项只对迭代编码（GS/IFTA）有效，当前编码是 {method}。"
                   "填了也不会改变结果，不必在这上面纠结。",
            action=None))

    if values.get("far_fft_size", 4096) < values.get("pad_factor", 2) * max(
            values.get("slm_nx", 1920), values.get("slm_ny", 1080)):
        items.append(dict(
            level="info", key="fft",
            title="远场 FFT 尺寸偏小",
            detail="远场视场可能装不下一级窗口，指标会被截断。建议 far_fft_size ≥ 4096。",
            action=dict(setting=dict(key="far_fft_size", value=4096), label="改为 4096")))

    if not items:
        items.append(dict(level="ok", key="ok", title="参数组合自洽",
                          detail="没有发现互相矛盾的设置。", action=None))
    return items


# ---------------------------------------------------------------------------
# 配置文件读写
# ---------------------------------------------------------------------------
class Store:
    """params/settings.json 与 params/designs/<pack>.json 的读写。"""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.settings_path = self.root / "params" / "settings.json"
        self.pack_dir = self.root / "params" / "designs"
        self.pack_dir.mkdir(parents=True, exist_ok=True)
        self._cache = None

    def load(self):
        raw = {}
        if self.settings_path.exists():
            try:
                raw = json.loads(self.settings_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise ValueError(f"params/settings.json 不是合法 JSON：{exc}") from exc
        else:
            self.settings_path.parent.mkdir(parents=True, exist_ok=True)
            self.settings_path.write_text(json.dumps(
                dict(settings=defaults(), activePack="lp_modes",
                     scoreMetric=DEFAULT_SCORE_METRIC), ensure_ascii=False, indent=2),
                encoding="utf-8")
        settings, warnings = coerce(raw.get("settings") or {})
        active = raw.get("activePack") or "lp_modes"
        score = raw.get("scoreMetric") or DEFAULT_SCORE_METRIC
        self._cache = dict(settings=settings, activePack=active,
                           scoreMetric=score, warnings=warnings,
                           rawSettings=raw.get("settings") or {})
        return self._cache

    def save(self, settings=None, active_pack=None, score_metric=None):
        state = self._cache or self.load()
        if settings:
            merged = dict(state["settings"])
            merged.update(settings)
            state["settings"], warnings = coerce(merged)
        else:
            warnings = []
        if active_pack:
            state["activePack"] = active_pack
        if score_metric:
            state["scoreMetric"] = score_metric
        payload = dict(settings=state["settings"], activePack=state["activePack"],
                       scoreMetric=state["scoreMetric"])
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        self.settings_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
        self._cache = state
        return state, warnings

    def pack_values_path(self, pack_id):
        return self.pack_dir / f"{pack_id}.json"

    def load_pack_values(self, pack_id, pack_params):
        path = self.pack_values_path(pack_id)
        raw = {}
        if path.exists():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                raw = {}
        values, warnings = coerce(raw, extra_schema=pack_params)
        if not path.exists():
            payload = {k: v for k, v in values.items() if k not in defaults()}
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return values, warnings

    def save_pack_values(self, pack_id, values, pack_params):
        merged = dict(self.load_pack_values(pack_id, pack_params)[0])
        merged.update(values or {})
        values, warnings = coerce(merged, extra_schema=pack_params)
        payload = {k: v for k, v in values.items() if k not in defaults()}
        self.pack_values_path(pack_id).parent.mkdir(parents=True, exist_ok=True)
        self.pack_values_path(pack_id).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return values, warnings
