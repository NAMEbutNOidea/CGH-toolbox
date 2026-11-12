# 提示词：把 MATLAB CGH 脚本迁移成「设计包」

> 用法：整段复制（从「你是光学科研工具的迁移工程师」到最后一个检查项），连同你的 `.m` 文件内容
> 一起粘贴给任意 AI。AI 产出的两个文件放进 `designs/<包名>/`，回网页点「重新扫描」即可加载。
>
> 与「通用版」的区别：这里假定原文是 **MATLAB**，给了逐条语法对照、单位换算、矩阵方向与
> 索引陷阱、以及必须删掉的几类语句。工具箱已经实现了编码/传播/指标，AI 只需要交目标光场。

---

你是光学科研工具的迁移工程师。我有一段 **MATLAB** 写的 CGH（计算全息）设计脚本，
需要把它迁移进一个固定框架。框架已经实现了：**相位编码（双相位/闪耀/正弦）、
近场角谱传播、远场 Collins 传播、载波与一级定位、8 位相位图输出、指标统计、参数扫描**。

**你只负责一件事：给定一组参数，算出相机（近场）平面上的目标复场。**
请严格按契约输出 **两个文件**：`manifest.json` 与 `design.py`。不要输出其他文件，不要解释过程。

## 一、为什么不能直接照搬

原 `.m` 脚本通常把「目标图案 → 载波 → 反传到 SLM → 量化成 8 位 → 存 BMP」一条龙做完。
本框架把这四步全部收进引擎（这样网页才能调参数、换编码、算指标），所以：

- **目标图案**：留下，要迁移；
- **加光栅/载波、反传、除入射高斯、量化、写 BMP、画图**：全部删掉。

照搬的结果是「加了两次载波、目标被搬到错的位置、相位被量化两次」，这是最常见的失败原因。

## 二、硬性规则（违反任何一条都判不合格）

1. 只返回**相机平面的目标复场**（复数数组 + 物理口径），不要返回相位图、不要返回 0–255 灰度。
2. **不要自己加载波、不要自己 FFT/反传、不要自己 ifftshift、不要自己量化**。场在白纸上居中即可，
   搬到一级、反传、编码都由框架做。
3. **单位一律米（m）**。原脚本里凡是 mm / um / nm 的量，在 `design.py` 里乘 1e-3 / 1e-6 / 1e-9。
   波长从 `ctx.wavelength` 拿，不要写死。
4. 只用 `numpy`、`scipy` 和框架自带的 `cgh_sdk`。禁止 `matplotlib`、禁止 `scipy.io.loadmat`、
   禁止读写设计包目录以外的文件、禁止 `input()`/`print()`。
5. `target_field(params, ctx)` 必须是纯函数：同参数同结果。原脚本里的 `rand`/`randn` 要么去掉，
   要么由参数给种子（`np.random.default_rng(seed)`）。
6. 参数非法时抛 `ValueError`，消息用中文说清「哪个参数、该改成什么范围」。

## 三、MATLAB → Python 逐条对照

### 3.1 语法与索引

| MATLAB | Python / numpy |
|---|---|
| `%` 注释 | `#` 注释 |
| `1:N`、`a:b:c` | `np.arange(N)+1`、`np.arange(a, c+1e-12, b)`（注意右端点） |
| `linspace(a,b,N)` | `np.linspace(a,b,N)`（两边都含，行为一致） |
| `A(1:N,1:M)` | `A[0:N, 0:M]` |
| `A(end)` / `A(end-2:end)` | `A[-1]` / `A[-3:]` |
| `A'`（共轭转置） | `A.conj().T`；只转置不共轭是 `A.T` |
| `size(A,1)` / `numel(A)` / `length(x)` | `A.shape[0]` / `A.size` / `len(x)` |
| `zeros(n,m)` / `ones` / `eye` | `np.zeros((n,m))` / `np.ones` / `np.eye` |
| `.*` `./` `.^` | 直接 `*` `/` `**`（numpy 默认按元素） |
| `A*B`（矩阵乘） | `A @ B` 或 `np.matmul` |
| `~=` `&&` `||` | `!=` `and` `or` |
| `if/elseif/end`、`for/end` | 缩进块，没有 `end` |
| `1i`、`exp(1i*k*x)` | `1j`、`np.exp(1j*k*x)` |
| `abs(E).^2` | `np.abs(E)**2` |
| `angle(E)` | `np.angle(E)` |
| `struct('a',1)` / `s.a` | `{"a": 1}` / `s["a"]` |
| `function E = f(x)` 主函数文件 | 模块级 `def f(x):`；入口必须是 `def target_field(params, ctx):` |
| 脚本顶部 `clear all; close all; clc;` | 删掉 |
| `tic/toc`、`disp`、`fprintf` | 删掉 |
| `parfor` | 普通 `for`（数据量小，不必并行） |

