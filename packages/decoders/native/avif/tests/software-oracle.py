"""Development-only black-box raw reference verification. Requires PyAV, never runtime code.

Run pixels.mjs first, then this script from the repository root with PyAV 19.0.2
available to Python. No decoder implementation is inspected or loaded by Margo.
"""
import hashlib
import json
import pathlib
import av

root = pathlib.Path(__file__).resolve().parents[5]
folder = pathlib.Path(__file__).resolve().parent / "fixtures"
records = json.loads((folder / "pixel-references.json").read_text())
for i, record in enumerate(records):
    source = folder / record["file"]
    assert hashlib.sha256(source.read_bytes()).hexdigest() == record["inputSha256"]
    with av.open(str(source)) as container:
        frame = next(container.decode(video=0))
        unit = 1 if record["depth"] == 8 else 2
        # Decoder row padding is excluded. High bits remain unshifted u16 values.
        data = b"".join(bytes(plane)[y * plane.line_size:y * plane.line_size + plane.width * unit]
                        for plane in frame.planes for y in range(plane.height))
    assert hashlib.sha256(data).hexdigest() == record["decodedSha256"], record["file"]
    actual = root / f"test-results/batch203-avif/pixels/reference{i}.margo.yuv"
    assert actual.read_bytes() == data, record["file"]
    print(record["file"], "exact", record["samples"], "samples")
print("Independent codec:", av.__version__, av.library_versions)
