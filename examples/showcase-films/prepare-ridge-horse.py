"""Fit the CC0 Grab3D bay horse surface to Margo's riding-horse skeleton."""

import argparse
import json
from pathlib import Path
import struct

import numpy as np


def read_glb(path):
    raw = path.read_bytes()
    tag, version, file_length, json_length = struct.unpack_from("<4sIII", raw)
    if (tag, version, file_length) != (b"glTF", 2, len(raw)):
        raise ValueError("Expected a GLB v2 file")
    return json.loads(raw[20:20+json_length]), bytearray(raw[28+json_length:])


def points(document, binary, index):
    accessor = document["accessors"][index]
    view = document["bufferViews"][accessor["bufferView"]]
    return np.ndarray((accessor["count"], 3), dtype="<f4", buffer=binary,
                      offset=view.get("byteOffset", 0) + accessor.get("byteOffset", 0),
                      strides=(view.get("byteStride", 12), 4)).copy()


def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def leg_regions(x, y, z):
    front = smooth(z, -.11, .17)
    tail_overlap = (1 - smooth(np.abs(x), .034, .091)) * smooth(y, .15, .44)
    side = smooth(np.abs(x), .018, .076)
    hind = (1 - smooth(z, -.48, -.30)) * smooth(z, -1.22, -1.06) * (1 - tail_overlap) * side
    return front, hind


def deform(p):
    x, y, z = p.T
    body_y = y * 1.047
    front, hind = leg_regions(x, y, z)
    front_src_y = [0, .082, .213, .51, .847, 1.086, 1.43]
    front_dst_y = [0, .074, .245, .511, .935, 1.112, 1.49]
    front_src_z = [.27, .287, .267, .282, .349, .432, .453]
    front_dst_z = [.67, .655, .524, .524, .524, .715, .71]
    hind_src_y = [0, .082, .205, .55, .79, 1.07, 1.45]
    hind_dst_y = [0, .074, .277, .61, .82, 1.08, 1.52]
    hind_src_z = [-.912, -.895, -.929, -.951, -.872, -.759, -.59]
    hind_dst_z = [-.455, -.469, -.594, -.625, -.446, -.53, -.33]
    out = np.stack([x, body_y, z + 0.395], axis=1)
    for region, sy, ty, sz, tz in [
        (front, front_src_y, front_dst_y, front_src_z, front_dst_z),
        (hind, hind_src_y, hind_dst_y, hind_src_z, hind_dst_z),
    ]:
        mask = region > 0
        blend = region[mask] * (1 - smooth(y[mask], .86, 1.44))
        delta = np.asarray(tz) - sz
        out[mask, 1] += blend * (np.interp(y[mask], sy, ty) - body_y[mask])
        out[mask, 2] += blend * (np.interp(y[mask], sy, delta) - .395)
    return out


def influence(source, fitted, nodes):
    sx, sy, sz = source.T
    x, y, z = fitted.T
    lookup = {node["name"]: i for i, node in enumerate(nodes)}
    blend = np.zeros((len(y), 32), dtype=np.float32)
    blend[:, 1] = 1

    def chain(mask, distance, stops, names, amount):
        index = np.searchsorted(stops, distance, side="right") - 1
        index = index.clip(0, len(stops) - 2)
        begin, end = np.asarray(stops)[index], np.asarray(stops)[index + 1]
        weight = smooth(distance, begin, end)
        ids = np.asarray([lookup[name] for name in names])
        rows = np.flatnonzero(mask)
        blend[mask, 1] = 1 - amount
        blend[rows, ids[index]] += (1 - weight) * amount
        blend[rows, ids[index + 1]] += weight * amount

    neck = (sy > 1.23) & (sz > 0.125)
    chain(neck, z[neck], [0.57, 0.89, 1.285, 1.72], ["body", "neck1", "neck2", "head"],
          smooth(z[neck], .55, .84) * smooth(y[neck], 1.25, 1.63))
    tail = (sz < -1.06) & (sy < 1.47)
    chain(tail, y[tail], [0.25, .72, 1.21, 1.52], ["tail3", "tail2", "tail1", "tail1"],
          smooth(-sz[tail], 1.06, 1.22) * (1 - smooth(y[tail], 1.3, 1.52)))
    front, hind = leg_regions(sx, sy, sz)
    for sign, side in [(1, "L"), (-1, "R")]:
        front_knots = [(0.074, 0.026), (.262, .042), (.508, .049), (.918, .073), (1.05, .11)]
        front_bones = [n + side for n in ["foreHoof", "forePastern", "foreCannon", "forearm", "arm", "scapula"]]
        hind_knots = [(0.074, 0.027), (.279, .039), (.607, .058), (.853, .087), (1.082, .11)]
        hind_bones = [n + side for n in ["hindHoof", "hindPastern", "hindCannon", "gaskin", "thigh", "pelvis"]]
        for region, knots, bones in [(front, front_knots, front_bones), (hind, hind_knots, hind_bones)]:
            mask = (sx * sign > 0) & (region > 0) & (sy < 1.46)
            inner = 1 - smooth(sy[mask], .60, 1.03) * (1 - smooth(np.abs(x[mask]), .020, .118))
            amount = region[mask] * (1 - smooth(sy[mask], .86, 1.46)) * inner
            blend[mask] *= 1 - amount[:, None]
            remaining = np.ones_like(amount)
            for (pivot, radius), bone in zip(knots, bones):
                above = smooth(y[mask], pivot - radius, pivot + radius)
                blend[mask, lookup[bone]] += (remaining - above) * amount
                remaining = above
            blend[mask, lookup[bones[-1]]] += remaining * amount
    top = np.argsort(blend, axis=1)[:, -4:][:, ::-1]
    weight = np.take_along_axis(blend, top, axis=1)
    weight /= weight.sum(axis=1, keepdims=True)
    return top.astype("<u2"), weight.astype("<f4")


