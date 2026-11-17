#!/usr/bin/env python3
"""Draws the extension icons.

Pure standard library (zlib + struct) so it runs anywhere without Pillow, and the
icons are reproducible: re-running produces byte-identical files.

    python3 tools/make-icons.py
"""

from __future__ import annotations

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "icons")
SIZES = (16, 32, 48, 128)

TOP_COLOR = (99, 102, 241)     # indigo-500
BOTTOM_COLOR = (139, 92, 246)  # violet-500

# Three stacked bars, relative to the icon box: (left, top, right, bottom, alpha)
BARS = (
    (0.26, 0.30, 0.74, 0.385, 1.00),
    (0.26, 0.445, 0.74, 0.530, 0.82),
    (0.26, 0.590, 0.74, 0.675, 0.62),
)

SUPERSAMPLE = 4


def inside_round_rect(px: float, py: float, x0: float, y0: float, x1: float, y1: float, radius: float) -> bool:
    cx = (x0 + x1) / 2.0
    cy = (y0 + y1) / 2.0
    half_w = max(0.0, (x1 - x0) / 2.0 - radius)
    half_h = max(0.0, (y1 - y0) / 2.0 - radius)
    dx = max(abs(px - cx) - half_w, 0.0)
    dy = max(abs(py - cy) - half_h, 0.0)
    return math.hypot(dx, dy) <= radius


def mix(a, b, t):
    return (
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    )


def sample(px: float, py: float, size: float) -> tuple[float, float, float, float]:
    radius = size * 0.235
    if not inside_round_rect(px, py, 0.0, 0.0, size, size, radius):
        return (0.0, 0.0, 0.0, 0.0)

    color = mix(TOP_COLOR, BOTTOM_COLOR, py / size)

    for left, top, right, bottom, alpha in BARS:
        x0, y0 = left * size, top * size
        x1, y1 = right * size, bottom * size
        bar_radius = (y1 - y0) / 2.0
        if inside_round_rect(px, py, x0, y0, x1, y1, bar_radius):
            color = mix(color, (255.0, 255.0, 255.0), alpha)
            break

    return (color[0], color[1], color[2], 1.0)


def render(size: int) -> list[bytes]:
    inner = size * SUPERSAMPLE
    samples = SUPERSAMPLE * SUPERSAMPLE
    rows: list[bytes] = []

    for y in range(size):
        row = bytearray()
        for x in range(size):
            red = green = blue = alpha = 0.0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    px = x * SUPERSAMPLE + sx + 0.5
                    py = y * SUPERSAMPLE + sy + 0.5
                    r, g, b, a = sample(px, py, inner)
                    red += r * a
                    green += g * a
                    blue += b * a
                    alpha += a
            if alpha <= 0.0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes(
                    (
                        min(255, int(round(red / alpha))),
                        min(255, int(round(green / alpha))),
                        min(255, int(round(blue / alpha))),
                        min(255, int(round(alpha / samples * 255))),
                    )
                )
        rows.append(bytes(row))
    return rows


def write_png(path: str, size: int) -> None:
    rows = render(size)
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as handle:
        handle.write(png)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size)
        print(f"wrote {os.path.relpath(path, os.path.join(HERE, '..'))}")


if __name__ == "__main__":
    main()
