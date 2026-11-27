# Writes the JPEG 2000 vectors in fixtures/jpeg2000: small pictures made here, encoded by the OpenJPEG library that a
# locally installed Pillow carries, with the pixels a decoder must give beside each one. A reversible (lossless) stream
# must give the source pixels; for an irreversible one the file holds OpenJPEG's own decode. Pillow and OpenJPEG are
# only run, never copied. Run from the repository root: python -I packages/decoders/tests/generate-jpeg2000-openjpeg.py
import io
import json
from pathlib import Path

from PIL import Image, features, __version__

OUT = Path(__file__).resolve().parent / "fixtures" / "jpeg2000"
WIDTH, HEIGHT = 61, 47


def source(mode):
    """Gradients, a hard-edged square and a little noise from a fixed linear congruential generator."""
    state = 12345
    channels = {"L": 1, "LA": 2, "RGB": 3, "RGBA": 4}[mode]
    data = bytearray()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            for c in range(channels):
                state = (state * 1103515245 + 12345) & 0x7FFFFFFF
                value = (x * (3 + c) + y * (5 - c)) & 255
                if 12 <= x < 30 and 9 <= y < 25:
                    value = 255 - 60 * c
                data.append((value + (state >> 27)) & 255)
    return Image.frombytes(mode, (WIDTH, HEIGHT), bytes(data))


CASES = [
    ("grey", "L", ".j2k", {}),
    ("grey-alpha", "LA", ".jp2", {}),
    ("rgb", "RGB", ".jp2", {"mct": 1}),
    ("rgb-no-mct", "RGB", ".j2k", {"mct": 0}),
    ("rgba", "RGBA", ".jp2", {"mct": 1}),
    ("tiles", "RGB", ".j2k", {"tile_size": (32, 24), "num_resolutions": 3}),
    ("offsets", "RGB", ".j2k", {"offset": (7, 5), "tile_offset": (3, 2), "tile_size": (40, 32), "num_resolutions": 4}),
    ("blocks", "L", ".j2k", {"codeblock_size": (16, 8)}),
    ("precincts", "RGB", ".j2k", {"precinct_size": (32, 32), "codeblock_size": (16, 16), "progression": "RPCL"}),
    ("rlcp-layers", "RGB", ".jp2", {"progression": "RLCP", "quality_mode": "rates", "quality_layers": [20, 5, 0]}),
    ("pcrl", "RGB", ".j2k", {"progression": "PCRL", "precinct_size": (32, 32), "codeblock_size": (16, 16)}),
    ("cprl", "RGB", ".j2k", {"progression": "CPRL", "tile_size": (48, 40), "num_resolutions": 4}),
    ("plt", "RGB", ".j2k", {"plt": True, "quality_mode": "rates", "quality_layers": [8, 0]}),
    ("one-level", "L", ".j2k", {"num_resolutions": 1}),
    ("lossy-grey", "L", ".j2k", {"irreversible": True, "quality_mode": "rates", "quality_layers": [4]}),
    ("lossy-rgb", "RGB", ".jp2", {"irreversible": True, "mct": 1, "quality_mode": "dB", "quality_layers": [30, 40]}),
]

vectors = []
for name, mode, suffix, options in CASES:
    picture = source(mode)
    held = io.BytesIO()
    picture.save(held, "JPEG2000", no_jp2=suffix == ".j2k", **options)
    data = held.getvalue()
    (OUT / (name + suffix)).write_bytes(data)
    lossy = bool(options.get("irreversible"))
    if lossy:
        expected = Image.open(io.BytesIO(data))
        expected.load()
    else:
        expected = picture
    expected.convert("RGBA").save(OUT / (name + ".png"), optimize=True)
    vectors.append({"file": name + suffix, "pixels": name + ".png", "lossless": not lossy})

(OUT / "vectors.json").write_text(
    json.dumps({"encoder": f"Pillow {__version__}, OpenJPEG {features.version('jpg_2000')}", "vectors": vectors}, indent=2)
    + "\n",
    newline="\n",
)
print(len(vectors), "vectors")
