# CGH Toolbox · 前端接口契约（唯一权威）

本文件定义 `web/` 与后端之间的全部 HTTP 接口。前端**不得**假设契约之外的字段。
后端固定监听 `http://127.0.0.1:3100`，静态站点由同一进程提供（`web/` 目录即站点根）。
前端为**无构建**的原生 ES Module（`<script type="module">`），不引入任何 npm 依赖。

## 0. 约定

- 所有请求 `Content-Type: application/json; charset=utf-8`（GET 无 body）。
- 所有响应为 JSON；错误统一 `{ "ok": false, "error": "中文错误信息", "detail": "堆栈或细节" }`，HTTP 状态码 4xx/5xx。
- 图像一律用 **base64 编码的 uint16 小端、行优先** 数组传输：
  ```
  { "w":600, "h":400, "data":"<base64>", "x0":-12.5, "x1":12.5, "y0":-8.4, "y1":8.4,
    "vmax":1.0, "unit":"mm" }
  ```
  像素值 → 物理量：`value = u16 / 65535 * vmax`（`vmax` 是该平面强度峰值，用于线性显示）。
  总览图（`near_overview` / `far_overview`）额外带 `vmax_windows`：0/+1 评价窗口内的最大值。
  相机面上零级与残余条纹级次常比一级亮几十倍，按 `vmax` 全局归一化会把一级压成灰雾；
  前端「归一化：窗口内」用 `vmax_windows` 作满量程（`gain = vmax / vmax_windows`），此时更利于辨认各级次。
  显示时前端自行做归一化、gamma、colormap；`x0..x1 / y0..y1` 是图像左右/上下边界的物理坐标（mm），
  **y0 对应第一行像素**（行方向为 y 递减或递增由后端保证为 y0→y1 递增，前端直接线性映射即可）。
- 相位图另用 `{ "w","h","data":"<base64 uint8>", "kind":"phase" }`，值 0..255 对应相位 0..2π。

## 1. `GET /api/health`

```json
{
  "ok": true,
  "version": "0.1.0",
  "python": { "ready": true, "path": "C:\\...\\python.exe", "version": "3.10.20", "note": "" },
  "engine": { "workers": 1, "busy": false },
  "packsDir": "D:\\...\\designs",
  "promptPath": "D:\\...\\prompts\\design-pack-prompt.md"
}
```

## 1.5 `GET /api/env` —— 运行环境自检（前端在每次计算前必须调用）

```json
{
  "ok": true,
  "canRun": true,
  "summary": { "pass": 13, "warn": 0, "fail": 0 },
  "checks": [
    {
      "id": "numpy",
      "label": "numpy / scipy",
      "status": "pass",                       // pass | warn | fail
      "detail": "numpy 2.2.6 · scipy 1.15.3",
      "fix": null                              // 失败/警告时给出解决方法
    },
    {
      "id": "python_bin",
      "label": "Python 可执行文件",
      "status": "fail",
      "detail": "未找到",
      "fix": {
        "title": "让网页找到带 numpy/scipy 的 Python",
        "steps": ["在项目根目录新建 .cgh-python.txt，第一行写解释器绝对路径", "…"],
        "command": "pip install numpy scipy"   // 可一键复制的命令，可为 null
      }
    }
  ],
  "python": { "path": "C:\\...\\python.exe", "ready": true, "version": "3.10.20", "lastError": "" },
  "node": { "version": "22.22.2", "platform": "win32" },
  "port": 3100,
  "paths": { "projectDir": "…", "webDir": "…", "outputDir": "…", "paramsDir": "…",
             "designsDir": "…", "promptPath": "…" }
}
```

检查项固定包含：`node`、`web`、`output_dir`、`params_dir`、`designs_dir`、`prompt`、
`python_bin`、`python_runtime`、`numpy`、`fft`、`memory`、`packs`、`image_io`。
`canRun=false`（存在 `fail`）时前端**必须阻止** `/api/run` 与 `/api/sweep`，并弹出 `fix` 内容。

## 2. `GET /api/state` —— 首屏一次性拉取