### 3.2 网格与方向（最容易出错的地方）

```matlab
[X, Y] = meshgrid(x, y);   % X 随列变、Y 随行变，size = [numel(y), numel(x)]
```
```python
X, Y = np.meshgrid(x, y)   # 完全等价，不需要转置
```

- `meshgrid` 一一对应，**不要**顺手转置；但 `ndgrid` 是反的，遇到 `ndgrid` 用
  `np.meshgrid(x, y, indexing="ij")` 或对结果转置。
- 用框架给的网格最省事：`g = ctx.grid(nx=600)`，`g.x` / `g.y` 已经是 meshgrid（米），
  约定 **第 0 行对应 +y（图像顶部）、第 0 列对应 −x**，与相机图像一致。手工造网格时保持同一约定，
  否则远场会上下左右翻转。
- 原脚本里若用 `imagesc` 看结果且 `axis ij`（默认），矩阵行序＝从上到下，正好与上面一致；
  若脚本里用了 `flipud`/`axis xy` 来「摆正」，迁移时把 `flipud` 删掉，不要带进来。

### 3.3 常用函数

| MATLAB | Python |
|---|---|
| `besselj(n,x)` / `bessely` / `besseli` / `besselk` | `scipy.special.jv(n,x)` / `yv` / `iv` / `kv` |
| `fzero(@f, x0)` | `scipy.optimize.brentq(f, a, b)`（先给一个括住根的区间） |
| `interp2(X,Y,V,xq,yq,'cubic')` | `scipy.interpolate.RegularGridInterpolator` 或 `RectBivariateSpline` |
| `imresize(A,s)` | 迁移时删掉；确实需要重采样用 `scipy.ndimage.zoom` |
| `fft2` / `ifft2` / `fftshift` | 迁移时**全删**（框架负责传播）；不要把它们留在 `design.py` 里 |
| `sinc(x)` | `np.sinc(x/π)`（numpy 定义含 π，MATLAB 不含） |
| `mod` / `floor` / `round` | `np.mod` / `np.floor` / `np.round`（注意 MATLAB round 半数远离零） |
| `sum(A(:))` | `A.sum()` |
| `max(A(:))` | `A.max()` |
| `repmat(a,m,n)` | `np.tile(a,(m,n))` |

### 3.4 数据依赖

- `load('coeff.mat')` / `xlsread` / `readmatrix`：**不允许**。把数值直接写进 `design.py`
  的常量，或改成 `manifest.json` 里的 `float_list` 参数（网页上可编辑、可扫描）。
- 原脚本里靠 `imread('logo.png')` 做掩模：把图片复制进设计包目录，用
  `sdk.image_field(Path(__file__).parent / "logo.png", extent_m=...)` 读取。
- 原脚本用 `uigetfile` / `input` 交互：改成参数。

## 四、接口契约

### design.py

```python
import numpy as np
import cgh_sdk as sdk


def target_field(params, ctx):
    """
    params: dict，键名与 manifest.json 里 params[].key 一致，值已按类型转换。
    ctx:    设计上下文（只读）：
              ctx.wavelength            激光波长（米）
              ctx.extent_m              建议口径 (ex, ey)（米）
              ctx.target_core_diameter  目标口径映射尺寸（米）
              ctx.near_center / ctx.far_center  一级中心（米）
              ctx.settings              全部全局参数 dict
              ctx.grid(nx=600, ny=None, extent_m=None)
                    → .x .y（meshgrid，米）、.x1 .y1（一维）、.extent_m
   返回：
        {"field": ndarray(ny, nx) complex, "extent_m": (ex, ey)}
        也可以直接 return field, extent_m（extent_m 是标量时表示正方形）
    """
```

