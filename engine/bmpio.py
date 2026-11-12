"""8 位灰度 BMP 写出（SLM 直接加载用），无需 Pillow。"""
from __future__ import annotations

import struct
from pathlib import Path

import numpy as np


def write_bmp8(path, bitmap):
    """bitmap: uint8 二维数组 → 8 位灰度 BMP（自底向上，4 字节行对齐，含 256 级调色板）。"""
    arr = np.asarray(bitmap, dtype=np.uint8)
    if arr.ndim != 2:
        raise ValueError("BMP 需要二维数组")
    height, width = arr.shape
    row_size = (width + 3) & ~3
    padding = row_size - width
    pixel_bytes = bytearray()
    for row in arr[::-1]:  # BMP 自底向上存储
        pixel_bytes += row.tobytes()
        if padding:
            pixel_bytes += b"\x00" * padding

    palette = bytearray()
    for i in range(256):
        palette += bytes((i, i, i, 0))

    data_offset = 14 + 40 + len(palette)
    file_size = data_offset + len(pixel_bytes)
    header = b"BM" + struct.pack("<IHHI", file_size, 0, 0, data_offset)
    info = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 8, 0,
                       len(pixel_bytes), 2835, 2835, 256, 0)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(info)
        fh.write(palette)
        fh.write(pixel_bytes)
    return path
