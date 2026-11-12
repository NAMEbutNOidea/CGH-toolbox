"""调试用：跑一次并把近/远场、相位图存成 PNG（不依赖网页）。"""
import os

os.environ.setdefault("MKL_THREADING_LAYER", "SEQUENTIAL")

import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

import optics  # noqa: E402
import packs  # noqa: E402
import pipeline  # noqa: E402
import settings as settings_mod  # noqa: E402
from optics import geometry_from_settings, map_field  # noqa: E402


def main():
    quality = sys.argv[1] if len(sys.argv) > 1 else "full"
    pack_id = sys.argv[2] if len(sys.argv) > 2 else "lp_modes"
    store = settings_mod.Store(ROOT)
    state = store.load()
    pack = next(p for p in packs.scan_packs(ROOT / "designs") if p.id == pack_id)
    values, _ = store.load_pack_values(pack_id, pack.params)
    result = pipeline.run(state["settings"], values, pack, quality=quality,
                          with_images=True, save_bmp=False, out_dir=None)
    print("geometry:", result["geometry"])
    for plane in ("near", "far"):
        print(f"--- {plane} ---")
        for block in ("zero", "plus", "combined"):
            print(" ", block, {k: (round(v, 5) if isinstance(v, float) else v)
                               for k, v in result["metrics"][plane][block].items()})
    print("encoding:", result["encoding"])
    print("warnings:", result["warnings"])

    g = geometry_from_settings(state["settings"], quality)
    field, extent = pack.build_field(values, state["settings"], g)
    phase = np.frombuffer(__import__("base64").b64decode(result["images"]["phase"]["data"]),
                          dtype=np.uint8).reshape(result["images"]["phase"]["h"],
                                                  result["images"]["phase"]["w"])
    out = ROOT / "output" / "_debug"
    out.mkdir(parents=True, exist_ok=True)
    for name in ("near_overview", "near_plus", "near_zero", "far_overview", "far_plus", "far_ideal", "near_ideal"):
        img = result["images"][name]
        arr = np.frombuffer(__import__("base64").b64decode(img["data"]),
                            dtype="<u2").reshape(img["h"], img["w"]).astype(float) / 65535.0
        fig, ax = plt.subplots(figsize=(5, 5 * img["h"] / img["w"]))
        ax.imshow(arr, cmap="gray", extent=[img["x0"], img["x1"], img["y0"], img["y1"]])
        ax.set_title(f"{name}  [{img['x0']:.2f},{img['x1']:.2f}]x[{img['y0']:.2f},{img['y1']:.2f}] mm")
        fig.tight_layout()
        fig.savefig(out / f"{name}.png", dpi=110)
        plt.close(fig)
    fig, ax = plt.subplots(figsize=(9, 5))
    ax.imshow(phase, cmap="gray")
    ax.set_title("CGH phase (uint8)")
    fig.tight_layout()
    fig.savefig(out / "phase.png", dpi=110)
    plt.close(fig)
    print("saved →", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
