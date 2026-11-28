"""Downsample NASA's registered EET 79001,2 XCT PNGs for the showcase."""

import argparse
from pathlib import Path

import numpy as np
from PIL import Image


def prepare(source):
    width, height, count = 131, 185, 176
    volume = np.empty((count, height, width), dtype=np.uint8)
    for z in range(count):
        with Image.open(source / f"{z * 10:04}.png") as image:
            if image.mode != "L" or image.size != (1310, 1854):
                raise ValueError(f"Unexpected NASA XCT slice {z * 10}")
            reduced = image.resize((width, height), Image.Resampling.BOX)
            volume[z] = np.asarray(reduced)[::-1]
    (source / "volume.u8").write_bytes(volume.tobytes())
    with Image.open(source / "sample.jpg") as texture:
        texture.thumbnail((4096, 4096), Image.Resampling.LANCZOS)
        texture.convert("RGB").save(source / "texture.jpg", quality=96, subsampling=0)
    print(f"{width} × {height} × {count} measured attenuation samples")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    prepare(parser.parse_args().source)