```json
{
  "ok": true,
  "settings": { "input_waist_mm": 0.41, "...": "..." },        // 当前取值（扁平 map）
  "settingsSchema": [ ParamDef, ... ],                          // 见 §3
  "derived": {                                                  // 只读派生量，用于顶部摘要
    "dx_um": 6.389, "dy_um": 6.389,
    "near_plus_center_mm": [4.8011, 0.0],
    "far_plus_center_mm": [2.4, 0.0],
    "carrier_freq_per_mm": [1.875, 0.0],
    "near_span_mm": [181.9, 102.3]                              // 计算平面尺寸
  },
  "activePack": "lp_modes",
  "packs": [ PackInfo, ... ],                                   // 见 §4
  "packValues": { "mode_names": ["LP01e"], "...": "..." },       // 当前 activePack 的取值
  "scoreMetric": "far.correlation",
  "scoreMetrics": [ { "value":"far.correlation", "label":"远场相关系数", "direction":"max" } ],
  "metricsOptions": [ { "value":"far.r1e2_mm", "label":"远场 1/e² 半径（一级）", "unit":"mm" } ],
  "optimizeParams": [ { "key":"carrier_far_x_mm", "label":"0/+1 间距（远场 x）", "type":"number",
                        "role":"design", "optimizable":true, "rank":"recommended", "note":"…" } ],  // 见 §9.5
  "optimizeObjectives": [ { "value":"both", "label":"近场 + 远场一级（平均）" } ],
  "optimizeExcluded": [ { "title":"评价窗口（…）", "reason":"…" } ],
  "optimizeMaxEvals": 40,
  "roles": { "design": {"label":"设计旋钮","hint":"日常调这些"}, "...": "..." },   // 角色元数据
  "roleOrder": ["design","calibration","device","measure","numeric","output","display"],
  "health": [ { "level":"warn", "key":"encoding", "title":"编码方式是旧版正弦型",
                "detail":"…", "action": {"preset":"bench","label":"换成实验基线（2 像素双相位）"} } ],  // 见 §9.6
  "presets": [ { "id":"bench", "label":"实验基线（推荐）", "desc":"…",
                 "values": {"input_waist_mm":0.41,"encoding_method":"double_phase_2px"} } ],
  "lastRuns": [ { "runId":"20261111-012530", "label":"LP02e", "pack":"lp_modes", "createdAt":"..." } ],
  "warnings": [ "…" ]
}
```

## 3. `ParamDef` 结构（settingsSchema 与 pack params 共用）

```json
{
  "key": "encoding_method",
  "label": "编码方式",
  "group": "编码",
  "type": "enum",                       // number | int | bool | enum | text | float_list | string_list
  "default": "double_phase_2px",
  "value": "double_phase_2px",
  "unit": "",
  "min": null, "max": null, "step": null,
  "options": [ { "value": "double_phase_2px", "label": "2 像素条带双相位" } ],
  "help": "…",
  "sweepable": true,
  "sweep": { "min": 0.2, "max": 1.2, "step": 0.1, "values": null },
  "advanced": false,                    // true 时前端可折叠
  "role": "design",                     // design | calibration | device | measure | numeric | output | display
  "dependsOn": { "key": "encoding_method", "values": ["iterative_gs"] },  // 可选：不满足时控件灰显
  "optimizable": true, "optimizeRank": "recommended", "optimizeNote": "…"
}
```

分组（`group`）固定为以下之一，前端按此顺序渲染：
`"SLM 与照明"`, `"光路几何"`, `"载波与级次"`, `"编码"`, `"评价窗口"`, `"计算与输出"`, `"显示与标注"`, `"设计参数"`

组内再按 `role` 分小节（顺序见 `roleOrder`），装置常量整组折叠。

## 4. `PackInfo`

```json
{
  "id": "lp_modes",
  "name": "LP 模式叠加",
  "description": "由少量 LP 模式相干叠加出近场目标复场",
  "version": "1.0.0",
  "author": "",
  "targetPlane": "camera",
  "entry": "design.py",
  "dir": "D:\\...\\designs\\lp_modes",
  "params": [ ParamDef, ... ],
  "ok": true,
  "error": "",                          // ok=false 时说明（如语法错误、缺 target_field）
  "notes": "…"
}
```

