import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("margo_format", Path(__file__).parents[1] / "writer.py")
format = importlib.util.module_from_spec(spec)
spec.loader.exec_module(format)


def fixture():
    vertices = b"".join(struct.pack("<20f", x, y, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, u, v, 0, 0, 1, 1, 1, 1)
                        for x, y, u, v in ((-0.6, -0.6, 0, 1), (0.6, -0.6, 1, 1), (0, 0.6, 0.5, 0)))
    primitive = {"vertices": vertices, "indices": struct.pack("<3I", 0, 1, 2), "material": 0, "bounds": [-0.6, -0.6, 0, 0.6, 0.6, 0]}
    document = {"nodes": [{"name": "Triangle", "mesh": 0}, {"name": "Mirrored", "mesh": 0, "translation": [2, 0, 0], "scale": [-1, 1, 1]}],
                "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "baseColorTexture": {"index": 0}, "roughnessFactor": 0.6, "metallicFactor": 0}, "doubleSided": True}],
                "textures": [{"source": 0}], "scenes": [{"nodes": [0, 1]}], "scene": 0}
    image = format.png(2, 2, bytes((230, 40, 20, 255, 40, 230, 20, 255, 20, 40, 230, 255, 230, 230, 20, 255)))
    return document, [[primitive]], [image]


class FormatTests(unittest.TestCase):
    def test_checked_in_fixture_matches_writer(self):
        expected = Path(__file__).parents[3] / "packages" / "blender" / "tests" / "fixtures" / "triangle.margo"
        self.assertEqual(expected.read_bytes(), format.encode(*fixture()))

    def test_sections_alignment_and_determinism(self):
        document, geometry, images = fixture()
        original = json.dumps(document)
        data = format.encode(document, geometry, images)
        self.assertEqual(data, format.encode(document, geometry, images))
        self.assertEqual(original, json.dumps(document))
        magic, version, length, count, table, flags, stride = struct.unpack_from("<7I", data)
        self.assertEqual((magic, version, length, count, table, flags, stride), (0x4F47524D, 1, len(data), 4, 64, 0, 80))
        for i in range(count):
            kind, offset, size, reserved = struct.unpack_from("<4I", data, 64 + i * 16)
            self.assertEqual(offset % 4, 0)
            self.assertEqual(reserved, 0)
            self.assertLessEqual(offset + size, len(data))
        document["nodes"][1]["mesh"] = 1
        duplicate = format.encode(document, geometry * 2, images)
        self.assertEqual(struct.unpack_from("<I", duplicate, 12)[0], count, "Identical geometry must share binary sections")

    def test_atomic_write_preserves_previous_asset_on_failure(self):
        document, geometry, images = fixture()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "asset.margo"
            path.write_bytes(b"previous valid asset")
            document["nodes"][0]["translation"] = [float("nan"), 0, 0]
            with self.assertRaises(ValueError):
                format.write(path, document, geometry, images)
            self.assertEqual(path.read_bytes(), b"previous valid asset")
            self.assertEqual(len(list(Path(folder).iterdir())), 1)

    def test_invalid_geometry_and_png_dimensions(self):
        with self.assertRaises(ValueError):
            format.encode({"nodes": []}, [[{"vertices": b"short", "indices": b""}]])
        with self.assertRaises(ValueError):
            format.png(4097, 1, b"")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--fixture":
        format.write(sys.argv[2], *fixture())
    else:
        unittest.main()
