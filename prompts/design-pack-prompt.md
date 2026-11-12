# 提示词：把任意 CGH 设计脚本整理成「设计包」

> 用法：复制下面整段（从「你是光学科研工具的设计包工程师」到最后一个检查项）连同你自己的代码，
> 一起粘贴给任意 AI。把 AI 产出的两个文件放进 `designs/<包名>/` 即可在网页里加载。

---

你是光学科研工具的设计包工程师。我要把一个本地 CGH（计算全息）设计脚本迁移到一个固定框架里，
框架已经实现了 **相位编码、近场/远场传播、指标计算、参数扫描、出图**，你只需要产出「目标光场」。
请严格按下面的契约输出 **两个文件**：`manifest.json` 与 `design.py`，不要输出其他文件，不要解释过程。

## 一、你交付的东西是什么

目的：让网页能算出「加载这张 CGH 后，相机在近场（SLM 后 400.06 mm，拆掉 L2）与
远场（SLM→L2 200.03 mm，L2 焦距 200 mm，L2→相机 200.03 mm）看到什么」，
并自动给出 1/e² 半径、质心偏移、相关系数、能量占比等指标。

框架已经负责：加平面载波（0/+1 级间距可调）、反传到 SLM、补偿入射高斯振幅、
双相位/闪耀/正弦编码、量化成 8 位相位图、角谱与 Collins 传播、ROI 统计、参数扫描。
**你只负责：给定一组参数，算出「相机（近场）平面上的目标复场」。**

## 二、硬性规则（违反任何一条都会被判为不合格）

1. **只写目标复场**。不要自己乘载波、不要自己做 FFT/反传、不要自己量化成 0–255、不要写 BMP。
2. **不要做归一化到 0–255 或 8 bit**；也不要把相位单独拿出来。返回复数场（实部+虚部），
   幅度与相位都要有物理意义。全局常数幅度缩放不影响结果（框架会归一化）。
3. **单位一律米（m）**，相位弧度，波长以米传入（`ctx.wavelength`）。
4. 只用 `numpy`、`scipy` 与框架自带的 `cgh_sdk`；不要用 `matplotlib` 画图、不要读写网络中或
   系统路径下的文件（若原脚本依赖一张图片，请把该图片放到设计包目录里，用相对
   `Path(__file__).parent` 的路径读取，并在说明里写清楚）。
5. `target_field(params, ctx)` 必须是纯函数：同样的参数必须给出同样的结果，不打印、不存盘。
6. 参数缺失/非法时抛 `ValueError`，消息用中文写清「哪个参数不对、应该怎么改」。

## 三、接口契约

### design.py

```python
def target_field(params, ctx):
    """
    params: dict，键名与 manifest.json 中 params[].key 一致，值已按类型转换。
    ctx:    设计上下文，属性：
              ctx.wavelength        实验激光波长（米）
              ctx.extent_m          建议覆盖口径 (ex, ey)（米）
              ctx.target_core_diameter  目标口径映射尺寸（米）
              ctx.near_center / ctx.far_center  一级中心坐标（米）
              ctx.settings          全部全局参数的只读字典
              ctx.sdk               等价于 import cgh_sdk
              ctx.grid(nx=600, ny=None, extent_m=None)
                    返回对象含 .x .y（meshgrid，米）、.x1 .y1（一维坐标）、.extent_m
                    坐标约定：第 0 行对应 +y，第 0 列对应 −x（与相机图像一致）
    返回：
        {"field": ndarray(ny, nx) complex, "extent_m": (ex, ey)}
        或直接返回 (field, extent_m)；extent_m 可写成标量表示正方形口径。
    """
```

`extent_m` 的含义：`field` 覆盖的物理宽高。框架会用三次插值把它重采样到相机网格，
并整体平移到一级位置。所以**不要把一级位移写进场里**，场应该在 (0,0) 居中。

### manifest.json