## 5. `POST /api/settings` —— 保存/校验参数

请求：
```json
{ "settings": { "input_waist_mm": 0.5 }, "packValues": { "mode_weights": [1,0,0] }, "scoreMetric": "far.correlation" }
```
（`settings` / `packValues` 为**增量**，只提交改动项；后端合并后写盘。）

响应：
```json
{ "ok": true, "settings": {...}, "packValues": {...}, "clamped": [ {"key":"pad_factor","from":7,"to":6,"reason":"奇数/越界"} ], "warnings": [] }
```

## 6. `POST /api/packs/reload`

重新扫描 `designs/`，响应 `{ "ok": true, "packs": [PackInfo...] }`。

## 7. `POST /api/run` —— 生成 + 仿真（单次）

请求：
```json
{
  "settings": { "...": "覆盖项，可省略" },
  "packValues": { "...": "覆盖项，可省略" },
  "packId": "lp_modes",
  "quality": "full",            // "full" | "fast"（fast = 半分辨率 + 单精度 + 不存 BMP）
  "label": "LP02e 试算",         // 可选，输出目录名后缀
  "saveBmp": true,
  "withImages": true
}
```
响应：`{ "ok": true, "jobId": "j7" }`

> `quality="fast"` 为半分辨率 + 单精度，用于扫描与试算；此时**不会**写 8 位 BMP（半分辨率图不能加载到 SLM），
> 响应里 `artifacts.bmp` 省略。`withImages=false` 时 `images` 为空对象、`profiles` 省略。作业排队执行，
> 同一时刻只跑一个；`/api/sweep` 与 `/api/run` 共用队列。

## 8. `GET /api/job/{jobId}` —— 轮询

```json
{
  "ok": true,
  "jobId": "j7",
  "kind": "run",                // run | sweep | optimize
  "status": "queued|running|done|error|cancelled",
  "progress": 0.35,
  "message": "正向传播（远场）",
  "startedAt": "...", "finishedAt": "...",
  "result": RunResult,          // status=done 且 kind=run
  "sweep": SweepResult,         // status=done 且 kind=sweep
  "optimize": OptimizeResult,   // status=done 且 kind=optimize（见 §9.5）
  "error": { "message": "…", "detail": "…" }
}
```

### 8.1 `RunResult`

