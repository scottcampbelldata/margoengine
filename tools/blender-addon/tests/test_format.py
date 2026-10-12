import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zlib

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
    # Keep fixture input fixed: valid zlib output differs between Python builds.
    image = bytes.fromhex("89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d24"
                          "0000001949444154789c6378a621f25fe399c87f06118d67ff9f0119004c20094306b86c73"
                          "0000000049454e44ae426082")
    return document, [[primitive]], [image]


def cad_fixture():
    document, geometry, _ = fixture()
    document["materials"] = [{"doubleSided": True, "pbrMetallicRoughness": {"baseColorFactor": [1, 0.15, 0.1, 1]}}]
    document["textures"] = []
    primitive = geometry[0][0]
    vertices = struct.iter_unpack("<20f", primitive["vertices"])
    primitive["vertices"] = b"".join(struct.pack("<6f", *v[:3], *v[4:7]) for v in vertices)
    primitive["stride"] = 24
    return document, geometry, []


def mixed_fixture():
    document, geometry, images = fixture()
    _, cad, _ = cad_fixture()
    cad[0][0]["material"] = 1
    document["materials"].append({"doubleSided": True})
    document["nodes"][1]["mesh"] = 1
    return document, geometry + cad * 2, images


class FormatTests(unittest.TestCase):
    def test_checked_in_fixture_matches_writer(self):
        expected = Path(__file__).parents[3] / "packages" / "blender" / "tests" / "fixtures" / "triangle-uint16.margo"
        self.assertEqual(expected.read_bytes(), format.encode(*fixture()))

    def test_compact_and_mixed_fixtures_match_writer(self):
        root = Path(__file__).parents[3] / "packages" / "blender" / "tests" / "fixtures"
        for name, make in (("cad-triangle", cad_fixture), ("mixed-triangle", mixed_fixture)):
            data = format.encode(*make())
            self.assertEqual((root / f"{name}.margo").read_bytes(), data)
            manifest_offset, manifest_size = struct.unpack_from("<2I", data, 68)
            manifest = json.loads(data[manifest_offset:manifest_offset + manifest_size])
            flags = []
            for mesh in manifest["meshes"]:
                for primitive in mesh["primitives"]:
                    kind, _, size, flag = struct.unpack_from("<4I", data, 64 + primitive["vertices"] * 16)
                    self.assertEqual(kind, 2)
                    self.assertEqual(size, 72 if flag else 240)
                    self.assertNotIn("stride", primitive)
                    flags.append(flag)
            self.assertEqual(flags, [1] if name == "cad-triangle" else [0, 1, 1])

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
            self.assertEqual(reserved, 1 if kind == 3 else 0)
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

    def test_index_formats_at_uint16_boundary_and_invalid_references(self):
        for maximum in (65535, 65536):
            document, geometry, _ = cad_fixture()
            primitive = geometry[0][0]
            primitive["vertices"] = struct.pack("<6f", 0, 0, 0, 0, 1, 0) * (maximum + 1)
            primitive["indices"] = struct.pack("<3I", 0, 1, maximum)
            data = format.encode(document, geometry)
            kind, offset, size, flags = struct.unpack_from("<4I", data, 96)
            self.assertEqual((kind, size, flags), (3, 6, 1) if maximum == 65535 else (3, 12, 2))
            self.assertEqual(struct.unpack_from("<3H" if flags == 1 else "<3I", data, offset), (0, 1, maximum))
        document, geometry, _ = cad_fixture()
        geometry[0][0]["indices"] = struct.pack("<3I", 0, 1, 3)
        with self.assertRaises(ValueError):
            format.encode(document, geometry)

    def test_invalid_geometry_and_png_dimensions(self):
        with self.assertRaises(ValueError):
            format.encode({"nodes": []}, [[{"vertices": b"short", "indices": b""}]])
        with self.assertRaises(ValueError):
            format.png(4097, 1, b"")
        for stride in (0, 48, 100):
            document, geometry, images = cad_fixture()
            geometry[0][0]["stride"] = stride
            with self.assertRaises(ValueError):
                format.encode(document, geometry, images)
        document, geometry, images = cad_fixture()
        geometry[0][0]["vertices"] = geometry[0][0]["vertices"][:-4]
        with self.assertRaises(ValueError):
            format.encode(document, geometry, images)

    def test_png_pixels_roundtrip(self):
        rgba = bytes((230, 40, 20, 255, 40, 230, 20, 255, 20, 40, 230, 255, 230, 230, 20, 255))
        data = format.png(2, 2, rgba)
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        offset, compressed = 8, b""
        while offset < len(data):
            size = struct.unpack_from(">I", data, offset)[0]
            kind = data[offset + 4:offset + 8]
            payload = data[offset + 8:offset + 8 + size]
            self.assertEqual(struct.unpack_from(">I", data, offset + 8 + size)[0], zlib.crc32(kind + payload))
            if kind == b"IHDR":
                self.assertEqual(struct.unpack(">IIBBBBB", payload), (2, 2, 8, 6, 0, 0, 0))
            if kind == b"IDAT":
                compressed += payload
            offset += size + 12
        self.assertEqual(zlib.decompress(compressed), b"\0" + rgba[:8] + b"\0" + rgba[8:])


if __name__ == "__main__":
    fixtures = {"--fixture": fixture, "--fixture-cad": cad_fixture, "--fixture-mixed": mixed_fixture}
    if len(sys.argv) == 3 and sys.argv[1] in fixtures:
        format.write(sys.argv[2], *fixtures[sys.argv[1]]())
    else:
        unittest.main()