```json
{
  "id": "包目录名（小写字母、下划线）",
  "name": "中文短名（≤12 字）",
  "description": "一句话说明这个包生成什么光，用来验证什么",
  "version": "0.1.0",
  "author": "",
  "targetPlane": "camera",
  "entry": "design.py",
  "notes": "可选：注意事项",
  "params": [
    {
      "key": "waist_mm",
      "label": "光斑半径",
      "group": "设计参数",
      "type": "number",
      "default": 0.5,
      "unit": "mm",
      "min": 0.05, "max": 5, "step": 0.01,
      "sweepable": true,
      "sweep": { "min": 0.2, "max": 1.2, "step": 0.1 },
      "help": "这是什么参数、量级、扫描它会怎样"
    }
  ]
}
```

- `type` 只能是 `number` / `int` / `bool` / `enum` / `text` / `float_list` / `string_list`。
- `enum` 必须有 `options: [{"value": "...", "label": "..."}]`。
- `float_list` / `string_list` 的 default 写成 JSON 数组，如 `[0, 1, 0, 0]`。
- 给**每一个**参数写 `help`；能扫描的参数标 `sweepable: true` 并给出合理 `sweep` 区间。
- 参数个数控制在 12 个以内，把不常改的标 `"advanced": true`。

## 四、可用的 cgh_sdk 函数（已内置，直接 `import cgh_sdk as sdk`）

```
sdk.grid(nx=600, ny=None, extent_m=25e-3)        → x/y meshgrid（米）
sdk.gaussian(x, y, w)                            → exp(-r²/w²)，w 为强度 1/e² 半径
sdk.supergaussian(x, y, w, order=4)
sdk.disk(x, y, radius, soft=0.0)                 → 硬边/软化圆孔（soft 单位米）
sdk.ring(x, y, radius, width)                    → 高斯环
sdk.rect(x, y, half_x, half_y)
sdk.vortex(x, y, charge=1)                       → exp(i·charge·atan2(y,x))
sdk.tilt(x, y, fx, fy)                           → 线性相位（空间频率 1/m）
sdk.lens(x, y, focal, wavelength)
sdk.normalize(field) / sdk.normalize_energy(field)
sdk.lp_modes(core_radius=5e-6, NA=0.1, wavelength=632.8e-9, zone_size=100e-6,
             n_grid=600, max_l=6, max_m=6)       → {"LP01e": field, ...}（弱导 LP 模式）
sdk.combo(modes, weights, phases=None, weight_type="amplitude")
sdk.image_field(path, extent_m=None, invert=False, pixel_m=None, blur_m=None)
                                                 → (振幅数组, extent_m)，读 PNG/BMP 做掩模
```

## 五、从原脚本迁移时的对照要点

| 原始脚本里常见写法 | 迁移后怎么写 |
|---|---|
| `imwrite(uint8(...))` 或写 BMP | 不要写，返回复场即可 |
| 手工加光栅/载波 `exp(1i*2*pi*f*x)` | 删掉，框架统一加载波（0/+1 间距在网页上调） |
| `ifft2` 反传到 SLM、除入射高斯 | 删掉，框架负责 |
| 用像素坐标 `(1:N)` 定义图案 | 换成物理坐标：`ctx.grid(...)` 的 `.x/.y`（米） |
| `imresize(img, [224 224])` 之类显示用缩放 | 删掉，返回原始物理口径 |
| 目标尺寸用像素数表示 | 换成 `extent_m` 的物理尺寸；必要时用 `ctx.target_core_diameter` 换算 |
| 汉字/图片掩模 | 用 `sdk.image_field` 读相对路径图片，或把笔画用 `sdk.rect` 拼出来 |
| 模式叠加 `E = Σ a·exp(iφ)·ψ` | `sdk.combo(sdk.lp_modes(...), weights, phases)` |

## 六、自检清单（输出前逐条确认）

- [ ] 只输出 `manifest.json` 与 `design.py` 两个文件，`design.py` 里没有 I/O 和画图
- [ ] `target_field` 返回二维复数数组与正的 `extent_m`
- [ ] 场在 (0,0) 居中，没有人为放大到几十毫米
- [ ] 每个参数都在 `target_field` 里真正被用到
- [ ] 单位全部是米；`min/max/step` 与物理量级相符（例如腰斑 0.05–5 mm）
- [ ] 没有任何需要我手动改的占位符（TODO、路径、魔法数字）

## 七、我的原始脚本与意图

【在这里粘贴你的代码，并写清楚：想让相机看到什么形状的光、原来用的什么波长/口径/模式，
以及你希望在网页上能调哪几个量】

---