```json
{
  "runId": "20261111-012530",
  "label": "LP02e 试算",
  "packId": "lp_modes",
  "packName": "LP 模式叠加",
  "elapsedMs": 3120,
  "quality": "full",
  "settingsUsed": { "...": "..." },
  "packValuesUsed": { "...": "..." },
  "geometry": {
    "wavelength_nm": 640, "dx_um": 6.389, "dy_um": 6.389,
    "near_center_mm": [4.8011, 0.0], "far_center_mm": [2.4, 0.0],
    "near_distance_mm": 400.06, "far_abcd": [0.0, 400.06, -0.005, 0.0]
  },
  "encoding": {
    "method": "double_phase_2px",
    "transmission_scale": 0.83,
    "weak_illumination_energy_fraction": 0.618,
    "camera_window_energy_ratio": 0.99,
    "zero_order_radius_mm": 0.3,
    "zero_order_illumination_fraction": 0.116,
    "iterations": 8,                          // 仅 iterative_gs
    "iteration_plane": "both",                // both | near | far
    "iteration_correlation_initial": 0.902,   // 约束面上的振幅相关（过程量，非指标表的相关）
    "iteration_correlation_final": 0.966,
    "iteration_far_correlation_final": 0.969
  },
  "metrics": {
    "near": PlaneMetrics,
    "far": PlaneMetrics
  },
  "pinned": [ { "key":"far.r1e2_mm", "label":"远场 1/e² 半径", "value":0.741, "unit":"mm", "digits":3 }, { ... } ],
  "images": { "near_overview": Img, "near_zero": Img, "near_plus": Img, "near_ideal": Img,
              "far_overview": Img, "far_zero": Img, "far_plus": Img, "far_ideal": Img,
              "phase": PhaseImg },
  "overlays": {
    "near_overview": [ { "kind":"minus", "label":"-1 级", "cx":-4.801, "cy":0.0, "hx":1.65, "hy":1.65 },
                       { "kind":"zero",  "label":"0 级",  "cx":0.0,    "cy":0.0, "hx":0.85, "hy":0.85 },
                       { "kind":"plus",  "label":"+1 级", "cx":4.801,  "cy":0.0, "hx":1.65, "hy":1.65 } ],
    "far_overview":  [ "同上，远场三个窗口" ]
  },
  "diagnosis": {
    "diffraction_limit_mm": 0.624,
    "target_feature_mm": 0.457,
    "structure_ratio": 1.37,
    "weak_illumination_fraction": 0.976,
    "near_correlation": 0.9204,
    "far_correlation": 0.7742,
    "summary": "可分辨尺度 0.62 mm · 目标最小结构 0.46 mm · 弱照明 98%",
    "items": [
      { "level": "warn", "title": "所需复场大部分没被照到", "detail": "…",
        "action": { "kind": "set", "key": "input_waist_mm", "value": 1.2, "label": "用 1.2 mm 试算" } }
    ]
  },
  "profiles": {
    "near_plus": { "x_mm":[...], "y_mm":[...], "i_x":[...], "i_y":[...], "r_mm":[...], "i_r":[...] },
    "far_plus":  { "...": "..." }
  },
  "artifacts": {
    "dir": "D:\\...\\output\\20261111-012530",
    "bmp": "/files/20261111-012530/CGH/manual_00001_CGH.bmp",
    "csv": "/files/20261111-012530/metrics.csv",
    "json": "/files/20261111-012530/result.json"
  },
  "warnings": ["…"]
}
```

### 8.2 `PlaneMetrics`

```json
{
  "r1e2_mm": 0.741, "r1e2_x_mm": 0.735, "r1e2_y_mm": 0.747,
  "d4sigma_x_mm": 0.72, "d4sigma_y_mm": 0.73,
  "centroid_x_mm": 2.4021, "centroid_y_mm": -0.0031,
  "offset_x_mm": 0.0021, "offset_y_mm": -0.0031, "offset_mm": 0.0038,
  "offset_px": [0.33, -0.49],
  "ideal_offset_x_mm": 0.0004, "ideal_offset_y_mm": -0.0002,
  "correlation": 0.9969, "normalized_rmse": 0.0213,
  "plus_energy_fraction": 0.188, "zero_energy_fraction": 0.095,
  "zero_plus_peak_ratio": 0.48,
  "peak": 0.91,
  "valid": true, "note": ""
}
```
远场对象使用同一字段名，但语义为远场窗口；`far.zero_*` 与 `far.plus_*` 也使用同一组字段中的
`zero_energy_fraction` / `plus_energy_fraction` / `zero_plus_peak_ratio`。为使两者都可读，
后端对每个平面返回 `{ "zero": {...}, "plus": {...}, "combined": {...} }` 三块，
其中 `combined` 内放跨窗口的量（能量占比、峰值比）。**最终实现以此为准**：

```json
"metrics": {
  "near": { "zero": PlaneSpot, "plus": PlaneSpot, "combined": CrossMetrics },
  "far":  { "zero": PlaneSpot, "plus": PlaneSpot, "combined": CrossMetrics }
}
```
`PlaneSpot` = 上面除 `*_energy_fraction`、`zero_plus_peak_ratio` 外的全部字段；
`CrossMetrics` = `{ "zero_energy_fraction", "plus_energy_fraction", "zero_plus_peak_ratio",
"roi_overlap", "total_power_relative_to_slm", "plus_center_mm":[x,y] }`。

## 9. `POST /api/sweep` —— 参数扫描 / 自动择优

