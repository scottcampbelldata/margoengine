"""Sample the CC0 Smithsonian Apollo 11 interior photogrammetry as tangent Gaussians."""
import argparse
import gzip
import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image

SOURCE_MD5 = "d9683ae7e7aa8849490c3ce7d57cb25d"
SOURCE_URL = "https://zenodo.org/records/10348690"
PLY_PROPERTIES = ("x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
                  "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3")

class Capture:
    """Read only the standard binary accessors and matrix nodes used by this validated source."""

    def __init__(self, source):
        raw = source.read_bytes()
        if hashlib.md5(raw, usedforsecurity=False).hexdigest() != SOURCE_MD5:
            raise ValueError("Use the verified Apollo 11 Command Module Interior file from the linked record.")
        json_size, json_tag = struct.unpack_from("<II", raw, 12)
        if json_tag != 0x4E4F534A:
            raise ValueError("Expected the model's JSON chunk.")
        self.doc = json.loads(raw[20:20 + json_size])
        binary_size, binary_tag = struct.unpack_from("<II", raw, 20 + json_size)
        if binary_tag != 0x004E4942:
            raise ValueError("Expected the model's binary chunk.")
        self.buffer = memoryview(raw)[28 + json_size:28 + json_size + binary_size]
        self.images = {}

    def values(self, index):
        accessor = self.doc["accessors"][index]
        view = self.doc["bufferViews"][accessor["bufferView"]]
        dtype = np.dtype({5126: "<f4", 5123: "<u2", 5125: "<u4"}[accessor["componentType"]])
        channels = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[accessor["type"]]
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        stride = view.get("byteStride", channels * dtype.itemsize)
        return np.ndarray((accessor["count"], channels), dtype=dtype, buffer=self.buffer,
                          offset=offset, strides=(stride, dtype.itemsize))

    def texture(self, material):
        if material not in self.images:
            info = self.doc["materials"][material]["pbrMetallicRoughness"]["baseColorTexture"]
            image = self.doc["images"][self.doc["textures"][info["index"]]["source"]]
            view = self.doc["bufferViews"][image["bufferView"]]
            offset = view.get("byteOffset", 0)
            with Image.open(io.BytesIO(self.buffer[offset:offset + view["byteLength"]])) as texture:
                self.images[material] = np.array(texture.convert("RGB"))
        return self.images[material]

    def primitives(self, index, parent):
        node = self.doc["nodes"][index]
        matrix = parent @ np.array(node.get("matrix", np.eye(4).ravel())).reshape((4, 4), order="F")
        if index == 0:
            # The archive's display normalization is 0.0148034487 per source cm.
            # The Smithsonian's centimetre coordinates convert at 0.01 to metres.
            matrix[:3, :3] *= .01 / np.linalg.norm(matrix[:3, 0])
        if "mesh" in node:
            for primitive in self.doc["meshes"][node["mesh"]]["primitives"]:
                indices = self.values(primitive["indices"]).reshape((-1, 3))
                positions = self.values(primitive["attributes"]["POSITION"])
                uv = self.values(primitive["attributes"]["TEXCOORD_0"])
                positions = positions @ matrix[:3, :3].T + matrix[:3, 3]
                triangles = positions[indices]
                cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
                length = np.linalg.norm(cross, axis=1)
                keep = length > 2e-9
                material = primitive["material"]
                yield (triangles[keep], uv[indices][keep], cross[keep] / length[keep, None],
                       length[keep] * .5, material)
        for child in node.get("children", []):
            yield from self.primitives(child, matrix)

    def read(self):
        scene = self.doc["scenes"][self.doc["scene"]]
        return [part for root in scene["nodes"] for part in self.primitives(root, np.eye(4))]


def orient(normals):
    """Shortest rotation taking the Gaussian's thin Z axis to the scanned face normal."""
    n = len(normals)
    quats = np.column_stack((1 + normals[:, 2], -normals[:, 1], normals[:, 0], np.zeros(n)))
    length = np.linalg.norm(quats, axis=1)
    antipodes = length < 1e-7
    quats[antipodes] = [0, 1, 0, 0]
    length[antipodes] = 1
    return quats / length[:, None]


def preview_weight(triangles):
    # The opening favours the complete flight-deck composition. Other parts keep a density floor.
    center = triangles.mean(axis=1)
    eye = np.array([.84, -.15, .43])
    axis = np.array([.84, .25, -.58]) - eye
    axis /= np.linalg.norm(axis)
    right = np.cross(axis, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, axis)
    delta = center - eye
    depth = delta @ axis
    x = np.abs(delta @ right)
    y = np.abs(delta @ up)
    visible = (depth > .31) & (x < depth * .71) & (y < depth * .66)
    return np.where(visible, 6 / np.maximum(.52, depth) ** 1.15, .29)