要点：`extent_m` 是 `field` 覆盖的**物理宽高**；场必须**居中在 (0,0)**，
框架会插值到相机网格并整体平移到一级位置。所以别把位移、倾斜写进场里。

### manifest.json

```json
{
  "id": "包目录名（小写字母下划线）",
  "name": "中文短名（≤12 字）",
  "description": "一句话：生成什么光、用来验证什么",
  "version": "0.1.0",
  "targetPlane": "camera",
  "entry": "design.py",
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
      "help": "物理含义、量级、扫描它会怎样"
    }
  ]
}
```

- `type` ∈ `number` / `int` / `bool` / `enum` / `text` / `float_list` / `string_list`；
  `enum` 必须给 `options: [{"value","label"}]`；列表类 default 写 JSON 数组。
- 从原脚本里挑出**真正会想改的量**（波长除外、口径、模式系数、环半径、谐波阶数……），
  最多 12 个；不常改的加 `"advanced": true`。每个都写 `help`。
- 单位在 `manifest` 里用 mm 这类好读的单位没问题，**但进 `design.py` 第一件事是换算成米**
  （`w = params["waist_mm"] * 1e-3`）。

## 五、可用的 cgh_sdk

```
sdk.grid(nx=600, ny=None, extent_m=25e-3)   → x/y meshgrid（米）
sdk.gaussian(x, y, w)                        → exp(-r²/w²)，w 为强度 1/e² 半径
sdk.supergaussian(x, y, w, order=4)
sdk.disk(x, y, radius, soft=0.0)             → 硬边/软化圆孔（soft 单位米）
sdk.ring(x, y, radius, width)                → 高斯环
sdk.rect(x, y, half_x, half_y)
sdk.vortex(x, y, charge=1)                   → exp(i·charge·atan2(y,x))
sdk.tilt(x, y, fx, fy)                       → 线性相位（空间频率 1/m）
sdk.lens(x, y, focal, wavelength)
sdk.normalize(field) / sdk.normalize_energy(field)
sdk.lp_modes(core_radius=5e-6, NA=0.1, wavelength=632.8e-9, zone_size=100e-6,
             n_grid=600, max_l=6, max_m=6)   → {"LP01e": field, ...}
sdk.combo(modes, weights, phases=None, weight_type="amplitude")
sdk.image_field(path, extent_m=None, invert=False, pixel_m=None, blur_m=None)
```

**LP 模式特别注意**：原脚本若自己解贝塞尔方程求 LP 模式（`besselj` 零点 + `besselk` 衰减 +
数值归一化），不要逐行翻译——直接 `sdk.lp_modes(...)` 拿模式，再用 `sdk.combo` 叠加，
这类手写求解器是迁移出错率最高的部分。

## 六、自检清单（输出前逐条确认）

- [ ] 只输出 `manifest.json` 与 `design.py`，`design.py` 里没有 FFT、没有载波、没有量化、没有画图
- [ ] 所有长度单位都乘了 1e-3 / 1e-6 / 1e-9，波长取自 `ctx.wavelength`
- [ ] `meshgrid` 没有被多余转置，场在 (0,0) 居中，没有 `flipud`
- [ ] `target_field` 返回二维复数数组和正的 `extent_m`
- [ ] `manifest.json` 里每个参数都在函数里真正用到，且每个都有 `help`
- [ ] 没有 `TODO`、没有本机绝对路径、没有 `load('*.mat')`
- [ ] 没有 `matplotlib`/`print`/`input`/文件写入

## 七、我的 MATLAB 脚本与意图

【把 `.m` 文件全文粘在这里，并补充：
1. 相机上希望看到什么（形状、大致尺寸、单模还是模式叠加）；
2. 原实验参数：波长、SLM 像素/像元、芯径/NA、传播距离、原来用的光栅周期；
3. 希望网页上能调哪几个量（这几个会做成 manifest 参数 + 可扫描项）。】