请求：
```json
{
  "settings": {}, "packValues": {}, "packId": "lp_modes",
  "quality": "fast",
  "axes": [ { "key":"input_waist_mm", "values":[0.35,0.41,0.5,0.8,1.2] },
            { "key":"encoding_method", "values":["double_phase_2px","blazed_sinc"] } ],
  "scoreMetric": "far.correlation",       // 见 §9.2
  "direction": "max",                     // max | min
  "constraints": [ { "key":"far.normalized_rmse", "op":"<=", "value":0.05 } ]
}
```
响应 `{ "ok": true, "jobId": "s3" }`。轮询同一 `/api/job/{jobId}`，`sweep` 字段：

```json
{
  "total": 10, "completed": 10,
  "columns": [ {"key":"input_waist_mm","label":"入射 1/e² 半径","unit":"mm"},
               {"key":"encoding_method","label":"编码方式","unit":""} ],
  "rows": [ { "params": {"input_waist_mm":0.41,"encoding_method":"blazed_sinc"},
              "score": 0.9812, "ok": true, "note": "",
              "metrics": { "far.r1e2_mm":0.741, "far.correlation":0.9969, "near.correlation":0.991 } } ],
  "best": { "params": {...}, "score": 0.9812, "metrics": {...} },
  "scoreMetric": "far.correlation",
  "quality": "fast"
}
```
`rows` 按 score 降序（direction=max）排列；失败的组合 `ok=false` 且 `note` 说明原因。

### 9.2 可选 scoreMetric 键
`far.correlation`、`near.correlation`、`far.normalized_rmse`（配 direction=min）、
`far.plus_energy_fraction`、`near.plus_energy_fraction`、`far.zero_plus_peak_ratio`（配 min）、
`far.r1e2_mm`、`composite`（= 0.5·far.corr + 0.3·near.corr + 0.2·(1−far.rmse)）。

## 9.5 `POST /api/optimize` —— 按一级相似系数自动寻优

与 §9 的分工：sweep 穷举你给的取值集合；optimize 只给**区间**，由后端决定下一步往哪试。

请求：
```json
{
  "packId": "lp_modes",
  "quality": "fast",
  "objective": "both",                    // both | near.correlation | far.correlation | energy
  "variables": ["encoding_method", "carrier_far_x_mm", "target_core_diameter_mm"],
  "ranges": { "carrier_far_x_mm": {"min": 1.68, "max": 3.12},
              "target_core_diameter_mm": {"min": 2.0, "max": 3.0} },
  "maxEvals": 40,
  "verify": true,                          // 结束后用 full 档复核 base/best（quality=full 时自动关闭）
  "settings": {}, "packValues": {}         // 可选：未保存的草稿覆盖
}
```

约束（服务端强校验）：

- 只有 `GET /api/state` 的 `optimizeParams[].optimizable === true` 的键能进 `variables`；
  传了被排除的键会直接报错并回传排除原因。
- `type=enum` 的变量不需要 `ranges`，会枚举全部取值。
- 达不到几何可行性的组合（如载波超过 Nyquist）会被记为 `ok=false` 并跳过，不会中断整轮。

算法（`engine/optimize.py`）：

1. **memo**：同一组参数只算一次；命中缓存时 `cached` 计数 +1，不消耗预算；
2. **粗扫**：数值变量取 5 个点（当前值 ±25%/±50% 区间，变量多于 3 个时只取 ±35%），
   枚举变量全试一次；每个变量扫完就地接受最优值；
3. **精修**：在当前状态附近逐坐标 ±step 试探，接受即更新（局部爬山，不再跳到全局最优），
   整轮无改进则步长减半，直到区间/512；
4. **收尾**：贴边界提示、饱和检测、可选 full 档复核。

目标函数：`near.correlation` / `far.correlation` 是「该平面一级 ROI 的强度」与
「理想一级 ROI 的强度」的相关系数；`both` 展示为两者平均，`energy` 为近/远一级能量占比平均。

选优用 `merit`（按基线剩余误差归一后的改进，基线=0）：远场常年在 0.98 以上，直接平均会让
近场的实质改进被远场的微小波动稀释；`merit` 让两个平面的改进等价可比。

