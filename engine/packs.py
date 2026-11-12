"""设计包的发现、校验与执行。

一个设计包 = designs/<id>/ 目录：
  manifest.json  声明名称、说明与可调参数（纯数据，加载时不需要执行代码）
  design.py      必须提供 target_field(params, ctx) -> dict(field=..., extent_m=...)
"""
from __future__ import annotations

import importlib.util
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace

import numpy as np

ENGINE_DIR = Path(__file__).resolve().parent
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

import cgh_sdk  # noqa: E402


REQUIRED_PARAM_FIELDS = ("key", "label", "type")


class DesignContext:
    """传给设计包的上下文：让它知道物理尺度、目标位置和可用工具。"""

    def __init__(self, settings, geometry=None):
        self.settings = dict(settings)
        self.wavelength = settings["wavelength_nm"] * 1e-9
        extent = settings["design_extent_mm"] * 1e-3
        self.extent_m = (extent, extent)
        self.target_core_diameter = settings["target_core_diameter_mm"] * 1e-3
        self.sdk = cgh_sdk
        self.near_center = (0.0, 0.0)
        self.far_center = (0.0, 0.0)
        if geometry is not None:
            self.wavelength = geometry.wavelength
            self.near_center = tuple(geometry.near_center)
            self.far_center = tuple(geometry.far_center)

    def grid(self, nx=600, ny=None, extent_m=None):
        return cgh_sdk.grid(nx, ny, extent_m or self.extent_m)


class DesignPack:
    def __init__(self, directory: Path):
        self.dir = Path(directory)
        self.id = self.dir.name
        self.ok = False
        self.error = ""
        self.name = self.id
        self.description = ""
        self.version = ""
        self.author = ""
        self.target_plane = "camera"
        self.entry = "design.py"
        self.notes = ""
        self.params = []
        self._module = None
        self._mtime = 0.0

    # ---------------- 加载 ----------------
    def load(self):
        manifest_path = self.dir / "manifest.json"
        if not manifest_path.exists():
            self.error = "缺少 manifest.json"
            return self
        try:
            import json
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            self.error = f"manifest.json 解析失败：{exc}"
            return self
        self.id = manifest.get("id") or self.dir.name
        self.name = manifest.get("name") or self.id
        self.description = manifest.get("description") or ""
        self.version = str(manifest.get("version") or "")
        self.author = manifest.get("author") or ""
        self.target_plane = manifest.get("targetPlane") or "camera"
        self.entry = manifest.get("entry") or "design.py"
        self.notes = manifest.get("notes") or ""
        self.params = self._normalize_params(manifest.get("params") or [])
        if not self.params:
            self.error = ""  # 允许无参数包
        self._load_module()
        return self

    def _normalize_params(self, params):
        out = []
        for raw in params:
            if not isinstance(raw, dict):
                continue
            missing = [f for f in REQUIRED_PARAM_FIELDS if f not in raw]
            if missing:
                self.error = f"参数 {raw.get('key', '?')} 缺少字段 {missing}"
                continue
            item = dict(raw)
            item.setdefault("group", "设计参数")
            item.setdefault("unit", "")
            item.setdefault("help", "")
            item.setdefault("min", None)
            item.setdefault("max", None)
            item.setdefault("step", None)
            item.setdefault("sweepable", False)
            item.setdefault("advanced", False)
            item.setdefault("sweep", None)
            item.setdefault("options", None)
            if item["type"] not in ("number", "int", "bool", "enum", "text",
                                    "float_list", "string_list"):
                item["type"] = "text"
            if item["type"] == "enum" and not item.get("options"):
                item["options"] = []
            out.append(item)
        return out

    def _load_module(self):
        entry = self.dir / self.entry
        if not entry.exists():
            self.ok = False
            self.error = f"缺少入口文件 {self.entry}"
            return
        mod_name = f"cgh_design_{self.id}"
        try:
            sys.path.insert(0, str(self.dir))
            if mod_name in sys.modules:
                del sys.modules[mod_name]
            spec = importlib.util.spec_from_file_location(mod_name, entry)
            module = importlib.util.module_from_spec(spec)
            sys.modules[mod_name] = module
            spec.loader.exec_module(module)
            if not hasattr(module, "target_field"):
                raise AttributeError("design.py 里没有 target_field(params, ctx) 函数")
            self._module = module
            self._mtime = entry.stat().st_mtime
            self.ok = True
            self.error = ""
        except Exception:
            self._module = None
            self.ok = False
            self.error = "设计包加载失败：\n" + traceback.format_exc(limit=6)
        finally:
            try:
                sys.path.remove(str(self.dir))
            except ValueError:
                pass

    def reload(self):
        return self.load()

    # ---------------- 执行 ----------------
    def build_field(self, values, settings, geometry=None):
        if not self.ok:
            raise RuntimeError(self.error or "设计包不可用")
        ctx = DesignContext(settings, geometry)
        result = self._module.target_field(dict(values), ctx)
        field, extent = self._unpack(result, ctx)
        field = np.asarray(field)
        if field.ndim != 2:
            raise ValueError(f"target_field 必须返回二维复场，当前维度为 {field.ndim}")
        if field.shape[0] < 4 or field.shape[1] < 4:
            raise ValueError(f"目标复场太小（{field.shape}），至少 4×4")
        field = np.nan_to_num(field.astype(complex), nan=0.0, posinf=0.0, neginf=0.0)
        energy = float(np.sum(np.abs(field) ** 2))
        if energy <= 0:
            raise ValueError("target_field 返回的复场全为 0")
        return field, extent

    def _unpack(self, result, ctx):
        if isinstance(result, dict):
            if "field" not in result:
                raise ValueError("target_field 返回的字典缺少 'field' 键")
            field = result["field"]
            extent = result.get("extent_m") or result.get("extent") or ctx.extent_m
        elif isinstance(result, tuple) and len(result) == 2:
            field, extent = result
        else:
            field, extent = result, ctx.extent_m
        if np.isscalar(extent):
            extent = (float(extent), float(extent))
        extent = (float(extent[0]), float(extent[1]))
        # extent 也可以给具体网格坐标向量 (x1, y1)
        if hasattr(extent[0], "__len__"):
            xs, ys = extent
            extent = (float(xs[-1] - xs[0]), float(ys[-1] - ys[0]))
        if extent[0] <= 0 or extent[1] <= 0:
            raise ValueError(f"extent_m 必须为正，当前 {extent}")
        return field, extent

    # ---------------- 序列化 ----------------
    def info(self):
        return dict(id=self.id, name=self.name, description=self.description,
                    version=self.version, author=self.author,
                    targetPlane=self.target_plane, entry=self.entry,
                    dir=str(self.dir), params=self.params,
                    ok=self.ok, error=self.error, notes=self.notes)


def scan_packs(designs_dir: Path):
    designs_dir = Path(designs_dir)
    designs_dir.mkdir(parents=True, exist_ok=True)
    packs = []
    for child in sorted(designs_dir.iterdir()):
        if not child.is_dir() or child.name.startswith("_") or child.name.startswith("."):
            continue
        packs.append(DesignPack(child).load())
    return packs


def get_pack(designs_dir: Path, pack_id: str):
    for pack in scan_packs(designs_dir):
        if pack.id == pack_id:
            return pack
    raise ValueError(f"找不到设计包 {pack_id}（目录 {designs_dir}）")
