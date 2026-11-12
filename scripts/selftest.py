"""不经过网页、直接跑一次引擎的自检脚本。

用法：
  python scripts/selftest.py                 # 快速档，lp_modes
  python scripts/selftest.py full lp_modes   # 完整档，指定设计包
"""
import os

os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

import packs          # noqa: E402
import pipeline       # noqa: E402
import settings as settings_mod  # noqa: E402


def main():
    quality = sys.argv[1] if len(sys.argv) > 1 else "fast"
    pack_id = sys.argv[2] if len(sys.argv) > 2 else "lp_modes"
    store = settings_mod.Store(ROOT)
    state = store.load()
    pack = next(p for p in packs.scan_packs(ROOT / "designs") if p.id == pack_id)
    if not pack.ok:
        print("设计包加载失败：\n" + pack.error)
        return 1
    values, warns = store.load_pack_values(pack_id, pack.params)
    print("参数告警：", warns)
    t0 = time.time()
    result = pipeline.run(state["settings"], values, pack, quality=quality,
                          with_images=True, save_bmp=True, out_dir=ROOT / "output",
                          label="selftest")
    print(f"耗时 {time.time() - t0:.1f} s")
    print(json.dumps({k: result["metrics"][k] for k in ("near", "far")},
                     ensure_ascii=False, indent=2, default=float))
    print("告警：", result["warnings"])
    print("产物：", result.get("artifacts"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
