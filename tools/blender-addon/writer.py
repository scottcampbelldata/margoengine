"""Dependency-free .margo v1 writer; see packages/blender/FORMAT.md."""
from array import array
import json
import os
import struct
import sys
import tempfile
import zlib

MAX_BYTES = 256 * 1024 * 1024


def png(width, height, rgba):
    if not 0 < width <= 4096 or not 0 < height <= 4096 or len(rgba) != width * height * 4:
        raise ValueError("Texture must be bounded RGBA8")

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\0" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def encode(document, geometry, images=(), animation=b""):
    """`animation` holds the animated scene's skins, morph targets and keyframes; bufferViews name it as `section: "data"`."""
    sections = [(1, b"", 0)]
    shared = {}

    def add(kind, data, flags=0):
        data = bytes(data)
        key = (kind, flags, data)
        if key not in shared:
            shared[key] = len(sections)
            sections.append((kind, data, flags))
        return shared[key]

    doc = dict(document)
    doc["asset"] = {"version": "2.0", "generator": "margo-blender 1.0.0"}
    fields = doc.pop("meshes", None) or [{}] * len(geometry)
    if len(fields) != len(geometry):
        raise ValueError("Mesh fields must match the geometry")
    doc["meshes"] = []
    for mesh, field in zip(geometry, fields):
        primitives = []
        for primitive in mesh:
            vertex, index = primitive["vertices"], primitive["indices"]
            stride = primitive.get("stride", 80)
            if stride not in (24, 80) or len(vertex) < 3 * stride or len(vertex) % stride or not index or len(index) % 12:
                raise ValueError("Expected packed compact/PBR triangle geometry")
            vertex_count = len(vertex) // stride
            values = array("I")
            values.frombytes(index)
            if sys.byteorder != "little":
                values.byteswap()
            max_index = max(values)
            if vertex_count > 1_000_000 or max_index >= vertex_count:
                raise ValueError("Index exceeds bounded vertex count")
            index_format = 1 if max_index < 65536 else 2
            if index_format == 1:
                values = array("H", values)
                if sys.byteorder != "little":
                    values.byteswap()
                index = values.tobytes()
            record = {k: v for k, v in primitive.items() if k not in ("vertices", "indices", "stride")}
            record.update(vertices=add(2, vertex, int(stride == 24)), indices=add(3, index, index_format))
            primitives.append(record)
        if not primitives:
            raise ValueError("Mesh has no triangles")
        doc["meshes"].append(dict(field, primitives=primitives))
    doc["images"] = [{"section": add(4, image), "mimeType": "image/png"} for image in images]
    if animation:
        data_section = len(sections)
        sections.append((5, bytes(animation), 0))
        views = []
        for view in doc.get("bufferViews", ()):
            if view.get("section") != "data" or view.get("byteOffset", 0) + view["byteLength"] > len(animation):
                raise ValueError("Animation buffer view outside the data section")
            views.append(dict(view, section=data_section))
        doc["bufferViews"] = views
    elif any(key in doc for key in ("bufferViews", "accessors", "skins", "animations")):
        raise ValueError("Animated scene without a data section")
    manifest = json.dumps(doc, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(manifest) > 1024 * 1024 or not 3 <= len(sections) <= 4096:
        raise ValueError(".margo manifest/section budget exceeded")
    sections[0] = (1, manifest, 0)
    offset = 64 + 16 * len(sections)
    table, payload = [], []
    for kind, data, flags in sections:
        table.append(struct.pack("<4I", kind, offset, len(data), flags))
        padded = data + b"\0" * (-len(data) % 4)
        payload.append(padded)
        offset += len(padded)
    if offset > MAX_BYTES:
        raise ValueError(".margo exceeds 256 MiB")
    header = struct.pack("<16I", 0x4F47524D, 1, offset, len(sections), 64, 1 if animation else 0, 80, *([0] * 9))
    return header + b"".join(table) + b"".join(payload)


def write(path, document, geometry, images=(), animation=b""):
    data = encode(document, geometry, images, animation)
    destination = os.path.abspath(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=os.path.dirname(destination), delete=False) as output:
            temporary = output.name
            output.write(data)
        os.replace(temporary, destination)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return len(data)