def fit(surface, rig, destination):
    a, binary = read_glb(surface)
    template, _ = read_glb(rig)
    nodes = template["nodes"][:32]
    for node in nodes:
        if "children" in node:
            node["children"] = [i for i in node["children"] if i < len(nodes)]
    primitive = a["meshes"][0]["primitives"][0]
    source = points(a, binary, primitive["attributes"]["POSITION"])
    normals = points(a, binary, primitive["attributes"]["NORMAL"])
    fitted = deform(source)
    # Inverse-transpose normal map of the same per-height fit.
    eps = 0.0005
    tangent = (deform(source + [0, eps, 0]) - deform(source - [0, eps, 0])) / (2 * eps)
    normals[:, 1] = (normals[:, 1] - tangent[:, 2] * normals[:, 2]) / np.maximum(tangent[:, 1], 0.1)
    normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-5)
    joints, weights = influence(source, fitted, nodes)

    def append(value, dtype, kind, component, target=None, bounds=False):
        array = np.asarray(value, dtype=dtype)
        binary.extend(b"\0" * (-len(binary) % 4))
        view = {"buffer": 0, "byteOffset": len(binary), "byteLength": array.nbytes}
        if target:
            view["target"] = target
        accessor = {"bufferView": len(a["bufferViews"]), "componentType": component, "count": len(array), "type": kind}
        if bounds:
            accessor.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        a["bufferViews"].append(view)
        a["accessors"].append(accessor)
        binary.extend(array.tobytes())
        return len(a["accessors"]) - 1

    matrices = np.repeat(np.eye(4, dtype=np.float32)[None], len(nodes), axis=0)
    world = [np.array(n.get("translation", [0, 0, 0]), dtype=float) for n in nodes]
    for i, node in enumerate(nodes):
        for child in node.get("children", []):
            world[child] += world[i]
        matrices[i, 3, :3] = -world[i]
    primitive["attributes"].update({
        "POSITION": append(fitted, "<f4", "VEC3", 5126, 34962, True),
        "NORMAL": append(normals, "<f4", "VEC3", 5126, 34962),
        "JOINTS_0": append(joints, "<u2", "VEC4", 5123, 34962),
        "WEIGHTS_0": append(weights, "<f4", "VEC4", 5126, 34962),
    })
    a["nodes"] = nodes + [{"mesh": 0, "skin": 0, "name": "Bay coat"}]
    a["scenes"][0]["nodes"] = [0, len(nodes)]
    a["skins"] = [{"joints": list(range(len(nodes))), "skeleton": 0,
                   "inverseBindMatrices": append(matrices, "<f4", "MAT4", 5126)}]
    a["buffers"][0]["byteLength"] = len(binary)
    binary.extend(b"\0" * (-len(binary) % 4))
    encoded = json.dumps(a, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    with destination.open("wb") as file:
        file.write(struct.pack("<4sIII4s", b"glTF", 2, 28 + len(encoded) + len(binary), len(encoded), b"JSON"))
        file.write(encoded)
        file.write(struct.pack("<I4s", len(binary), b"BIN\0"))
        file.write(binary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("surface", type=Path)
    parser.add_argument("rig", type=Path)
    parser.add_argument("output", type=Path)
    opts = parser.parse_args()
    fit(opts.surface, opts.rig, opts.output)