防退化：若某候选的一级能量占比低于**基线值的 60%**，`merit` 乘以 `sqrt(E/E_floor)` 软惩罚
（避免「把一级调暗换取高相关」）。

响应 `{ "ok": true, "jobId": "o1" }`；轮询 `/api/job/{jobId}`，`kind="optimize"`，结果在 `optimize` 字段：

```json
{
  "objective": "both", "quality": "fast",
  "budget": 40, "evaluated": 33, "cached": 6, "improved": true,
  "delta": 0.0076,                          // 相似系数差（展示用）
  "deltaMerit": 0.42,                       // 归一化改进（选优依据）
  "atBounds": ["carrier_far_x_mm"],         // 最优值贴到区间边界 → 建议放宽区间
  "saturated": ["远场"],                     // 基线相似系数 ≥ 0.97 的平面
  "energyFloor": 0.220,
  "verify": {                               // 仅 quality=fast 且 verify=true
    "base": {"score":0.9195,"near":0.848,"far":0.988,"energy":0.114},
    "best": {"score":0.9264,"near":0.864,"far":0.989,"energy":0.754},
    "delta": 0.0069
  },
  "variables": [ {"key":"carrier_far_x_mm","label":"0/+1 间距（远场 x）","unit":"mm",
                  "role":"design","type":"number","kind":"number","min":1.68,"max":3.12,"options":null} ],
  "base": { "values": {"carrier_far_x_mm":2.4}, "score":0.9179, "merit":0,
            "energy":0.114, "near":0.848, "far":0.988 },
  "best": { "values": {"carrier_far_x_mm":2.278}, "score":0.9258, "merit":0.078,
            "energy":0.754, "near":0.863, "far":0.988 },
  "history": [ { "n":1, "tag":"基线", "score":0.9179, "merit":0, "correlation":0.9179,
                 "near":0.848, "far":0.988, "energy":0.114, "energyOk":true,
                 "nearR1e2":0.58, "farR1e2":0.023, "elapsedMs":3200,
                 "ok":true, "note":"" } ]
}
```

`history[].tag` 是这一步试探了什么（如 `carrier_far_x_mm +0.45`），便于回看搜索轨迹。
`GET /api/state` 另返回 `optimizeParams`（含 `role`、`rank`）、`optimizeObjectives`、
`optimizeExcluded`、`optimizeMaxEvals`、`roles`、`roleOrder`、`health`、`presets`。

## 9.6 `POST /api/healthcheck` —— 草稿参数体检

不需要保存、也不需要跑仿真：把当前草稿里的 `settings` 覆盖进已保存值后做静态检查，
用于面板在编辑时即时更新体检卡。

请求：`{ "settings": {"encoding_method":"double_phase_2px","zero_order_radius_mm":0} }`

响应：
```json
{
  "ok": true,
  "health": [
    {"level":"warn","key":"encoding","title":"编码方式是旧版正弦型",
     "detail":"…","action":{"preset":"bench","label":"换成实验基线（2 像素双相位）"}}
  ],
  "warnings": []
}
```

`health[].level` 为 `ok | info | warn`；`action` 可为 `{preset}`（套用预设）、
`{setting:{key,value}}`（单项修改）或 `null`。

## 10. `POST /api/job/{jobId}/cancel`

`{ "ok": true }`，尽力而为（Python 侧在下一个检查点退出）。

## 11. `GET /api/prompt?kind=matlab`

返回交给 AI 的「脚本整理」提示词原文。`kind` 可选，缺省 `matlab`：

| kind | 文件 | 适用场景 |
|---|---|---|
| `matlab`（默认） | `prompts/matlab-to-pack-prompt.md` | 原脚本是 `.m`：含 MATLAB→numpy 语法对照、单位换算、meshgrid/索引方向陷阱、必须删除的语句 |
| `pack` | `prompts/design-pack-prompt.md` | 通用版：Python、伪代码或只想描述需求 |