def sample(capture, faces, count, spread_factor, opening=False):
    rng = np.random.default_rng(11071969)
    # Allocate extra resolution to the fine switches, crew markings and upholstery.
    importance = (.78, .52, 2.95, 1.27)
    view_weights = [preview_weight(triangles) if opening else np.ones_like(area)
                    for triangles, _, _, area, _ in faces]
    areas = [area * factor for (_, _, _, area, _), factor in zip(faces, view_weights)]
    scene_weights = np.array([weighted.sum() * importance[part[-1]] for part, weighted in zip(faces, areas)], dtype="f8")
    expected = count * scene_weights / scene_weights.sum()
    allocations = expected.astype("i4")
    allocations[np.argsort(expected - allocations)[::-1][:count - allocations.sum()]] += 1
    result = []
    for (triangles, texcoords, normal, _, material), area, density, subtotal in zip(faces, areas, view_weights, allocations):
        if subtotal == 0:
            continue
        cumulative = np.cumsum(area)
        # Stratify by triangle area. The UV sample and Gaussian center share barycentric weights.
        draws = (np.arange(subtotal) + rng.random(subtotal)) * cumulative[-1] / subtotal
        face = np.searchsorted(cumulative, draws, side="right")
        first = np.sqrt(rng.random(subtotal))
        second = rng.random(subtotal)
        weights = np.column_stack((1 - first, first * (1 - second), first * second))
        pos = np.einsum("ij,ijk->ik", weights, triangles[face])
        tex = np.einsum("ij,ijk->ik", weights, texcoords[face])
        pixels = capture.texture(material)
        ny, nx = pixels.shape[:2]
        tx = np.clip((tex[:, 0] * nx).astype("i4"), 0, nx - 1)
        ty = np.clip((tex[:, 1] * ny).astype("i4"), 0, ny - 1)
        srgb = pixels[ty, tx]
        spread = spread_factor * np.sqrt(cumulative[-1] / (subtotal * density[face]))
        if opening:
            spread = np.clip(spread, .022, .082)
        # Axes in the tangent plane have the same width. The thin axis follows the real mesh.
        sizes = np.column_stack((spread, spread, np.maximum(.0014, .11 * spread)))
        result.append((pos, sizes, orient(normal[face]), srgb))
    return tuple(np.concatenate(parts) for parts in zip(*result))


def preview_bytes(data):
    pos, scales, rotation, srgb = data
    dtype = np.dtype([("points", "<f4", 3), ("sigma", "<f4", 3), ("rgba", "u1", 4), ("quaternion", "u1", 4)])
    records = np.zeros(len(pos), dtype=dtype)
    records["points"] = np.round(pos, 3)
    records["sigma"] = np.maximum(.001, np.round(scales, 3))
    records["rgba"][:, :3] = srgb
    records["rgba"][:, 3] = 237
    records["quaternion"] = np.round(np.clip(rotation * 128 + 128, 0, 255)).astype("u1")
    return records.tobytes()


def ply_bytes(data):
    pos, scales, rotation, srgb = data
    sh_dc = (srgb / 255 - .5) / .28209479177387814
    opacity = np.full((len(pos), 1), np.log(.93 / .07))
    records = np.concatenate((np.round(pos, 3), sh_dc, opacity, np.log(scales), rotation), axis=1)
    header = ["ply", "format binary_little_endian 1.0",
              "comment Smithsonian Apollo 11 Columbia interior photogrammetry surface sampling",
              f"element vertex {len(pos)}", *(f"property float {name}" for name in PLY_PROPERTIES), "end_header", ""]
    return "\n".join(header).encode("ascii") + records.astype("<f4").tobytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("glb", type=Path)
    args = parser.parse_args()
    capture = Capture(args.glb)
    faces = capture.read()
    area = sum(part[3].sum() for part in faces)
    output = Path(__file__).resolve().parent.parent / "assets"
    files = []
    for name, count, spread, encode in (("columbia-opening.splat.gz", 5600, .69, preview_bytes),
                                        ("columbia-detail.ply.gz", 158000, .67, ply_bytes)):
        points = sample(capture, faces, count, spread, opening=encode is preview_bytes)
        payload = gzip.compress(encode(points), mtime=0, compresslevel=9)
        (output / name).write_bytes(payload)
        info = {"file": name, "count": count, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
        files.append(info)
        print(info)
    manifest = {"name": "Apollo 11 Command Module Interior", "provider": "Smithsonian Institution",
                "source": SOURCE_URL, "licence": "CC0-1.0", "sourceMD5": SOURCE_MD5,
                "areaMetres2": round(float(area), 5), "method": "Stratified sampling of textured photogrammetry with opening-view importance",
                "files": files}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