```json
{
  "ok": true,
  "kind": "matlab",
  "label": "MATLAB 脚本",
  "markdown": "……",
  "path": "D:\\...\\prompts\\matlab-to-pack-prompt.md",
  "templates": [
    { "id": "matlab", "label": "MATLAB 脚本", "hint": "原脚本是 .m 文件时选这个", "available": true },
    { "id": "pack", "label": "通用 / 其他语言", "hint": "Python、伪代码或只想描述需求时用", "available": true }
  ]
}
```

前端弹窗据此渲染切换按钮，并按 `kind` 缓存已加载的内容；点「复制全文」复制当前这一份。

## 12. `GET /files/{runId}/{相对路径}`

静态返回输出目录下的文件（BMP/CSV/JSON/PNG），带 `Content-Disposition: inline`。

## 13. `GET /api/outputs?limit=20`

```json
{ "ok": true, "items": [ { "runId":"...", "label":"...", "packId":"lp_modes", "createdAt":"...",
  "metricsSummary": { "far.r1e2_mm":0.741 }, "files": ["result.json","metrics.csv"] } ] }
```

## 14. 前端行为约定（验收项）

0. **启动即自检**：`boot()` 拉完 `/api/state` 后调用 `/api/env`，顶栏徽标显示「环境正常 / N 项失败」；
   点徽标或「环境自检」按钮打开自检面板，逐项列出状态、详情与解决方法（`fix.steps` + 可复制的 `fix.command`）。
   `canRun=false` 时「开始计算」「运行扫描」必须先弹出该面板并中止，不允许直接调用 `/api/run`。
1. 首屏：加载 `/api/state`，左侧渲染参数面板（按 group 分组，`advanced` 折叠），顶部显示派生量摘要。
2. 参数改动 → 标记"未保存"，点"保存参数"调 `/api/settings`；`clamped` 非空时 toast 提示被自动修正。
3. "开始计算" → `/api/run` + 每 500 ms 轮询 `/api/job/{id}`，进度条与消息实时更新。
4. 结果区：8 个图像卡片（近场/远场 × 总览/零级/一级/理想）＋相位图；每张可切换 gray/jet、线性/log、
   gamma、归一化（窗口内 / 全图）。总览图按 `overlays` 画出 0 级 / +1 级 / -1 级评价窗口并标注；
   点任意图像打开大图查看器：滚轮以光标为中心缩放、拖拽平移、双击复位、Esc 关闭，窗口框随缩放同步显示。
4b. 诊断卡：读 `diagnosis`，展示 5 个判据（近/远场一级与理想的相关、可分辨尺度、目标最小结构、
    弱照明占比）与逐条解释；`items[].action.kind === "set"` 时给出「把某参数改成某值」的按钮，
    点击只改草稿（未保存），不直接触发计算。
5. "应填的两个数值"面板：两个大号数值卡片，默认 `far.r1e2_mm` 与 `near.r1e2_mm`，
   可通过下拉切换成任意指标（`pinned` 由后端给出默认，切换仅前端展示 + 保存在 localStorage）。
6. 指标表格：近场/远场 两行 × 全部指标列，支持一键复制 CSV。
7. 扫描页：勾选可扫描参数 → 每个参数给 min/max/step 或自定义值列表 → 选择评分指标 → 运行；
   结果表格可排序、可"应用最佳"（回填参数到面板并标记未保存）。
8. 设计包：下拉切换包；显示包目录与状态；"重新扫描"按钮；语法错误时显示错误文本。
9. 提示词：右上角"整理脚本提示词"按钮 → 弹窗顶部两个切换项（MATLAB 脚本 / 通用），
   展示 `/api/prompt?kind=...` 的 markdown 渲染结果 + 一键复制当前模板
   （`navigator.clipboard.writeText`，失败时降级为 textarea 选中）。
10. 主题：浅色（背景 #f7f8fa，卡片纯白，圆角 10px，边框 #e5e7eb，主色 #2563eb）。
    等宽字体用于数值/路径；面板宽度 360px，小屏（<1100px）自动折叠为抽屉。
